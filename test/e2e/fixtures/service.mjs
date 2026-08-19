/**
 * One service, one process.
 *
 * Loads the SDK, calls `auto_propagate()`, appends its own key to whatever
 * context arrived, and forwards to the next hop. Because each of these runs in
 * its own process there is no shared AsyncLocalStorage anywhere in the chain:
 * the only way a value reaches the next service is over the wire.
 *
 *   node service.mjs '{"key":"svc1","listen":"http","next":{...}}'
 *
 * Prints `READY {"port":N}` once it is accepting work.
 */
import http from 'node:http';

const spec = JSON.parse(process.argv[2]);
const dist = new URL('../../../dist/cjs/index.js', import.meta.url);
const { auto_propagate, set, getAll, wrapMessageHandler } = await import(dist);

auto_propagate();

let sqs = null;
async function sqsClient() {
  if (!sqs) {
    const { SQSClient } = await import('@aws-sdk/client-sqs');
    sqs = new SQSClient({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
      endpoint: spec.sqsEndpoint,
    });
  }
  return sqs;
}

/** Forwards to the next hop, whatever transport it is behind. */
async function forward() {
  if (!spec.next) return;
  if (spec.next.type === 'http') {
    const res = await fetch(spec.next.url);
    await res.arrayBuffer();
    return;
  }
  const { SendMessageCommand } = await import('@aws-sdk/client-sqs');
  const client = await sqsClient();
  await client.send(new SendMessageCommand({ QueueUrl: spec.next.url, MessageBody: spec.key }));
}

if (spec.listen === 'http') {
  const server = http.createServer((req, res) => {
    set(spec.key, '1');
    forward().then(
      () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ context: getAll() }));
      },
      (error) => {
        res.statusCode = 500;
        res.end(String(error?.stack ?? error));
      },
    );
  });
  server.listen(0, '127.0.0.1', () => {
    process.stdout.write(`READY ${JSON.stringify({ port: server.address().port })}\n`);
  });
} else {
  const { ReceiveMessageCommand, DeleteMessageCommand } = await import('@aws-sdk/client-sqs');
  const client = await sqsClient();

  // The handler is wrapped, so the context comes from the message and nothing
  // else — this process never saw the request that started the chain.
  const handle = wrapMessageHandler(async (message) => {
    set(spec.key, '1');
    await forward();
    await client.send(
      new DeleteMessageCommand({ QueueUrl: spec.queue, ReceiptHandle: message.ReceiptHandle }),
    );
  });

  process.stdout.write(`READY ${JSON.stringify({ port: 0 })}\n`);
  for (;;) {
    const out = await client.send(
      new ReceiveMessageCommand({ QueueUrl: spec.queue, MaxNumberOfMessages: 10 }),
    );
    for (const message of out.Messages ?? []) {
      await handle(message).catch((error) => process.stderr.write(`${spec.key}: ${error}\n`));
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}
