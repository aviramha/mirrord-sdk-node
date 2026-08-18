/**
 * The library must be invisible to an application that is not using it, and
 * must never turn its own failure into the application's failure.
 */
import { strict as assert } from 'node:assert';
import http from 'node:http';
import https from 'node:https';
import test, { after, before } from 'node:test';

const mirrord = (await import('../../dist/cjs/index.js')).default;
const { auto_propagate, getAll, is_propagating, runWith, set, stop_propagate } =
  await import('../../dist/cjs/index.js');

const pristine = {
  httpRequest: http.request,
  httpGet: http.get,
  httpsRequest: https.request,
  httpsGet: https.get,
  fetch: globalThis.fetch,
  serverEmit: http.Server.prototype.emit,
};

const crashes = [];
process.on('unhandledRejection', (reason) => crashes.push(['unhandledRejection', reason]));
process.on('uncaughtException', (error) => crashes.push(['uncaughtException', error]));

let server;
let url;
const received = [];

before(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push({
        path: req.url,
        method: req.method,
        baggage: req.headers.baggage ?? null,
        custom: req.headers['x-custom'] ?? null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      if (req.url === '/boom') {
        res.statusCode = 503;
        res.end('upstream is unwell');
        return;
      }
      res.setHeader('x-echo', 'yes');
      res.end('ok');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  stop_propagate();
  server?.close();
});

test('importing the package patches nothing', () => {
  assert.equal(is_propagating(), false);
  assert.equal(http.request, pristine.httpRequest);
  assert.equal(http.get, pristine.httpGet);
  assert.equal(https.request, pristine.httpsRequest);
  assert.equal(globalThis.fetch, pristine.fetch);
  assert.equal(http.Server.prototype.emit, pristine.serverEmit);
});

test('the context API works before propagation is started', () => {
  runWith({ user: 'alice' }, () => {
    assert.equal(mirrord.get('user'), 'alice');
  });
  assert.equal(set('user', 'alice'), false, 'set outside a context reports failure, not a throw');
});

test('auto_propagate reports what it instrumented', () => {
  const handle = auto_propagate();
  assert.equal(handle.active, true);
  assert.ok(handle.instrumented.includes('http-server'));
  assert.ok(handle.instrumented.includes('http-client'));
  assert.ok(handle.instrumented.includes('fetch'));
});

test('calling auto_propagate twice does not stack hooks', async () => {
  const once = http.request;
  auto_propagate();
  auto_propagate();
  assert.equal(http.request, once, 'the second call re-wrapped an already wrapped function');

  received.length = 0;
  await runWith({ user: 'alice' }, () => fetch(`${url}/twice`));
  assert.equal(received[0].baggage, 'user=alice', 'a stacked hook would duplicate the value');
});

test('requests outside a context are untouched', async () => {
  received.length = 0;
  const res = await fetch(`${url}/plain`, { headers: { 'x-custom': 'kept' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-echo'), 'yes', 'the response is not modified');
  assert.equal(received[0].baggage, null);
  assert.equal(received[0].custom, 'kept');
});

test('request bodies survive intact', async () => {
  received.length = 0;
  const payload = JSON.stringify({ nested: { emoji: '🐻', big: 'x'.repeat(5000) } });
  await runWith({ user: 'alice' }, () =>
    fetch(`${url}/body`, {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
    }),
  );
  assert.equal(received[0].body, payload);
  assert.equal(received[0].method, 'POST');
  assert.equal(received[0].baggage, 'user=alice');
});

test('every node:http call signature still works', async () => {
  received.length = 0;
  const { port } = server.address();
  const call = (label, invoke) =>
    new Promise((resolve, reject) => {
      const req = invoke((res) => {
        res.resume();
        res.on('end', () => resolve(label));
      });
      req.on('error', reject);
      req.end();
    });

  await runWith({ user: 'alice' }, async () => {
    await call('options', (cb) => http.request({ host: '127.0.0.1', port, path: '/opts' }, cb));
    await call('url', (cb) => http.request(`${url}/url`, cb));
    await call('url+options', (cb) => http.request(`${url}/both`, { method: 'GET' }, cb));
    await call('URL object', (cb) => http.request(new URL(`${url}/urlobj`), cb));
  });

  assert.deepEqual(
    received.map((r) => [r.path, r.baggage]),
    [
      ['/opts', 'user=alice'],
      ['/url', 'user=alice'],
      ['/both', 'user=alice'],
      ['/urlobj', 'user=alice'],
    ],
  );
});

test('a reused options object does not carry context between requests', async () => {
  received.length = 0;
  const { port } = server.address();
  // A caller that builds options once and reuses them would otherwise get the
  // first request's baggage pinned onto every later one, including requests
  // made from a completely different context.
  const options = { host: '127.0.0.1', port, path: '/reused', headers: { 'x-custom': 'kept' } };

  const fire = () =>
    new Promise((resolve, reject) => {
      const req = http.request(options, (res) => {
        res.resume();
        res.on('end', resolve);
      });
      req.on('error', reject);
      req.end();
    });

  await runWith({ user: 'alice' }, fire);
  await runWith({ user: 'bob' }, fire);
  await fire();

  assert.deepEqual(
    received.map((r) => r.baggage),
    ['user=alice', 'user=bob', null],
  );
  assert.equal(options.headers.baggage, undefined, 'the caller object was mutated');
  assert.deepEqual(
    received.map((r) => r.custom),
    ['kept', 'kept', 'kept'],
  );
});

test('an explicit header always wins', async () => {
  received.length = 0;
  await runWith({ user: 'alice' }, () =>
    fetch(`${url}/explicit`, { headers: { baggage: 'user=explicit' } }),
  );
  assert.equal(received[0].baggage, 'user=explicit');
});

test('a context that cannot be serialized does not break the request', async () => {
  received.length = 0;
  // A malformed entry makes serialization throw. The guarantee is that the
  // request still goes out, just without a header.
  const hostile = new Map([
    ['broken', null],
    ['also', undefined],
  ]);
  const res = await runWith(hostile, () => fetch(`${url}/hostile`));
  assert.equal(res.status, 200);
  assert.equal(received[0].baggage, null);
});

test('a hostile inbound header changes nothing about the response', async () => {
  const headers = [
    'a'.repeat(20000), // over Node's own maxHeaderSize; the server rejects it either way
    'a'.repeat(10000), // over the baggage spec limit, under Node's
    '=,,;;==,',
    'k=%%%%',
    'k=' + '%C3%A9'.repeat(1500), // multi-byte once decoded, latin-1 on the wire
    'valid=1,' + 'b'.repeat(9000),
    'k=v;;;;;;',
    ' , , ',
  ];

  const statuses = async () => {
    const out = [];
    for (const baggage of headers) {
      out.push(await fetch(`${url}/hostile-in`, { headers: { baggage } }).then((r) => r.status));
    }
    return out;
  };

  // The guarantee is parity, not a particular status: whatever the server did
  // with a header before instrumentation, it must still do afterwards.
  let before;
  try {
    stop_propagate();
    before = await statuses();
  } finally {
    auto_propagate();
  }
  const after = await statuses();

  assert.deepEqual(after, before);
  assert.ok(
    after.some((status) => status === 200),
    'the sane ones should still succeed',
  );
});

test('upstream errors and status codes pass through unchanged', async () => {
  const res = await runWith({ user: 'alice' }, () => fetch(`${url}/boom`));
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'upstream is unwell');

  await assert.rejects(
    () => runWith({ user: 'alice' }, () => fetch('http://127.0.0.1:1/nothing-listening')),
    'a connection failure still rejects',
  );

  await assert.rejects(
    () =>
      runWith(
        { user: 'alice' },
        () =>
          new Promise((resolve, reject) => {
            const req = http.request({ host: '127.0.0.1', port: 1, path: '/' }, resolve);
            req.on('error', reject);
            req.end();
          }),
      ),
    'node:http still emits error',
  );
});

test('fetch is called exactly once per call', async () => {
  const before = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = function counted(...args) {
    calls++;
    return before.apply(this, args);
  };
  try {
    await runWith({ user: 'alice' }, () => fetch(`${url}/once`));
    // The wrapper sits above this counter, so one logical call must reach it
    // once — an error path that retried would show two.
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = before;
  }
});

test('a Request object as fetch input still works', async () => {
  received.length = 0;
  const request = new Request(`${url}/request-object`, {
    method: 'POST',
    body: 'payload',
    headers: { 'x-custom': 'kept' },
  });
  await runWith({ user: 'alice' }, () => fetch(request));
  assert.equal(received[0].baggage, 'user=alice');
  assert.equal(received[0].custom, 'kept');
  assert.equal(received[0].body, 'payload');
});

test('context does not leak between sequential requests', async () => {
  received.length = 0;
  await runWith({ user: 'alice' }, () => fetch(`${url}/first`));
  await fetch(`${url}/second`);
  assert.deepEqual(
    received.map((r) => r.baggage),
    ['user=alice', null],
  );
  assert.deepEqual(getAll(), {}, 'no context outside runWith');
});

test('another library wrapping http.request afterwards still works', async () => {
  received.length = 0;
  const ours = http.request;
  let sawIt = 0;
  http.request = function otherApm(...args) {
    sawIt++;
    return ours.apply(this, args);
  };
  try {
    await runWith(
      { user: 'alice' },
      () =>
        new Promise((resolve, reject) => {
          const req = http.request(`${url}/layered`, (res) => {
            res.resume();
            res.on('end', resolve);
          });
          req.on('error', reject);
          req.end();
        }),
    );
    assert.equal(sawIt, 1);
    assert.equal(received[0].baggage, 'user=alice');
  } finally {
    http.request = ours;
  }
});

test('stop_propagate restores every original', () => {
  stop_propagate();
  assert.equal(is_propagating(), false);
  assert.equal(http.request, pristine.httpRequest);
  assert.equal(http.get, pristine.httpGet);
  assert.equal(https.request, pristine.httpsRequest);
  assert.equal(https.get, pristine.httpsGet);
  assert.equal(globalThis.fetch, pristine.fetch);
  assert.equal(http.Server.prototype.emit, pristine.serverEmit);
});

test('stopping twice is harmless, and restarting works', async () => {
  stop_propagate();
  stop_propagate();
  received.length = 0;
  await runWith({ user: 'alice' }, () => fetch(`${url}/stopped`));
  assert.equal(received[0].baggage, null, 'still propagating after stop');

  auto_propagate();
  await runWith({ user: 'alice' }, () => fetch(`${url}/restarted`));
  assert.equal(received[1].baggage, 'user=alice');
});

test('nothing crashed the process along the way', () => {
  assert.deepEqual(crashes, []);
});
