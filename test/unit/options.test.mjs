import { strict as assert } from 'node:assert';
import http from 'node:http';
import test, { after, before } from 'node:test';

const { auto_propagate, runWith, stop_propagate } = await import('../../dist/cjs/index.js');

let server;
let port;
const seen = [];

before(async () => {
  server = http.createServer((req, res) => {
    seen.push(req.headers.baggage ?? null);
    res.end('ok');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
});

after(() => {
  stop_propagate();
  server?.close();
});

test('auto_propagate reports what it instrumented', () => {
  const handle = auto_propagate();
  assert.equal(handle.active, true);
  assert.deepEqual(handle.instrumented, ['http-server', 'http-client', 'fetch']);
  handle.stop();
});

test('surfaces can be switched off individually', () => {
  const handle = auto_propagate({ http: false });
  assert.deepEqual(handle.instrumented, ['http-client', 'fetch']);
  assert.equal(http.Server.prototype.emit.name, 'emit', 'the server was left alone');
  handle.stop();
});

test('a denied host receives no header on the wire', async () => {
  auto_propagate({ denyHosts: ['127.0.0.1'] });
  seen.length = 0;
  await runWith({ user: 'alice' }, () => fetch(`http://127.0.0.1:${port}/`));
  assert.equal(seen[0], null);

  stop_propagate();
  auto_propagate();
  await runWith({ user: 'alice' }, () => fetch(`http://127.0.0.1:${port}/`));
  assert.equal(seen[1], 'user=alice');
});

test('an allowKeys list filters what leaves the process', async () => {
  stop_propagate();
  auto_propagate({ allowKeys: ['user'] });
  seen.length = 0;
  await runWith({ user: 'alice', secret: 'do-not-send' }, () => fetch(`http://127.0.0.1:${port}/`));
  assert.equal(seen[0], 'user=alice');
});
