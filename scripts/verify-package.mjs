/**
 * Packs the tarball, installs it into throwaway CJS, ESM and TypeScript
 * consumers, and checks that each one resolves and works.
 *
 * The unit tests import from `dist/` directly, so they cannot catch a broken
 * `exports` map, a missing file in `files`, or declarations that resolve to the
 * wrong module flavour — all of which only show up once someone installs it.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..');
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const npm = 'npm';
const npx = 'npx';

console.log('packing...');
run(npm, ['pack'], root);
const tarball = join(
  root,
  readdirSync(root).find((f) => f.endsWith('.tgz')),
);

const dir = mkdtempSync(join(tmpdir(), 'mirrord-baggage-verify-'));
let failures = 0;

function consumer(name, files, pkg, check) {
  const cwd = join(dir, name);
  mkdirSync(cwd, { recursive: true });
  const { extraDeps, ...manifest } = pkg;
  void extraDeps;
  writeFileSync(
    join(cwd, 'package.json'),
    JSON.stringify(
      { name: `consumer-${name}`, version: '1.0.0', private: true, ...manifest },
      null,
      2,
    ),
  );
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(cwd, file), contents);
  run(npm, ['install', tarball, ...(pkg.extraDeps || []), '--no-audit', '--no-fund'], cwd);
  try {
    check(cwd);
    console.log(`  ✔ ${name}`);
  } catch (error) {
    failures++;
    console.log(`  ✖ ${name}\n${error.stdout || error.message}`);
  }
}

const smoke = (entry) => `
const bag = ${entry === 'index.mjs' ? "(await import('mirrord-sdk')).default" : "require('mirrord-sdk').default"};
const http = ${entry === 'index.mjs' ? "(await import('node:http')).default" : "require('node:http')"};
bag.auto_propagate();
if (!bag.is_propagating()) throw new Error('auto_propagate did not take effect');
const server = http.createServer((req, res) => res.end(req.headers.baggage || 'none'));
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const res = await bag.runWith({ user: 'alice' }, () => fetch('http://127.0.0.1:' + server.address().port));
const body = await res.text();
server.close();
if (body !== 'user=alice') throw new Error('expected propagation, got ' + body);
`;

console.log('verifying consumers...');
consumer('cjs', { 'index.js': `(async () => {${smoke('index.js')}})()` }, {}, (cwd) =>
  run(process.execPath, ['index.js'], cwd),
);
consumer('esm', { 'index.mjs': smoke('index.mjs') }, { type: 'module' }, (cwd) =>
  run(process.execPath, ['index.mjs'], cwd),
);
consumer(
  'typescript',
  {
    'app.ts': `
import mirrord, {
  get,
  set,
  runWith,
  wrapMessageHandler,
  auto_propagate,
  parse,
  extractFromMessage,
} from 'mirrord-sdk';
auto_propagate().stop();
mirrord.auto_propagate();
const value: string | undefined = get('user');
const ok: boolean = set('hop', 'a');
runWith({ user: 'alice' }, () => value);
const handler = wrapMessageHandler(async (m: { Body?: string }) => m.Body);
const first: string | undefined = parse('a=1').get('a')?.value;
export { extractFromMessage, handler, ok, first };
`,
  },
  { extraDeps: ['typescript@5.4', '@types/node@20'] },
  (cwd) => {
    // Every resolution mode a consumer might be on, including the legacy one
    // NestJS projects still ship by default.
    for (const [module, resolution] of [
      ['node16', 'node16'],
      ['commonjs', 'node'],
      ['esnext', 'bundler'],
    ]) {
      run(
        join(cwd, 'node_modules', '.bin', 'tsc'),
        [
          '--noEmit',
          '--strict',
          '--skipLibCheck',
          '--target',
          'ES2020',
          '--module',
          module,
          '--moduleResolution',
          resolution,
          'app.ts',
        ],
        cwd,
      );
    }
  },
);

console.log('checking types against arethetypeswrong...');
try {
  const out = run(npx, ['--yes', '--package=@arethetypeswrong/cli', '--', 'attw', '--pack'], root);
  if (/💀|🎭|❌/.test(out)) throw new Error(out);
  console.log('  ✔ attw');
} catch (error) {
  failures++;
  console.log(`  ✖ attw\n${error.stdout || error.message}`);
}

rmSync(dir, { recursive: true, force: true });
rmSync(tarball, { force: true });
if (failures > 0) {
  console.error(`${failures} package check(s) failed`);
  process.exit(1);
}
console.log('package verified');
