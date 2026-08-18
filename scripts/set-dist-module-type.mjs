/**
 * Marks each build output as CommonJS or ESM.
 *
 * Node decides how to parse a .js file from the `type` field of the nearest
 * package.json, not from the file's contents. This package is `"type":
 * "commonjs"`, so without a marker of its own every `import` statement in
 * dist/esm would be parsed as CommonJS and throw at load. Dropping a one-line
 * package.json into each output directory is the standard fix, and it is the
 * only thing this script does.
 *
 * The alternative is emitting .cjs and .mjs extensions, which would mean
 * renaming every source file to .cts/.mts and writing explicit extensions on
 * every relative import. Two generated files are cheaper.
 */
import { writeFileSync } from 'node:fs';

for (const [dir, type] of [
  ['cjs', 'commonjs'],
  ['esm', 'module'],
]) {
  writeFileSync(`dist/${dir}/package.json`, `${JSON.stringify({ type }, null, 2)}\n`);
}
