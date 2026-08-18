/**
 * End-to-end propagation across mixed transports.
 *
 * Every hop appends its own key, so the assertion at the end of each chain
 * proves both that the context survived every boundary and that each service
 * contributed to it in order.
 */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import test, { after, before } from 'node:test';

import { baggageOf, createBroker } from '../helpers/sqs-broker.mjs';

const mirrord = (await import('../../dist/cjs/index.js')).default;
const { auto_propagate, getAll, parse, set, wrapMessageHandler } =
  await import('../../dist/cjs/index.js');
const { SQSClient, SendMessageCommand } = await import('@aws-sdk/client-sqs');

auto_propagate();

const broker = createBroker();
const sqs = new SQSClient({
  region: 'us-east-1',
  credentials: { accessKeyId: 'AKIAFAKE', secretAccessKey: 'fake' },
  md5: false,
  requestHandler: broker.requestHandler,
});

const Q = (name) => `https://sqs.us-east-1.amazonaws.com/000000000000/${name}`;
const servers = [];

/** An HTTP service that appends `key` and then runs `next`. */
function service(key, next) {
  const server = http.createServer(async (req, res) => {
    try {
      set(key, '1');
      const body = await next(req);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(body ?? { context: getAll() }));
    } catch (error) {
      res.statusCode = 500;
      res.end(String(error?.stack || error));
    }
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

/** An SQS worker that appends `key` and then runs `next`. */
function worker(queue, key, next) {
  broker.subscribe(
    queue,
    wrapMessageHandler(async (message) => {
      // Nothing established this context but the message itself: drain() runs
      // outside the producer's async context.
      set(key, '1');
      await next(message);
    }),
  );
}

const send = (queue, body) =>
  sqs.send(new SendMessageCommand({ QueueUrl: queue, MessageBody: body }));
const keysOf = (header) => [...parse(header).keys()];

after(() => {
  for (const server of servers) server.close();
  mirrord.stop_propagate();
});

let sink;

before(async () => {
  // Terminal HTTP service: records what reached the end of a chain.
  sink = { hits: [] };
  sink.url = await service('sink', (req) => {
    sink.hits.push({ path: req.url, baggage: req.headers.baggage ?? null });
    return { ok: true };
  });
});

test('http -> http -> http', async () => {
  sink.hits.length = 0;
  const third = await service('svc3', (req) => {
    sink.hits.push({ path: req.url, baggage: req.headers.baggage ?? null });
    return { ok: true };
  });
  const second = await service('svc2', () => fetch(`${third}/end`).then((r) => r.json()));
  const first = await service('svc1', () => fetch(`${second}/mid`).then((r) => r.json()));

  const res = await fetch(`${first}/start`, { headers: { baggage: 'origin=client' } });
  assert.equal(res.status, 200);

  const end = sink.hits.find((h) => h.path === '/end');
  assert.ok(end, 'the chain did not reach the third service');
  assert.deepEqual(keysOf(end.baggage), ['origin', 'svc1', 'svc2']);
});

test('http -> sqs -> http', async () => {
  sink.hits.length = 0;
  const queue = Q('http-sqs-http');

  worker(queue, 'worker', () => fetch(`${sink.url}/after-queue`).then((r) => r.json()));
  const entry = await service('svc1', () => send(queue, 'payload').then(() => ({ queued: true })));

  await fetch(`${entry}/start`, { headers: { baggage: 'origin=client' } });
  await broker.drain();

  const end = sink.hits.find((h) => h.path === '/after-queue');
  assert.ok(end, 'the message never reached the downstream service');
  assert.deepEqual(keysOf(end.baggage), ['origin', 'svc1', 'worker']);
});

test('sqs -> http -> sqs', async () => {
  sink.hits.length = 0;
  const inbound = Q('sqs-http-sqs-in');
  const outbound = Q('sqs-http-sqs-out');

  const relay = await service('svc1', () =>
    send(outbound, 'relayed').then(() => ({ queued: true })),
  );
  worker(inbound, 'worker1', () => fetch(`${relay}/relay`).then((r) => r.json()));

  broker.publish(inbound, 'payload', 'origin=producer');
  await broker.drain();

  const [delivered] = broker.sink(outbound);
  assert.ok(delivered, 'nothing landed on the outbound queue');
  assert.deepEqual(keysOf(baggageOf(delivered)), ['origin', 'worker1', 'svc1']);
});

test('sqs -> sqs -> sqs', async () => {
  const one = Q('chain-1');
  const two = Q('chain-2');
  const three = Q('chain-3');

  worker(one, 'worker1', () => send(two, 'hop'));
  worker(two, 'worker2', () => send(three, 'hop'));

  broker.publish(one, 'payload', 'origin=producer');
  await broker.drain();

  const [delivered] = broker.sink(three);
  assert.ok(delivered, 'nothing landed on the final queue');
  assert.deepEqual(keysOf(baggageOf(delivered)), ['origin', 'worker1', 'worker2']);
});

test('a consumer starts from the message, not from ambient context', async () => {
  const queue = Q('isolation');
  let observedBeforeRestore = null;

  broker.subscribe(queue, async (message) => {
    // Deliberately not wrapped: without the wrapper there is no context at all,
    // which is what makes the wrapped case meaningful.
    observedBeforeRestore = getAll();
    await Promise.resolve(message);
  });

  await mirrord.runWith({ leaked: 'should-not-appear' }, async () => {
    broker.publish(queue, 'payload', 'origin=producer');
  });
  await broker.drain();

  assert.deepEqual(observedBeforeRestore, {}, 'producer context leaked into the consumer');
});

test('concurrent chains do not mix', async () => {
  const queue = Q('concurrent');
  const delivered = [];
  worker(queue, 'worker', (message) => {
    delivered.push({ body: message.Body, context: getAll() });
  });
  const entry = await service('svc1', (req) => send(queue, req.url).then(() => ({ queued: true })));

  await Promise.all(
    ['a', 'b', 'c', 'd'].map((id) =>
      fetch(`${entry}/${id}`, { headers: { baggage: `req=${id}` } }),
    ),
  );
  await broker.drain();

  assert.equal(delivered.length, 4);
  for (const entryDelivered of delivered) {
    const id = entryDelivered.body.slice(1);
    assert.deepEqual(entryDelivered.context, { req: id, svc1: '1', worker: '1' });
  }
});
