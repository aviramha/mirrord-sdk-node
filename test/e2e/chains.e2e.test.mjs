/**
 * End-to-end propagation across mixed transports, one process per service.
 *
 * Every hop is a separate OS process, so there is no AsyncLocalStorage shared
 * between any two of them and no way for a value to arrive except on the wire.
 * The SQS hops go through a real `SQSClient` over a real socket to a queue
 * server in yet another process, so message attributes are genuinely
 * serialized, signed, sent, stored and read back.
 *
 * This test process deliberately never calls `auto_propagate()`. It is a
 * harness: it starts the chains, records what arrives, and reads queues with an
 * uninstrumented client. Nothing it does can put a value into a context.
 */
import { strict as assert } from 'node:assert';
import { spawn } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import test, { after, before } from 'node:test';

// Imported for `parse` only. Importing installs nothing.
const { parse } = await import('../../dist/cjs/index.js');
const { SQSClient, SendMessageCommand, ReceiveMessageCommand } =
  await import('@aws-sdk/client-sqs');

const SERVICE = fileURLToPath(new URL('./fixtures/service.mjs', import.meta.url));
const SQS_SERVER = fileURLToPath(new URL('./fixtures/sqs-server.mjs', import.meta.url));

const children = [];

/** Spawns a fixture and resolves once it prints its READY line. */
function spawnFixture(script, args = []) {
  const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return new Promise((resolve, reject) => {
    // Cleared on both paths: an uncleared timer keeps the test process alive
    // for its full duration after the last assertion.
    const timer = setTimeout(() => reject(new Error(`fixture did not start: ${stderr}`)), 15000);
    const settle = (fn) => (value) => {
      clearTimeout(timer);
      fn(value);
    };
    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      const line = /READY (\{.*\})/.exec(stdout);
      if (line) settle(resolve)({ child, ...JSON.parse(line[1]) });
    });
    child.on('exit', (code) => settle(reject)(new Error(`fixture exited ${code}: ${stderr}`)));
  });
}

const service = (spec) => spawnFixture(SERVICE, [JSON.stringify(spec)]);

let sqsEndpoint;
let sqs;
let recorder;
let recorderUrl;
const recorded = [];

const queueUrl = (name) => `${sqsEndpoint}/000000000000/${name}`;
const keysOf = (header) => [...parse(header ?? '').keys()];

/** Waits for a predicate, so the queue hops are not raced with a fixed sleep. */
async function until(predicate, what, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Reads one message off a queue with a client that has no instrumentation. */
async function drainOne(name) {
  return until(async () => {
    const out = await sqs.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl(name),
        MaxNumberOfMessages: 1,
        MessageAttributeNames: ['All'],
      }),
    );
    return out.Messages?.[0];
  }, `a message on ${name}`);
}

before(async () => {
  const server = await spawnFixture(SQS_SERVER);
  sqsEndpoint = `http://127.0.0.1:${server.port}`;
  sqs = new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
    endpoint: sqsEndpoint,
  });

  recorder = http.createServer((req, res) => {
    recorded.push({ path: req.url, baggage: req.headers.baggage ?? null });
    res.end('ok');
  });
  await new Promise((resolve) => recorder.listen(0, '127.0.0.1', resolve));
  recorderUrl = `http://127.0.0.1:${recorder.address().port}`;
});

after(() => {
  for (const child of children) child.kill('SIGKILL');
  recorder?.close();
});

test('http -> http -> http', async () => {
  recorded.length = 0;
  // Built back to front, because each service needs the address of the next.
  const b = await service({
    key: 'b',
    listen: 'http',
    next: { type: 'http', url: `${recorderUrl}/end` },
  });
  const a = await service({
    key: 'a',
    listen: 'http',
    next: { type: 'http', url: `http://127.0.0.1:${b.port}/` },
  });

  const res = await fetch(`http://127.0.0.1:${a.port}/`, { headers: { baggage: 'origin=client' } });
  assert.equal(res.status, 200);

  const end = await until(() => recorded.find((r) => r.path === '/end'), 'the third hop');
  assert.deepEqual(keysOf(end.baggage), ['origin', 'a', 'b']);
});

test('http -> sqs -> http', async () => {
  recorded.length = 0;
  const queue = queueUrl('http-sqs-http');
  await service({
    key: 'w',
    listen: 'sqs',
    queue,
    sqsEndpoint,
    next: { type: 'http', url: `${recorderUrl}/after-queue` },
  });
  const a = await service({
    key: 'a',
    listen: 'http',
    sqsEndpoint,
    next: { type: 'sqs', url: queue },
  });

  await fetch(`http://127.0.0.1:${a.port}/`, { headers: { baggage: 'origin=client' } });

  const end = await until(
    () => recorded.find((r) => r.path === '/after-queue'),
    'the post-queue hop',
  );
  assert.deepEqual(keysOf(end.baggage), ['origin', 'a', 'w']);
});

test('sqs -> http -> sqs', async () => {
  const inbound = queueUrl('sqs-http-sqs-in');
  const outbound = 'sqs-http-sqs-out';
  const b = await service({
    key: 'b',
    listen: 'http',
    sqsEndpoint,
    next: { type: 'sqs', url: queueUrl(outbound) },
  });
  await service({
    key: 'w1',
    listen: 'sqs',
    queue: inbound,
    sqsEndpoint,
    next: { type: 'http', url: `http://127.0.0.1:${b.port}/` },
  });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: inbound,
      MessageBody: 'payload',
      MessageAttributes: { baggage: { DataType: 'String', StringValue: 'origin=producer' } },
    }),
  );

  const delivered = await drainOne(outbound);
  assert.deepEqual(keysOf(delivered.MessageAttributes?.baggage?.StringValue), [
    'origin',
    'w1',
    'b',
  ]);
});

test('sqs -> sqs -> sqs', async () => {
  const one = queueUrl('chain-1');
  const two = queueUrl('chain-2');
  const three = 'chain-3';
  await service({
    key: 'w1',
    listen: 'sqs',
    queue: one,
    sqsEndpoint,
    next: { type: 'sqs', url: two },
  });
  await service({
    key: 'w2',
    listen: 'sqs',
    queue: two,
    sqsEndpoint,
    next: { type: 'sqs', url: queueUrl(three) },
  });

  await sqs.send(
    new SendMessageCommand({
      QueueUrl: one,
      MessageBody: 'payload',
      MessageAttributes: { baggage: { DataType: 'String', StringValue: 'origin=producer' } },
    }),
  );

  const delivered = await drainOne(three);
  assert.deepEqual(keysOf(delivered.MessageAttributes?.baggage?.StringValue), [
    'origin',
    'w1',
    'w2',
  ]);
});

test('a service that never received baggage sends none', async () => {
  recorded.length = 0;
  const a = await service({
    key: 'a',
    listen: 'http',
    next: { type: 'http', url: `${recorderUrl}/bare` },
  });

  await fetch(`http://127.0.0.1:${a.port}/`);

  const end = await until(() => recorded.find((r) => r.path === '/bare'), 'the bare hop');
  // Only what this service added itself: nothing arrived to inherit.
  assert.deepEqual(keysOf(end.baggage), ['a']);
});
