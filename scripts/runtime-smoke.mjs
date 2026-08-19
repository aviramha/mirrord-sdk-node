/**
 * Cross-runtime smoke test. Runs unchanged under Node, Bun and Deno:
 *
 *   node scripts/runtime-smoke.mjs
 *   bun  scripts/runtime-smoke.mjs
 *   deno run -A scripts/runtime-smoke.mjs
 *
 * Exercises the ESM build, since that is what non-Node runtimes load.
 */
import { strict as assert } from 'node:assert';
import http from 'node:http';

const bag = await import('../dist/esm/index.js');
bag.auto_propagate();

const runtime = globalThis.Deno ? 'deno' : globalThis.Bun ? 'bun' : 'node';
const results = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => results.push(['pass', name]))
    .catch((error) => results.push(['FAIL', name, error.message]));
}

const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ path: req.url, baggage: req.headers.baggage ?? null });
  res.end('ok');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

await check('esm build installs', () => {
  assert.equal(bag.is_propagating(), true);
});

await check('codec round-trips', () => {
  assert.equal(
    bag.serialize(bag.parse('user=a%40b.com;md=1,env=dev')),
    'user=a%40b.com;md=1,env=dev',
  );
});

await check('outbound fetch carries baggage', async () => {
  await bag.runWith({ user: 'alice@metalbear.com' }, () => fetch(`${url}/fetch`));
  const hit = seen.find((s) => s.path === '/fetch');
  assert.equal(hit.baggage, 'user=alice%40metalbear.com');
});

await check('outbound node:http carries baggage', async () => {
  await bag.runWith(
    { user: 'alice' },
    () =>
      new Promise((resolve, reject) => {
        http
          .get(`${url}/http`, (res) => {
            res.resume();
            res.on('end', resolve);
          })
          .on('error', reject);
      }),
  );
  assert.equal(seen.find((s) => s.path === '/http').baggage, 'user=alice');
});

await check('inbound server seeds context and propagates onward', async () => {
  const relay = http.createServer(async (_req, res) => {
    bag.set('hop', 'relay');
    await fetch(`${url}/relayed`);
    res.end('ok');
  });
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve));
  await fetch(`http://127.0.0.1:${relay.address().port}/`, { headers: { baggage: 'user=alice' } });
  assert.equal(seen.find((s) => s.path === '/relayed').baggage, 'user=alice,hop=relay');
  relay.close();
});

await check('async context survives timers and promises', async () => {
  await bag.runWith({ user: 'alice' }, async () => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await Promise.resolve();
    assert.equal(bag.get('user'), 'alice');
    await fetch(`${url}/async`);
  });
  assert.equal(seen.find((s) => s.path === '/async').baggage, 'user=alice');
});

server.close();

const failed = results.filter((r) => r[0] === 'FAIL');
for (const [status, name, message] of results) {
  console.log(
    `${status === 'pass' ? '✔' : '✖'} [${runtime}] ${name}${message ? ' — ' + message : ''}`,
  );
}
console.log(`${results.length - failed.length}/${results.length} passed on ${runtime}`);
if (failed.length > 0) process.exit(1);
