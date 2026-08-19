import { strict as assert } from 'node:assert';
import http from 'node:http';
import test, { after, before } from 'node:test';

const bag = await import('../../dist/cjs/index.js');

// Started before any server or client exists.
bag.auto_propagate();
const { Controller, Get, Module } = await import('@nestjs/common');
const { NestFactory } = await import('@nestjs/core');
const axios = (await import('axios')).default;

/** Nest's decorators are plain functions, so a fixture needs no TS build step. */
function decorateGet(target, method, path) {
  Get(path)(target.prototype, method, Object.getOwnPropertyDescriptor(target.prototype, method));
}

const received = { downstream: [] };
let downstream;
let nest;
let nestUrl;

before(async () => {
  await import('reflect-metadata');

  // Hop 3: a bare node:http server that records what reached it.
  downstream = http.createServer((req, res) => {
    received.downstream.push({ path: req.url, baggage: req.headers.baggage ?? null });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ seen: bag.getAll() }));
  });
  await new Promise((r) => downstream.listen(0, '127.0.0.1', r));
  const downstreamUrl = `http://127.0.0.1:${downstream.address().port}`;

  // Hop 2: a real NestJS 10 app on platform-express that reads the inbound
  // context, adds to it, and calls the third hop three different ways.
  class HopController {
    async hop() {
      assert.equal(bag.get('user'), 'alice@metalbear.com');
      bag.set('hop', 'nest');
      await axios.get(`${downstreamUrl}/via-axios`);
      await fetch(`${downstreamUrl}/via-fetch`);
      await new Promise((resolve, reject) => {
        http
          .get(`${downstreamUrl}/via-http-get`, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      });
      return { context: bag.getAll() };
    }
  }
  decorateGet(HopController, 'hop', 'hop');
  Controller()(HopController);

  class AppModule {}
  Module({ controllers: [HopController] })(AppModule);

  nest = await NestFactory.create(AppModule, { logger: false });
  await nest.listen(0, '127.0.0.1');
  nestUrl = await nest.getUrl();
});

after(async () => {
  await nest?.close();
  downstream?.close();
});

test('propagates inbound baggage through NestJS to every outbound client', async () => {
  const res = await fetch(`${nestUrl}/hop`, {
    headers: { baggage: 'user=alice%40metalbear.com,env=dev;md=1' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), {
    context: { user: 'alice@metalbear.com', env: 'dev', hop: 'nest' },
  });

  const byPath = Object.fromEntries(received.downstream.map((r) => [r.path, r.baggage]));
  for (const path of ['/via-axios', '/via-fetch', '/via-http-get']) {
    assert.ok(byPath[path], `${path} received no baggage header`);
    const parsed = bag.parse(byPath[path]);
    assert.equal(parsed.get('user').value, 'alice@metalbear.com');
    assert.equal(parsed.get('hop').value, 'nest', `${path} missing the value added by Nest`);
    // Opaque properties survive a full hop.
    assert.deepEqual(parsed.get('env').properties, ['md=1']);
  }
});

test('keeps concurrent requests isolated', async () => {
  received.downstream.length = 0;
  await Promise.all(
    ['a', 'b', 'c', 'd'].map((id) =>
      fetch(`${nestUrl}/hop`, { headers: { baggage: `user=alice%40metalbear.com,req=${id}` } }),
    ),
  );

  const perRequest = new Map();
  for (const entry of received.downstream) {
    const id = bag.parse(entry.baggage).get('req').value;
    perRequest.set(id, (perRequest.get(id) || 0) + 1);
  }
  // Each of the four requests made exactly three outbound calls, none of which
  // picked up a sibling's context.
  assert.deepEqual([...perRequest.entries()].sort(), [
    ['a', 3],
    ['b', 3],
    ['c', 3],
    ['d', 3],
  ]);
});

test('starts an empty context when the inbound request has no baggage', async () => {
  received.downstream.length = 0;
  const res = await fetch(`${nestUrl}/hop`, { headers: { baggage: 'user=alice%40metalbear.com' } });
  await res.json();
  assert.equal(bag.parse(received.downstream[0].baggage).get('hop').value, 'nest');
});

test('sends nothing outside a request context', async () => {
  received.downstream.length = 0;
  await axios.get(`http://127.0.0.1:${downstream.address().port}/no-context`);
  assert.equal(received.downstream[0].baggage, null);
});
