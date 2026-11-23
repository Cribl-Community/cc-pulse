// R3: the rollup verdict's lag limit follows the search load (spec 033 §2: rollup.maxLagS = everyS + 1200).
// Hourly's rollup runs at :03, so its newest closed bucket is ~13 min old just after the run and ~73 min old just
// before the next one: it must count as current up to 4800 s, not Standard's 1500 s. Both callers pass the limit:
// rollupDecision in deploy.ts (the Alerts plan) and checkRollup in state.tsx (Overview, Settings, history reads).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rollup-lag-'));
const build = (src, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/deploy.ts', 'd.mjs');
build('src/lib/cadence.ts', 'c.mjs');
const D = await import(join(tmp, 'd.mjs'));
const C = await import(join(tmp, 'c.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const base = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'auto', notify: { targets: [], email: '' }, rollCall: { hour: 7, tz: 'UTC', allClear: false },
  learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 } };
const now = 1_800_000_000;
const saved = { query: 'dataset="pulse_metrics" | export to lake pulse_metrics_5m', schedule: { enabled: true } };
const ctx = (ago) => ({ saved, newestBucket: now - ago, oldestBucket: now - 86400 - 300, nowS: now });
const dec = (load, ago) => D.rollupDecision(load ? { ...base, searchLoad: load } : base, ctx(ago));

t('cadence: hourly rollup.maxLagS is 4800', () => C.cadenceOf('hourly').rollup.maxLagS === 4800);

// The bug: from about :15 the hourly rollup's newest bucket is past 1500 s old, and it stays that way until the next run.
t('hourly: bucket 13 min old -> use', () => dec('hourly', 13 * 60).rollup === true);
t('hourly: bucket 30 min old (past 1500 s) -> still use', () => dec('hourly', 1800).rollup === true && dec('hourly', 1800).verdict.use === true);
t('hourly: bucket 73 min old (just before the next run) -> use', () => dec('hourly', 73 * 60).rollup === true);
t('hourly: exactly 4800 s -> use', () => dec('hourly', 4800).rollup === true);
t('hourly: 4801 s -> behind', () => dec('hourly', 4801).rollup === false && dec('hourly', 4801).verdict.reason === 'behind');

// Standard is unchanged: 1500 s, with or without searchLoad.
t('standard: 1500 s -> use, 1501 s -> behind', () => dec('standard', 1500).rollup === true && dec('standard', 1501).verdict.reason === 'behind');
t('missing searchLoad: Standard limit', () => dec(undefined, 1500).rollup === true && dec(undefined, 1501).verdict.reason === 'behind');
t('standard: 1800 s -> behind (the hourly case would be wrong here)', () => dec('standard', 1800).rollup === false);

// The Alerts plan follows the same verdict: in Hourly, a 30-min-old rollup bucket gives a rollup-mode pulse_state.
const modeOf = async (s, c) => {
  let q;
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body ?? '{}'); if (b.id === 'pulse_ledger_asset') q = b.query; }
    return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
  };
  await D.alertsPlan(s, true, c).find((x) => x.id === 'pulse_ledger_asset').run();
  return q.includes('rollup_ok') ? 'rollup' : 'raw';
};
const mHourly = await modeOf({ ...base, searchLoad: 'hourly' }, ctx(1800));
const mStd = await modeOf({ ...base, searchLoad: 'standard' }, ctx(1800));
t('alertsPlan (hourly, bucket 30 min old): alerts read the rollup', () => mHourly === 'rollup');
t('alertsPlan (standard, bucket 30 min old): alerts read raw', () => mStd === 'raw');

// state.tsx: the Overview / Settings verdict passes the load's limit, and a load change recomputes it.
const st = readFileSync(join(root, 'src/state.tsx'), 'utf8');
t('state.tsx: computeRollupVerdict gets maxLagS from the search load',
  () => /computeRollupVerdict\(\{[^}]*maxLagS:\s*rollupMaxLagS\(s\.searchLoad\)/.test(st));
t('state.tsx: the rollup-check effect re-runs on a search-load change',
  () => /settings\.learning\.LOOKBACK, settings\.searchLoad, checkRollup, startRollupCheck\]/.test(st)
    && /rollupCheckLoad\.current !== settings\.searchLoad\) void checkRollup\(settings\)/.test(st));
// deploy.ts: rollupDecision passes it too (behaviour checked above; this pins the call site).
const dp = readFileSync(join(root, 'src/lib/deploy.ts'), 'utf8');
t('deploy.ts: rollupDecision passes maxLagS', () => /rollupVerdict\(\{[^}]*maxLagS:\s*rollupMaxLagS\(normalizeLoad\(s\.searchLoad\)\)/.test(dp));

if (fail) { console.log(`${fail} failure(s)`); process.exit(1); }
console.log('test-rollup-lag-load: all passed');
