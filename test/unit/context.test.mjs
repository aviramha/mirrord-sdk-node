import { strict as assert } from 'node:assert';
import test from 'node:test';

const {
  bind,
  currentHeader,
  get,
  getAll,
  hostAllowed,
  outboundHeader,
  remove,
  resolveConfig,
  runWith,
  runWithAdded,
  set,
} = await import('../../dist/cjs/index.js');

test('there is no context until one is established', () => {
  assert.equal(get('user'), undefined);
  assert.deepEqual(getAll(), {});
  assert.equal(currentHeader(), '');
  assert.equal(set('user', 'alice'), false, 'set outside a context reports failure, not a throw');
  assert.equal(remove('user'), false);
});

test('runWith accepts a header, an object, or a map', () => {
  runWith('user=alice%40metalbear.com,env=dev', () => {
    assert.equal(get('user'), 'alice@metalbear.com');
  });
  runWith({ user: 'alice' }, () => assert.equal(get('user'), 'alice'));
  runWith(new Map([['user', { value: 'alice' }]]), () => assert.equal(get('user'), 'alice'));
});

test('the context is per async subtree, not global', async () => {
  const observed = await Promise.all([
    runWith({ req: 'a' }, async () => {
      await new Promise((r) => setTimeout(r, 5));
      return getAll();
    }),
    runWith({ req: 'b' }, async () => {
      await Promise.resolve();
      return getAll();
    }),
  ]);
  assert.deepEqual(observed, [{ req: 'a' }, { req: 'b' }]);
  assert.deepEqual(getAll(), {}, 'nothing leaked back out');
});

test('set and remove mutate only the current context', () => {
  runWith({ user: 'alice' }, () => {
    assert.equal(set('tenant', 'acme'), true);
    assert.deepEqual(getAll(), { user: 'alice', tenant: 'acme' });
    assert.equal(remove('tenant'), true);
    assert.deepEqual(getAll(), { user: 'alice' });
  });
});

test('runWithAdded leaves the caller context untouched', () => {
  runWith({ user: 'alice' }, () => {
    runWithAdded({ hop: 'inner' }, () => {
      assert.deepEqual(getAll(), { user: 'alice', hop: 'inner' });
    });
    assert.deepEqual(getAll(), { user: 'alice' });
  });
});

test('bind snapshots the context onto a callback', async () => {
  const later = await runWith({ user: 'alice' }, () => Promise.resolve(bind(() => getAll())));
  assert.deepEqual(getAll(), {}, 'outside any context');
  assert.deepEqual(later(), { user: 'alice' });
});

test('currentHeader serializes what would go on the wire', () => {
  runWith({ user: 'alice@metalbear.com' }, () => {
    assert.equal(currentHeader(), 'user=alice%40metalbear.com');
  });
});

test('resolveConfig defaults to propagating everything', () => {
  assert.deepEqual(resolveConfig(), {
    allowKeys: null,
    allowHosts: null,
    denyHosts: null,
    http: true,
    httpClient: true,
    debug: false,
  });
});

test('hostAllowed honours allow and deny lists', () => {
  const allow = resolveConfig({ allowHosts: ['internal.svc', '*.metalbear.com'] });
  assert.equal(hostAllowed(allow, 'internal.svc'), true);
  assert.equal(hostAllowed(allow, 'api.metalbear.com'), true);
  assert.equal(hostAllowed(allow, 'metalbear.com'), false, 'a bare apex is not matched by *.');
  assert.equal(hostAllowed(allow, 'api.stripe.com'), false);
  assert.equal(hostAllowed(allow, 'INTERNAL.SVC:8080'), true, 'case and port are ignored');

  const deny = resolveConfig({ denyHosts: ['*.stripe.com'] });
  assert.equal(hostAllowed(deny, 'api.stripe.com'), false);
  assert.equal(hostAllowed(deny, 'api.internal'), true);

  const both = resolveConfig({ allowHosts: ['*.example.com'], denyHosts: ['secret.example.com'] });
  assert.equal(hostAllowed(both, 'ok.example.com'), true);
  assert.equal(hostAllowed(both, 'secret.example.com'), false, 'deny wins over allow');

  assert.equal(hostAllowed(resolveConfig(), 'anything.example'), true);
});

test('outboundHeader applies the key allowlist', () => {
  const config = resolveConfig({ allowKeys: ['user', 'tenant'] });
  runWith({ user: 'alice', tenant: 'acme', secret: 'do-not-send' }, () => {
    assert.equal(outboundHeader(config), 'user=alice,tenant=acme');
  });
});

test('outboundHeader returns null rather than throwing on a broken context', () => {
  // A malformed entry makes serialization throw; callers must still be able to
  // send the request, just without a header.
  runWith(new Map([['broken', null]]), () => {
    assert.equal(outboundHeader(resolveConfig()), null);
  });
  assert.equal(outboundHeader(resolveConfig()), null, 'no context at all');
});
