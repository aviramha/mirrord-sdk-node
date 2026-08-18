import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import test, { after, before } from 'node:test';

const require = createRequire(import.meta.url);
const bag = await import('../../dist/cjs/index.js');
bag.auto_propagate();
const esm = await import('../../dist/esm/index.js');
const cjs = require('../../dist/cjs/index.js');
const express = require('express');
const axios = require('axios');

let app;
let downstream;
const seen = [];

before(async () => {
  const http = await import('node:http');
  downstream = http.createServer((req, res) => {
    seen.push(req.headers.baggage ?? null);
    res.end('ok');
  });
  await new Promise((r) => downstream.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${downstream.address().port}/`;

  const server = express();
  server.use(bag.baggageMiddleware);
  server.get('/hop', async (_req, res) => {
    bag.set('hop', 'express');
    await axios.get(url);
    res.json(bag.getAll());
  });
  app = server.listen(0, '127.0.0.1');
  await new Promise((r) => app.on('listening', r));
});

after(() => {
  app?.close();
  downstream?.close();
});

test('the middleware establishes a context on its own', async () => {
  // Invoked directly, with no server hook in the picture, so this is the
  // middleware doing the work rather than the patched `request` event.
  let observed;
  await new Promise((resolve) => {
    bag.baggageMiddleware({ headers: { baggage: 'user=alice' } }, {}, () => {
      observed = bag.getAll();
      resolve();
    });
  });
  assert.deepEqual(observed, { user: 'alice' });
});

test('express plus axios propagates end to end', async () => {
  const res = await fetch(`http://127.0.0.1:${app.address().port}/hop`, {
    headers: { baggage: 'user=alice' },
  });
  assert.deepEqual(await res.json(), { user: 'alice', hop: 'express' });
  assert.equal(seen[0], 'user=alice,hop=express');
});

test('the CJS and ESM builds share one context', async () => {
  assert.notEqual(cjs, esm, 'two distinct module records, as expected');
  // A single AsyncLocalStorage is pinned to a global symbol, so context set
  // through one build is visible through the other. Without that, an app that
  // preloads the CJS build and imports the ESM one would see empty context.
  cjs.runWith({ user: 'alice' }, () => {
    assert.equal(esm.get('user'), 'alice');
    esm.set('added', 'by-esm');
    assert.equal(cjs.get('added'), 'by-esm');
  });
  assert.equal(cjs.is_propagating(), esm.is_propagating());
});
