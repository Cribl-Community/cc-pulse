// Spec 039 F4: setupFilter helper. Run: node scripts/test-setup-filter.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(mkdtempSync(join(tmpdir(), 'pulse-filter-')), 'f.mjs');
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/setupFilter.ts'), '--bundle', '--format=esm', `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
const { filterGroups } = await import(out);
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };
const g = ['prod-eu', 'prod-us', 'edge-paris'].map((id) => ({ id }));
const names = (q) => filterGroups(g, q, (x) => x.id).map((x) => x.id).join(',');
ok(names('prod') === 'prod-eu,prod-us', 'prod keeps prod-eu and prod-us, hides edge-paris');
ok(names('PROD') === 'prod-eu,prod-us', 'case-insensitive');
ok(names('') === 'prod-eu,prod-us,edge-paris', 'empty query shows all');
ok(names('  ') === 'prod-eu,prod-us,edge-paris', 'blank query shows all');
ok(names('zzz') === '', 'no match shows none');
process.exit(fail ? 1 : 0);
