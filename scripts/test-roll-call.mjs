// Spec 033 §4: rollCallQuery and the pulse_roll_call saved search.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rollcall-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const base = (searchLoad, extra = {}) => ({ dataset: 'd', learning: { LOOKBACK: '-24h', GRACE_S: 0, MIN_GAP: 60, K: 4, MAX_GAP: 3600, LEARN_MIN: 30, FUTURE_S: 60, LAG_MAX: 600, VOL_MIN: 0.3 },
  notify: {}, rollup: 'auto', searchLoad, rollCall: { hour: 6, tz: 'UTC', allClear: false }, ...extra });

for (const l of ['standard', 'hourly']) t(`no roll call in ${l}`, () => !K.savedSearches(base(l)).some((d) => d.id === 'pulse_roll_call'));
t('daily has roll call', () => {
  const d = K.savedSearches(base('daily')).find((x) => x.id === 'pulse_roll_call');
  return !!d && d.cron === '0 6 * * *' && d.enabled !== false && d.notify === true && d.earliest === '-25h' && d.query === K.rollCallQuery(base('daily'));
});
t('earliest honours a longer LOOKBACK', () => K.rollCallEarliest(base('daily', { learning: { ...base('daily').learning, LOOKBACK: '-7d' } })) === '-7d');

const q = K.rollCallQuery(base('daily'));
t('reads $vt_results', () => q.includes('dataset="$vt_results" | where jobName == "pulse_roll_call"'));
t('forget rule', () => K.ROLL_CALL_FORGET_D === 30 && q.includes(String(30 * 86400)));
// R5: the carry-forward branch (the union) takes only the previous run's missing rows, and re-checks every maintenance window.
const carry = (() => { const i = q.indexOf('| union ('); return i < 0 ? '' : q.slice(i, q.indexOf('| extend is_exp', i)); })();
const carryLines = carry.split('\n').map((x) => x.trim());
const prevFilter = carryLines.findIndex((x) => x.startsWith('| where') && x.includes('raw_state == "missing"'));
// F3: the anti-join is gone; the dedupe is eventstats only_carried + a where after the carried branch (carried rows come first).
const antiJoin = carryLines.findIndex((x) => x.startsWith('| eventstats only_carried'));
t('carry-forward branch found', () => carry.includes('jobName == "pulse_roll_call"') && antiJoin > 0 || carry);
t('carry-forward keeps only rows the previous run saw as missing (never learning / ok / late / delayed)', () =>
  prevFilter > 0 && prevFilter < antiJoin && /state in \("missing", "maintenance"\)/.test(carryLines[prevFilter]) || carryLines.slice(0, 4).join(' / '));
t('carry-forward drops previous muted / acked rows', () => !/state in \([^)]*"(muted|acked|learning|ok|late|delayed)"/.test(carryLines[prevFilter] ?? ''));
t('carry-forward re-checks the fleet, group and source maintenance windows', () =>
  ['mw_key = "*"', 'mw_key = strcat("g:", worker_group)', 'mw_key = strcat("i:", worker_group, "|", input)'].every((k) => carry.includes(k)) || carry);
t('carry-forward: an open window keeps the row as maintenance (not counted), else missing', () =>
  carry.includes('maintenance = case(mw_src != "", mw_src, mw_grp != "", mw_grp, mw_all)')
  && carry.includes('state = iff(maintenance != "", "maintenance", "missing")') && !/extend state = "missing"/.test(carry));
t('carry-forward still re-checks overrides and the 30-day forget', () => carry.includes('lookup pulse_overrides on input, asset') && carry.includes('where not(ov_on)')
  && carry.includes(`where silent_s <= ${30 * 86400}`));
t('maintenance rows are not expected nor missing in the totals', () => /is_exp = iff\(state in \("ok", "late", "missing", "delayed", "acked"\)/.test(q) && q.includes('is_miss = iff(state == "missing", 1, 0)'));
t('today\'s scan uses the same three maintenance windows', () => K.entityQuery({ ...base('daily'), rollup: 'off' }).includes('mw_key = strcat("i:", worker_group, "|", input)'));

t('fields', () => ['n_expected', 'n_reporting', 'n_missing', 'missing_list', 'signal_list', 'computed_at = now()'].every((f) => q.includes(f)));
t('missing first', () => /\| sort by iff\(state == "missing", 0, 1\) asc/.test(q));
t('the missing list is capped (characters, cut at a comma) with "+N more", no array_* functions', () => /extract\(@'\^\(\.\{0,\d+\}\),'/.test(q) && q.includes(' more') && !/array_|strcat_array|pack_array/.test(q));
t('no rollup dataset', () => !/rollup/.test(K.rollCallQuery(base('daily', { rollup: 'auto' }))) && !/rollup/.test(K.rollCallQuery(base('standard', { rollup: 'auto' }))));
t('message template', () => K.ROLL_CALL_MESSAGE.startsWith('Pulse roll call: {{resultSet[0].n_reporting}} of {{resultSet[0].n_expected}} assets reporting. Missing ({{resultSet[0].n_missing}}): ')
  && K.ROLL_CALL_MESSAGE.endsWith('Signals: {{resultSet[0].signal_list}}.'));
t('message helper', () => K.rollCallMessage({ n_reporting: 409, n_expected: 412, n_missing: 3, missing_list: 'a, b, c', signal_list: '2 delayed' })
  === 'Pulse roll call: 409 of 412 assets reporting. Missing (3): a, b, c. Signals: 2 delayed.');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('roll-call ok');
