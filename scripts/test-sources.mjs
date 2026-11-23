// Unit tests for src/lib/sources.ts (spec 025). Run: node scripts/test-sources.mjs (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-so-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/sources.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'sources.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const { sourcesOf } = await import(join(tmp, 'sources.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const row = (worker_group, input, asset, state) => ({ worker_group, input, asset, state });

const rows = [
  row('wb', 'in_b', 'a1', 'ok'),
  // wa/in_z: every state
  row('wa', 'in_z', 'h1', 'ok'), row('wa', 'in_z', 'h2', 'late'), row('wa', 'in_z', 'zed', 'missing'),
  row('wa', 'in_z', 'alpha', 'missing'), row('wa', 'in_z', 'zed', 'missing'), row('wa', 'in_z', 'h5', 'delayed'),
  row('wa', 'in_z', 'h6', 'acked'), row('wa', 'in_z', 'h7', 'learning'), row('wa', 'in_z', 'h8', 'muted'),
  row('wa', 'in_z', 'h9', 'maintenance'),
  // wa/in_a: only learning/muted -> learning
  row('wa', 'in_a', 'l1', 'learning'), row('wa', 'in_a', 'm1', 'muted'),
  // wa/in_m: healthy
  row('wa', 'in_m', 'k1', 'ok'), row('wa', 'in_m', 'k2', 'late'),
];
const out = sourcesOf(rows);
const g = (w, i) => out.find((r) => r.worker_group === w && r.input === i);

t('src is pure: only a type import', () => !/^\s*import\s(?!type)/m.test(readFileSync(join(root, 'src/lib/sources.ts'), 'utf8')));
t('group count', () => out.length === 4);
t('sorted by worker_group then input', () => out.map((r) => `${r.worker_group}/${r.input}`).join() === 'wa/in_a,wa/in_m,wa/in_z,wb/in_b');
const z = g('wa', 'in_z');
t('expected', () => z.expected === 7);
t('current', () => z.current === 3);
t('missing', () => z.missing === 3);
t('late', () => z.late === 1);
t('learning', () => z.learning === 1);
t('muted', () => z.muted === 2);
t('missing_list sorted and unique', () => JSON.stringify(z.missing_list) === '["alpha","zed"]');
t('health degraded', () => z.health === 'degraded');
t('health learning', () => g('wa', 'in_a').health === 'learning' && g('wa', 'in_a').expected === 0);
t('health healthy', () => g('wa', 'in_m').health === 'healthy' && g('wa', 'in_m').missing_list.length === 0);
t('input not mutated', () => rows.length === 15 && rows[0].worker_group === 'wb');
t('empty input', () => sourcesOf([]).length === 0);

if (fail) { console.log(`test-sources: ${fail} failed`); process.exit(1); }
console.log('test-sources: ok');
