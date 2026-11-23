// Unit tests for src/lib/snapshot.ts (spec 025 §3).
// Run: node scripts/test-snapshot.mjs   (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-sn-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/snapshot.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'snapshot.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const S = await import(join(tmp, 'snapshot.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const src = readFileSync(join(root, 'src/lib/snapshot.ts'), 'utf8');
t('no imports', () => !/^\s*import\s/m.test(src));
t('constants', () => S.SNAPSHOT_JOB === 'pulse_state' && S.SNAPSHOT_CAP === 50000 && S.SNAPSHOT_MAX_AGE_S === 900);
t('snapshotQuery', () => S.snapshotQuery() === 'dataset="$vt_results" | where jobName == "pulse_state"');

t('datasetOf quoted', () => S.datasetOf('dataset="x" | limit 1') === 'x');
t('datasetOf bare', () => S.datasetOf('dataset=x | limit 1') === 'x');
t('datasetOf none', () => S.datasetOf('cribl_host == "a" | limit 1') === undefined);

const ok = { query: 'dataset="d" | extend computed_at = now()', schedule: { enabled: true } };
const rows = [{ computed_at: 1000 }, { computed_at: '1100' }, { computed_at: 1050 }];
const a = { saved: ok, dataset: 'd', rows, nowS: 1200 };
const reason = (o) => { const v = S.snapshotVerdict({ ...a, ...o }); return v.use ? 'use' : v.reason; };

t('no-search', () => reason({ saved: undefined }) === 'no-search');
t('disabled (false)', () => reason({ saved: { ...ok, schedule: { enabled: false } } }) === 'disabled');
t('disabled (no schedule)', () => reason({ saved: { query: ok.query } }) === 'disabled');
t('exports', () => reason({ saved: { ...ok, query: ok.query + '\n| export mode=overwrite to lookup x' } }) === 'exports');
t('other-dataset', () => reason({ dataset: 'e' }) === 'other-dataset');
// Spec 026: a rollup-mode pulse_state reads <ds>_5m first and then <ds> (the raw tail).
const rollupQ = 'dataset="d_5m"\n| where bucket < 1\n| union (dataset="d" _metric=="x"\n  | where _time >= 1)\n| extend computed_at = now()';
t('datasetsOf lists every dataset in order', () => S.datasetsOf(rollupQ).join(',') === 'd_5m,d' && S.datasetsOf(null).length === 0);
t('rollup-mode snapshot query, rollup in use: use', () => reason({ saved: { ...ok, query: rollupQ }, rollupOk: true }) === 'use');
t('rollup-mode snapshot query, rollup not in use (or unknown): rollup', () => reason({ saved: { ...ok, query: rollupQ }, rollupOk: false }) === 'rollup' && reason({ saved: { ...ok, query: rollupQ } }) === 'rollup');
t('raw snapshot query ignores the rollup verdict', () => reason({ rollupOk: false }) === 'use');
t('readsRollup', () => S.readsRollup(rollupQ, 'd') && !S.readsRollup(ok.query, 'd') && !S.readsRollup(rollupQ, undefined) && !S.readsRollup(null, 'd'));
t('order: other-dataset before rollup', () => reason({ saved: { ...ok, query: rollupQ }, dataset: 'e' }) === 'other-dataset');
t('rollup-mode snapshot of another dataset: other-dataset', () => reason({ saved: { ...ok, query: rollupQ }, dataset: 'e' }) === 'other-dataset');
t('only the rollup, no raw tail: other-dataset', () => reason({ saved: { ...ok, query: 'dataset="d_5m" | extend computed_at = now()' } }) === 'other-dataset');
t('raw plus a foreign dataset: other-dataset', () => reason({ saved: { ...ok, query: 'dataset="d" | union (dataset="z")' } }) === 'other-dataset');
t('empty', () => reason({ rows: [] }) === 'empty');
const big = (n) => Array.from({ length: n }, () => ({ computed_at: 1190 }));
t('truncated at 50000', () => reason({ rows: big(50000) }) === 'truncated');
t('not truncated at 49999', () => reason({ rows: big(49999) }) === 'use');
t('stale at 901s', () => reason({ nowS: 1100 + 901 }) === 'stale');
t('fresh at 900s', () => reason({ nowS: 1100 + 900 }) === 'use');
t('order: exports before other-dataset', () => reason({ saved: { ...ok, query: 'dataset="z" | export' }, dataset: 'd' }) === 'exports');
t('order: empty before stale', () => reason({ rows: [], nowS: 1e9 }) === 'empty');
t('use asOf = max (mixed string/number)', () => { const v = S.snapshotVerdict(a); return v.use === true && v.asOf === 1100; });

const REASONS = ['no-search', 'disabled', 'exports', 'other-dataset', 'rollup', 'empty', 'truncated', 'stale'];
t('reasonMessage other-dataset exact', () => S.reasonMessage('other-dataset') === 'The Pulse snapshot reads another dataset: re-apply Settings → Alerts');
t('reasonMessage: every reason has a non-empty message', () => REASONS.every((r) => typeof S.reasonMessage(r) === 'string' && S.reasonMessage(r).trim().length > 0));
t('reasonMessage: messages are distinct', () => new Set(REASONS.map((r) => S.reasonMessage(r))).size === REASONS.length);
t('reasonMessage: no-search, disabled, exports say re-apply Settings → Alerts', () => ['no-search', 'disabled', 'exports'].every((r) => S.reasonMessage(r).includes('re-apply Settings → Alerts')));

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('test-snapshot: ok');
