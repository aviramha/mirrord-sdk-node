/**
 * A minimal SQS server, run as its own process.
 *
 * Speaks enough of the AWS JSON 1.0 protocol for SendMessage, SendMessageBatch,
 * ReceiveMessage and DeleteMessage that a real `SQSClient` talks to it over a
 * real socket — full middleware stack, serializer and SigV4 signing included.
 *
 * `MessageAttributeNames` is honoured exactly as SQS honours it: an attribute is
 * only returned if the receiver asked for it by name (or asked for `All`). That
 * is deliberate. If the library ever stops adding `baggage` to that list, the
 * queue hops in the chain tests go dark rather than quietly passing.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';

const md5 = (text) =>
  createHash('md5')
    .update(text ?? '', 'utf8')
    .digest('hex');

const queues = new Map();
let counter = 0;

const queueOf = (url) => {
  const name = String(url).split('/').pop();
  if (!queues.has(name)) queues.set(name, []);
  return queues.get(name);
};

const enqueue = (url, { MessageBody, MessageAttributes }) => {
  const id = `m-${++counter}`;
  queueOf(url).push({
    MessageId: id,
    ReceiptHandle: `r-${counter}`,
    Body: MessageBody ?? '',
    MD5OfBody: md5(MessageBody ?? ''),
    MessageAttributes: MessageAttributes ?? {},
  });
  return id;
};

function wanted(names) {
  if (!Array.isArray(names) || names.length === 0) return () => false;
  if (names.includes('All') || names.includes('.*')) return () => true;
  return (name) => names.includes(name);
}

function operate(target, input) {
  switch (target) {
    case 'SendMessage':
      return {
        MessageId: enqueue(input.QueueUrl, input),
        MD5OfMessageBody: md5(input.MessageBody),
      };

    case 'SendMessageBatch':
      return {
        Successful: (input.Entries ?? []).map((entry) => ({
          Id: entry.Id,
          MessageId: enqueue(input.QueueUrl, entry),
          MD5OfMessageBody: md5(entry.MessageBody),
        })),
        Failed: [],
      };

    case 'ReceiveMessage': {
      const pending = queueOf(input.QueueUrl);
      const taken = pending.splice(0, input.MaxNumberOfMessages ?? 1);
      if (taken.length === 0) return {};
      const include = wanted(input.MessageAttributeNames);
      return {
        Messages: taken.map((message) => ({
          ...message,
          MessageAttributes: Object.fromEntries(
            Object.entries(message.MessageAttributes).filter(([name]) => include(name)),
          ),
        })),
      };
    }

    case 'DeleteMessage':
    case 'DeleteMessageBatch':
      return {};

    default:
      return null;
  }
}

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const target = String(req.headers['x-amz-target'] ?? '')
      .split('.')
      .pop();
    let output = null;
    try {
      output = operate(target, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
    } catch (error) {
      output = null;
      process.stderr.write(`sqs-server: ${String(error)}\n`);
    }
    res.setHeader('content-type', 'application/x-amz-json-1.0');
    if (output === null) {
      res.statusCode = 400;
      res.end(JSON.stringify({ __type: 'InvalidAction', message: `unsupported: ${target}` }));
      return;
    }
    res.end(JSON.stringify(output));
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`READY ${JSON.stringify({ port: server.address().port })}\n`);
});
