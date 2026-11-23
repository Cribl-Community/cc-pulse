// Spec 019: the setupState decision table and newestDeployment, run on the real src/lib/setup.ts.
// Run: node scripts/test-setup.mjs   (bundles setup.ts with esbuild into a temp file)
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src/lib/setup.ts');
const dir = mkdtempSync(join(tmpdir(), 'pulse-setup-'));
const out = join(dir, 'setup.mjs');
let mod;
try {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [src, '--bundle', '--platform=node', '--format=esm', '--log-level=error', `--outfile=${out}`], { stdio: 'inherit' });
  mod = await import(out);
} finally { rmSync(dir, { recursive: true, force: true }); }

let fail = 0;
const ok = (c, msg) => { if (!c) fail++; console.log(`${c ? 'ok  ' : 'FAIL'} ${msg}`); };

// Purity: no React, no api.ts, no imports at all needed.
const text = readFileSync(src, 'utf8');
ok(!/from\s+['"]react['"]/.test(text) && !/['"][./]*api(\.ts)?['"]/.test(text), 'setup.ts imports nothing from React or api.ts');
ok(typeof mod.setupState === 'function' && typeof mod.newestDeployment === 'function', 'setup.ts exports setupState and newestDeployment');

const rec = { group: 'default', inputs: [], filter: 'true', at: '2026-11-10T08:00:00.000Z', pack: '1.0.0' };
const T = [
  [{ demo: true, deployments: [], fleetCount: 0, loading: false }, 'demo', 'demo mode'],
  [{ demo: true, deployments: null, fleetCount: 3, loading: true }, 'demo', 'demo wins over everything'],
  [{ demo: false, deployments: [], fleetCount: 0, loading: true }, 'unknown', 'first load not finished'],
  [{ demo: false, deployments: [rec], fleetCount: 5, loading: true }, 'unknown', 'loading, even with assets'],
  [{ demo: false, deployments: [], fleetCount: 4, loading: false }, 'ready', 'assets, no records (assets win)'],
  [{ demo: false, deployments: null, fleetCount: 4, loading: false }, 'ready', 'assets, KV failure (null) (assets win)'],
  [{ demo: false, deployments: undefined, fleetCount: 4, loading: false }, 'ready', 'assets, KV failure (undefined)'],
  [{ demo: false, deployments: [rec], fleetCount: 2, loading: false }, 'ready', 'assets and a record'],
  [{ demo: false, deployments: null, fleetCount: 0, loading: false }, 'unknown', 'KV failure (null), no assets'],
  [{ demo: false, deployments: undefined, fleetCount: 0, loading: false }, 'unknown', 'KV failure (undefined), no assets'],
  [{ demo: false, deployments: new Error('500'), fleetCount: 0, loading: false }, 'unknown', 'KV failure (error marker), no assets'],
  [{ demo: false, deployments: [rec], fleetCount: 0, loading: false }, 'waiting', 'a record, no assets'],
  [{ demo: false, deployments: ['deployments/default'], fleetCount: 0, loading: false }, 'waiting', 'a record key, no assets'],
  [{ demo: false, deployments: [rec], fleetCount: 0, loading: false, error: 'Request timeout' }, 'waiting', 'a record, live-query error'],
  [{ demo: false, deployments: [], fleetCount: 0, loading: false }, 'not-deployed', 'no records, no assets'],
  [{ demo: false, deployments: [], fleetCount: 0, loading: false, error: 'Request timeout' }, 'not-deployed', 'no records, live-query error, no assets'],
];
for (const [input, want, why] of T) {
  let got; try { got = mod.setupState(input); } catch (e) { got = `throws ${e.message}`; }
  ok(got === want, `setupState: ${why} → ${want}${got === want ? '' : ` (got ${got})`}`);
}

// newestDeployment
const a = { ...rec, group: 'a', at: '2026-11-01T10:00:00.000Z' };
const b = { ...rec, group: 'b', at: '2026-11-09T10:00:00.000Z' };
const c = { ...rec, group: 'c', at: '2026-11-05T10:00:00.000Z' };
const bad = { ...rec, group: 'bad', at: 'not a date' };
ok(mod.newestDeployment([a, b, c])?.group === 'b', 'newestDeployment: the most recent of several');
ok(mod.newestDeployment([c, bad, a, b])?.group === 'b', 'newestDeployment: order-independent, bad timestamps lose');
ok(mod.newestDeployment([a])?.group === 'a', 'newestDeployment: a single record');
ok(mod.newestDeployment([]) === null, 'newestDeployment: null for an empty list');
ok(mod.newestDeployment(null) === null, 'newestDeployment: null for null');

console.log(fail ? `test-setup: ${fail} failure(s)` : 'test-setup: all passed');
process.exit(fail ? 1 : 0);
