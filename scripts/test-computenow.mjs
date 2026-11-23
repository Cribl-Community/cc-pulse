// F7: entityQuery lives in src/lib/computeNow.ts; state.tsx never falls back on its own.
// Run: node scripts/test-computenow.mjs   (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-cn-'));
const bundle = (f, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, f), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
bundle('src/lib/computeNow.ts', 'cn.mjs');
bundle('src/lib/snapshot.ts', 'sn.mjs');
const C = await import(join(tmp, 'cn.mjs'));
const S = await import(join(tmp, 'sn.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const state = readFileSync(join(root, 'src/state.tsx'), 'utf8');
const cn = readFileSync(join(root, 'src/lib/computeNow.ts'), 'utf8');
t('state.tsx has no entityQuery', () => !/entityQuery/.test(state));
t('computeNow.ts references entityQuery and exports computeNow', () => /entityQuery/.test(cn) && /export function computeNow/.test(cn));
t('state context exposes computeNow, stateReason and stateAge', () => /computeNow: \(\) => Promise<void>/.test(state) && /stateAge/.test(state) && /stateReason/.test(state));
t('rejected verdict computes nothing', () => {
  const i = state.indexOf('reason = v.reason;'), j = state.indexOf('catch (err)', i);
  return i > 0 && !/runSearch|computeEntities/.test(state.slice(i, j));
});
t('only the computeNow action calls the compute, and refresh reads the snapshot', () =>
  (state.match(/computeEntities\(/g) ?? []).length === 1 && /const refresh = useCallback\(async[^\n]*await run\(s, scopeRef\.current, true, true\)/.test(state)
  && !/liveAt\.current = Date\.now\(\)/.test(state));

const calls = [];
const settings = { dataset: 'main', rollup: 'off', learning: { LOOKBACK: '-24h' } };
const rows = await C.computeNow(settings, async (q, lb) => { calls.push([q, lb]); return [{ asset: 'a' }]; });
t('computeNow runs once, returns the rows', () => calls.length === 1 && rows.length === 1 && rows[0].asset === 'a');
t('computeNow runs the entity query over LOOKBACK', () => calls[0][1] === '-24h' && typeof calls[0][0] === 'string' && calls[0][0].length > 0);

t('snapshotAge: newest computed_at', () => S.snapshotAge([{ computed_at: 900 }, { computed_at: 940 }], 1000) === 60);
t('snapshotAge: no snapshot → undefined', () => S.snapshotAge([], 1000) === undefined && S.snapshotAge(undefined, 1000) === undefined);
t('stale snapshot is rejected and has an age', () => {
  const rows2 = [{ computed_at: 1 }];
  const v = S.snapshotVerdict({ saved: { query: 'dataset="main"', schedule: { enabled: true } }, dataset: 'main', rows: rows2, nowS: 5000 });
  return v.use === false && v.reason === 'stale' && S.snapshotAge(rows2, 5000) === 4999;
});

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('computenow: all ok');
