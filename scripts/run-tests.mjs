/**
 * Runs the test files in the given directories.
 *
 * Node's own directory handling for `--test` is not portable across versions:
 * Node 18 and 20 accept a directory, Node 22+ treats the argument as a glob and
 * fails on one. Expanding the file list here works identically on every version
 * in the matrix.
 *
 *   node scripts/run-tests.mjs test/unit test/e2e
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node scripts/run-tests.mjs <dir> [dir...]');
  process.exit(2);
}

const files = dirs.flatMap((dir) =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.test.mjs'))
    .sort()
    .map((name) => join(dir, name)),
);

if (files.length === 0) {
  console.error(`no test files found in ${dirs.join(', ')}`);
  process.exit(2);
}

const result = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' });
process.exit(result.status ?? 1);
