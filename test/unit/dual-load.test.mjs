import { strict as assert } from 'node:assert';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);

// Both builds, loaded side by side in one process. This is what an application
// looks like when it imports the package while a dependency requires it.
const esm = await import('../../dist/esm/index.js');
const cjs = require('../../dist/cjs/index.js');

test('the CJS and ESM builds share one context', () => {
  assert.notEqual(cjs, esm, 'two distinct module records, as expected');

  // The store is pinned to a global symbol precisely so this holds. Without it
  // each build gets its own AsyncLocalStorage and one side silently sees
  // nothing, which is invisible until it happens in production.
  cjs.runWith({ user: 'alice' }, () => {
    assert.equal(esm.get('user'), 'alice');
    esm.set('added', 'by-esm');
    assert.equal(cjs.get('added'), 'by-esm');
  });

  esm.runWith({ user: 'bob' }, () => {
    assert.deepEqual(cjs.getAll(), { user: 'bob' });
  });

  assert.deepEqual(cjs.getAll(), {});
  assert.deepEqual(esm.getAll(), {});
});
