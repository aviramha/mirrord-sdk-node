import { writeFileSync } from 'node:fs';

// Node picks a file's module system from the nearest package.json `type`. The
// root package is commonjs, so the ESM output needs its own marker or every
// `import` in dist/esm is parsed as CJS and throws.
writeFileSync('dist/cjs/package.json', JSON.stringify({ type: 'commonjs' }, null, 2) + '\n');
writeFileSync('dist/esm/package.json', JSON.stringify({ type: 'module' }, null, 2) + '\n');
console.log('wrote dist/{cjs,esm}/package.json');
