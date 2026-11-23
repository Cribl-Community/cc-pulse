// Spec 033 §2: the pure cadence module (src/lib/cadence.ts).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-cadence-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/cadence.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'c.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const C = await import(join(tmp, 'c.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const eq = (a, b) => { deepStrictEqual(a, b); return true; };

t('no react/fetch imports', () => !/import .*from|fetch\(/.test(readFileSync(join(root, 'src/lib/cadence.ts'), 'utf8')));

const s = C.cadenceOf('standard');
t('standard crons', () => eq(s.crons, {
  pulse_rollup: '3-59/5 * * * *', pulse_state: '*/5 * * * *', pulse_ledger_asset: '2-59/5 * * * *', pulse_ledger_source: '2-59/5 * * * *',
  pulse_alert_missing: '4-59/5 * * * *', pulse_alert_source_down: '4-59/5 * * * *', pulse_source_digest: '7 * * * *', pulse_roll_call: null }));
// F3 moved the crons out of kql.ts (it takes them from cadenceOf), so this compares the definitions kql.ts emits.
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));
t('standard crons match kql.ts', () => {
  const defs = K.savedSearches({ dataset: 'd', learning: { LOOKBACK: '-24h', GRACE_S: 0 }, notify: {}, rollup: 'auto', searchLoad: 'standard' });
  return Object.entries(s.crons).every(([id, c]) => c === null ? !defs.some((d) => d.id === id) : defs.some((d) => d.id === id && d.cron === c && d.enabled !== false));
});
t('standard windows', () => s.runEvery === 360 && s.snapshotMaxAgeS === 900 && s.runsPerDay === 1752 && s.tz === 'UTC'
  && eq(s.rollup, { earliest: '-20m', maxLagS: 1500, tailS: 1800 }) && s.snapshotEarliest === '-1h' && s.historyOnTick && s.snapshotJob === 'pulse_state');

const h = C.cadenceOf('hourly', { hour: 6, tz: 'Europe/Paris' });
t('hourly crons', () => eq(h.crons, {
  pulse_rollup: '3 * * * *', pulse_state: '5 * * * *', pulse_ledger_asset: '7 * * * *', pulse_ledger_source: '7 * * * *',
  pulse_alert_missing: '9 * * * *', pulse_alert_source_down: '9 * * * *', pulse_source_digest: '7 6 * * *', pulse_roll_call: null }));
t('hourly windows', () => h.runEvery === 3660 && h.snapshotMaxAgeS === 4200 && h.runsPerDay === 145 && h.snapshotEarliest === '-2h'
  && eq(h.rollup, { earliest: '-130m', maxLagS: 4800, tailS: 5100 }) && h.tz === 'Europe/Paris');

const d = C.cadenceOf('daily', { hour: 6, tz: 'Europe/Paris' });
t('daily', () => Object.entries(d.crons).every(([id, c]) => (id === 'pulse_roll_call' ? c === '0 6 * * *' : c === null))
  && d.tz === 'Europe/Paris' && d.rollup === null && d.historyOnTick === false && d.snapshotJob === 'pulse_roll_call'
  && d.snapshotMaxAgeS === 90000 && d.snapshotEarliest === '-26h' && d.runsPerDay === 1 && d.runEvery === 86460);

// runsPerDay derived from the crons: 288 per 5-minute-step cron, 24 per hourly, 1 per daily
const perDay = (c) => {
  if (!c) return 0;
  const [m, hr] = c.split(' ');
  if (/\/5$/.test(m)) return 288;
  return hr === '*' ? 24 : 1;
};
for (const [name, c] of [['standard', s], ['hourly', h], ['daily', d]])
  t(`runsPerDay derived (${name})`, () => Object.values(c.crons).reduce((a, x) => a + perDay(x), 0) === c.runsPerDay);

t('normalizeLoad', () => ['standard', 'hourly', 'daily'].every((l) => C.normalizeLoad(l) === l)
  && C.normalizeLoad(undefined) === 'standard' && C.normalizeLoad('') === 'standard' && C.normalizeLoad('fast') === 'standard');
t('readerCron', () => C.readerCron('*/5 * * * *') === '2-59/5 * * * *' && C.readerCron('5 * * * *') === '7 * * * *'
  && C.readerCron('2-59/5 * * * *') === '4-59/5 * * * *');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('cadence ok');
