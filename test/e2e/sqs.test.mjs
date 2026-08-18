import { strict as assert } from 'node:assert';
import { Readable } from 'node:stream';
import test from 'node:test';

const bag = await import('../../dist/cjs/index.js');
bag.auto_propagate();
const { SQSClient, SendMessageCommand, SendMessageBatchCommand, ReceiveMessageCommand } =
  await import('@aws-sdk/client-sqs');

const QUEUE = 'https://sqs.us-east-1.amazonaws.com/000000000000/orders';

/** Captures the fully signed wire request instead of sending it. */
function makeClient(responseBody = {}) {
  const sent = [];
  const client = new SQSClient({
    region: 'us-east-1',
    credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
    // The SDK checksums the response against the request body; a stub handler
    // cannot produce a real MD5. It only ever validates MessageBody, which this
    // package does not touch.
    md5: false,
    requestHandler: {
      handle: async (request) => {
        sent.push(request);
        return {
          response: {
            statusCode: 200,
            reason: 'OK',
            headers: { 'content-type': 'application/x-amz-json-1.0' },
            body: Readable.from([Buffer.from(JSON.stringify(responseBody))]),
          },
        };
      },
    },
  });
  return { client, sent };
}

test('adds baggage to SendMessage as a message attribute', async () => {
  const { client, sent } = makeClient({ MessageId: 'm-1', MD5OfMessageBody: 'd41d8' });

  await bag.runWith({ user: 'alice@metalbear.com', env: 'dev' }, () =>
    client.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: 'hello' })),
  );

  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].body);
  assert.deepEqual(body.MessageAttributes.baggage, {
    DataType: 'String',
    StringValue: 'user=alice%40metalbear.com,env=dev',
  });

  // The middleware runs in the initialize step, so the payload it changed is
  // the payload that got signed. A mismatched content-length would mean we
  // mutated the body after signing and every real call would 403.
  assert.equal(
    Number(sent[0].headers['content-length']),
    Buffer.byteLength(sent[0].body),
    'body was modified after signing',
  );
  assert.ok(sent[0].headers.authorization.includes('Signature='));
});

test('preserves message attributes the caller set', async () => {
  const { client, sent } = makeClient({ MessageId: 'm-2' });
  await bag.runWith({ user: 'alice' }, () =>
    client.send(
      new SendMessageCommand({
        QueueUrl: QUEUE,
        MessageBody: 'hello',
        MessageAttributes: { tenant: { DataType: 'String', StringValue: 'acme' } },
      }),
    ),
  );
  const attrs = JSON.parse(sent[0].body).MessageAttributes;
  assert.equal(attrs.tenant.StringValue, 'acme');
  assert.equal(attrs.baggage.StringValue, 'user=alice');
});

test('adds baggage to every entry of a batch', async () => {
  const { client, sent } = makeClient({ Successful: [], Failed: [] });
  await bag.runWith({ user: 'alice' }, () =>
    client.send(
      new SendMessageBatchCommand({
        QueueUrl: QUEUE,
        Entries: [
          { Id: '1', MessageBody: 'one' },
          { Id: '2', MessageBody: 'two' },
        ],
      }),
    ),
  );
  const entries = JSON.parse(sent[0].body).Entries;
  assert.equal(entries.length, 2);
  for (const entry of entries)
    assert.equal(entry.MessageAttributes.baggage.StringValue, 'user=alice');
});

test('sends no attribute outside a context', async () => {
  const { client, sent } = makeClient({ MessageId: 'm-3' });
  await client.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: 'hello' }));
  assert.equal(JSON.parse(sent[0].body).MessageAttributes, undefined);
});

test('asks for the baggage attribute on ReceiveMessage', async () => {
  const { client, sent } = makeClient({ Messages: [] });
  await client.send(new ReceiveMessageCommand({ QueueUrl: QUEUE }));
  // Without this, SQS returns no message attributes at all and the consumer
  // side of propagation silently does nothing.
  assert.deepEqual(JSON.parse(sent[0].body).MessageAttributeNames, ['baggage']);
});

test('does not disturb an explicit MessageAttributeNames list', async () => {
  const { client, sent } = makeClient({ Messages: [] });
  await client.send(
    new ReceiveMessageCommand({ QueueUrl: QUEUE, MessageAttributeNames: ['tenant'] }),
  );
  assert.deepEqual(JSON.parse(sent[0].body).MessageAttributeNames, ['tenant', 'baggage']);

  const second = makeClient({ Messages: [] });
  await second.client.send(
    new ReceiveMessageCommand({ QueueUrl: QUEUE, MessageAttributeNames: ['All'] }),
  );
  assert.deepEqual(JSON.parse(second.sent[0].body).MessageAttributeNames, ['All']);
});

test('extracts baggage from both SDK and Lambda message shapes', () => {
  const fromSdk = bag.extractFromMessage({
    MessageAttributes: { baggage: { DataType: 'String', StringValue: 'user=alice,env=dev' } },
  });
  assert.equal(fromSdk.get('user').value, 'alice');

  const fromLambda = bag.extractFromMessage({
    messageAttributes: { baggage: { dataType: 'String', stringValue: 'user=bob' } },
  });
  assert.equal(fromLambda.get('user').value, 'bob');

  assert.equal(bag.extractFromMessage({}).size, 0);
  assert.equal(bag.extractFromMessage(null).size, 0);
});

test('a wrapped consumer restores context and propagates onward', async () => {
  const { client, sent } = makeClient({ MessageId: 'm-4' });

  const handler = bag.wrapMessageHandler(async (message) => {
    assert.equal(bag.get('user'), 'alice@metalbear.com');
    bag.set('worker', 'orders');
    await client.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: message.Body }));
  });

  await handler({
    Body: 'downstream',
    MessageAttributes: {
      baggage: { DataType: 'String', StringValue: 'user=alice%40metalbear.com' },
    },
  });

  assert.equal(
    JSON.parse(sent[0].body).MessageAttributes.baggage.StringValue,
    'user=alice%40metalbear.com,worker=orders',
  );
});

test('instrumenting the same client twice is idempotent', async () => {
  const { client, sent } = makeClient({ MessageId: 'm-5' });
  bag.instrumentSQSClient(client);
  bag.instrumentSQSClient(client);
  await bag.runWith({ user: 'alice' }, () =>
    client.send(new SendMessageCommand({ QueueUrl: QUEUE, MessageBody: 'hello' })),
  );
  assert.equal(JSON.parse(sent[0].body).MessageAttributes.baggage.StringValue, 'user=alice');
});
