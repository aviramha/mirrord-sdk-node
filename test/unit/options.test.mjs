import { strict as assert } from 'node:assert';
import http from 'node:http';
import test, { after } from 'node:test';

const { auto_propagate, is_propagating, stop_propagate } = await import('../../dist/cjs/index.js');

after(() => stop_propagate());

test('auto_propagate reports what it instrumented', () => {
  const handle = auto_propagate();
  assert.equal(handle.active, true);
  assert.equal(is_propagating(), true);
  assert.ok(handle.instrumented.includes('http-server'));
  assert.ok(handle.instrumented.includes('http-client'));
  assert.ok(handle.instrumented.includes('fetch'));
  handle.stop();
  assert.equal(is_propagating(), false);
});

test('the options argument exists but changes nothing', () => {
  // Kept in the signature so a future option is not a breaking change.
  const handle = auto_propagate({});
  assert.equal(handle.active, true);
  assert.deepEqual(handle.instrumented, auto_propagate().instrumented);
  handle.stop();
});

test('a second call does not stack hooks', () => {
  auto_propagate();
  const once = http.request;
  auto_propagate();
  assert.equal(http.request, once, 'the second call re-wrapped an already wrapped function');
  stop_propagate();
});
