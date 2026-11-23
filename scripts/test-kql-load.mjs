// Spec 033 T3 (feature F3): kql.ts takes its crons and windows from cadence.ts.
//   node scripts/test-kql-load.mjs          checks
//   node scripts/test-kql-load.mjs --print  prints the Standard hashes (how STANDARD below was pinned, before F3)
// With searchLoad 'standard' every query text must be byte-identical to the output before F3: STANDARD holds the
// sha256 of each output, computed from the pre-F3 kql.ts.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-kql-load-'));
const bundle = async (src, out) => {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
  return import(join(tmp, out));
};
const K = await bundle('src/lib/kql.ts', 'k.mjs');
const C = await bundle('src/lib/cadence.ts', 'c.mjs');
const R = await bundle('src/lib/rollup.ts', 'r.mjs');

const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const base = { dataset: 'pulse_metrics_pq', destination: 'pulse_lake_pq', routeFilter: "!__inputId.startsWith('cribl:')", learning: L,
  notify: { targets: ['slack_noc'], email: 'ops@acme.io', routes: [], remindH: 0, recovery: true }, refresh: '5m', rollup: 'auto',
  searchLoad: 'standard', rollCall: { hour: 7, tz: 'Europe/Paris', allClear: false } };
const variants = {
  auto: base,
  off: { ...base, rollup: 'off' },
  remind: { ...base, notify: { ...base.notify, remindH: 4 }, learning: { ...L, GRACE_S: 120 } },
  legacy: (() => { const { rollup: _r, searchLoad: _l, rollCall: _c, ...rest } = base; return rest; })(), // a pre-026 caller
};
const NOW = 1_763_700_000;
const windows = {
  day: { earliestS: NOW - 86400, latestS: NOW, nowS: NOW },
  old: { earliestS: NOW - 86400, latestS: NOW - 7200, nowS: NOW },
  hour: { earliestS: NOW - 3600, latestS: NOW, nowS: NOW },
  short: { earliestS: NOW - 86400, latestS: NOW, nowS: NOW, rollupFromS: NOW - 3600 },
};

/** Every query text kql.ts builds, by name, for one settings object. */
function outputs(s) {
  const o = {};
  const ss = K.savedSearches(s);
  o.savedSearches = JSON.stringify(ss);
  for (const d of ss) o[`query:${d.id}`] = d.query;
  o.alertMissing = ss.find((d) => d.id === 'pulse_alert_missing').query;
  o.body = K.body(s);
  o.entityQuery = K.entityQuery(s);
  o.sourceQuery = K.sourceQuery(s);
  o.rollupQuery = K.rollupQuery(s);
  o.rollupBackfill = K.rollupQuery(s, 7 * 86400);
  o.ledgerAsset = K.ledgerQuery(s, 'asset');
  o.ledgerSource = K.ledgerQuery(s, 'source');
  o.activityQuery = K.activityQuery(s, 1800, 'g1');
  o.fleetQuery = K.fleetQuery(s);
  o.gapsQuery = K.gapsQuery(s, 'g1');
  o.gapsCutEdges = JSON.stringify(K.gapsCutEdges(s, 'g1'));
  for (const [wn, w] of Object.entries(windows)) {
    o[`activityParts:${wn}`] = JSON.stringify(K.activityParts(s, 1800, 'g1', w));
    o[`activityParts60:${wn}`] = JSON.stringify(K.activityParts(s, 60, undefined, w));
    o[`fleetParts:${wn}`] = JSON.stringify(K.fleetParts(s, 300, w));
    o[`gapsParts:${wn}`] = JSON.stringify(K.gapsParts(s, 'g1', w));
    o[`rollupApplies:${wn}`] = String(K.rollupApplies(s, 1800, w));
  }
  o.historyCutS = String(K.historyCutS(NOW, 1800));
  return o;
}
const sha = (x) => createHash('sha256').update(x).digest('hex').slice(0, 20);
const hashes = () => Object.fromEntries(Object.entries(variants).map(([vn, s]) =>
  [vn, Object.fromEntries(Object.entries(outputs(s)).map(([k, v]) => [k, sha(v)]))]));

if (process.argv.includes('--print')) { console.log(JSON.stringify(hashes(), null, 2)); process.exit(0); }

// Pinned from the pre-F3 kql.ts (commit 5d0860d) with --print.
const STANDARD = {
  auto: {
    savedSearches: '73ed1f84d6985ba2de86', 'query:pulse_rollup': 'c26b1adc63bbec84e7c1', 'query:pulse_state': '48f75e94fe49d04450c9',
    'query:pulse_ledger_asset': '1a0aa755d60b00be8a32', 'query:pulse_ledger_source': '0596ec26f03a97ce2f38', 'query:pulse_alert_missing': 'd5f4317d0428d4a40bdf',
    'query:pulse_alert_source_down': 'cb3b7046c58582e0ebf2', 'query:pulse_source_digest': '0e352ff1510afba3311a', alertMissing: 'd5f4317d0428d4a40bdf',
    body: 'b1d2ddac90e6410bb1b1', entityQuery: '44a22cbe6cdca8dea794', sourceQuery: '628f9447e0e85f3d281d', rollupQuery: 'c26b1adc63bbec84e7c1',
    rollupBackfill: '5d584c1ca4604bc6df9f', ledgerAsset: '1a0aa755d60b00be8a32', ledgerSource: '0596ec26f03a97ce2f38', activityQuery: '914362c0afc9efe0b7ba',
    fleetQuery: 'c349cfa1604751c1e97a', gapsQuery: 'e563af2616421ce87db8', gapsCutEdges: '9d9f4a0c9611c64ba50a',
    'activityParts:day': '4d2daa6f2fb759d8b9e4', 'activityParts60:day': '6d625dc1561baa435a38', 'fleetParts:day': '7bb3f84e516b5bb59446', 'gapsParts:day': '9e0f00cf51fbd25d1ba2', 'rollupApplies:day': 'b5bea41b6c623f7c09f1',
    'activityParts:old': '3ba1b7ebb3076db8d512', 'activityParts60:old': '6d625dc1561baa435a38', 'fleetParts:old': 'd9c8083fb39eccaa961a', 'gapsParts:old': 'a47997d7e2d03da68691', 'rollupApplies:old': 'b5bea41b6c623f7c09f1',
    'activityParts:hour': '6135675a2324263b8375', 'activityParts60:hour': '6d625dc1561baa435a38', 'fleetParts:hour': 'fef4c8304337d15c2d7b', 'gapsParts:hour': '71f3af7e30b9a1740324', 'rollupApplies:hour': 'fcbcf165908dd18a9e49',
    'activityParts:short': '6135675a2324263b8375', 'activityParts60:short': '6d625dc1561baa435a38', 'fleetParts:short': 'fef4c8304337d15c2d7b', 'gapsParts:short': '71f3af7e30b9a1740324', 'rollupApplies:short': 'fcbcf165908dd18a9e49',
    historyCutS: 'e13a7d74d8e66c718643',
  },
  off: {
    savedSearches: 'a482b55f91e6f6faefab', 'query:pulse_rollup': 'c26b1adc63bbec84e7c1', 'query:pulse_state': 'fc76a96d71859cdf3f0f',
    'query:pulse_ledger_asset': '3ed0caa4c8398ee3f2bc', 'query:pulse_ledger_source': '826ba4f37d3bdc2608e0', 'query:pulse_alert_missing': 'd5f4317d0428d4a40bdf',
    'query:pulse_alert_source_down': 'cb3b7046c58582e0ebf2', 'query:pulse_source_digest': 'a48c68b76cbde4f2068b', alertMissing: 'd5f4317d0428d4a40bdf',
    body: 'e97ca470cadf222c31df', entityQuery: 'a165777e00d9bcebc211', sourceQuery: '3819b82047475cef5a71', rollupQuery: 'c26b1adc63bbec84e7c1',
    rollupBackfill: '5d584c1ca4604bc6df9f', ledgerAsset: '3ed0caa4c8398ee3f2bc', ledgerSource: '826ba4f37d3bdc2608e0', activityQuery: '914362c0afc9efe0b7ba',
    fleetQuery: 'c349cfa1604751c1e97a', gapsQuery: 'e563af2616421ce87db8', gapsCutEdges: '9d9f4a0c9611c64ba50a',
    'activityParts:day': '6135675a2324263b8375', 'activityParts60:day': '6d625dc1561baa435a38', 'fleetParts:day': 'fef4c8304337d15c2d7b', 'gapsParts:day': '71f3af7e30b9a1740324', 'rollupApplies:day': 'fcbcf165908dd18a9e49',
    'activityParts:old': '6135675a2324263b8375', 'activityParts60:old': '6d625dc1561baa435a38', 'fleetParts:old': 'fef4c8304337d15c2d7b', 'gapsParts:old': '71f3af7e30b9a1740324', 'rollupApplies:old': 'fcbcf165908dd18a9e49',
    'activityParts:hour': '6135675a2324263b8375', 'activityParts60:hour': '6d625dc1561baa435a38', 'fleetParts:hour': 'fef4c8304337d15c2d7b', 'gapsParts:hour': '71f3af7e30b9a1740324', 'rollupApplies:hour': 'fcbcf165908dd18a9e49',
    'activityParts:short': '6135675a2324263b8375', 'activityParts60:short': '6d625dc1561baa435a38', 'fleetParts:short': 'fef4c8304337d15c2d7b', 'gapsParts:short': '71f3af7e30b9a1740324', 'rollupApplies:short': 'fcbcf165908dd18a9e49',
    historyCutS: 'e13a7d74d8e66c718643',
  },
  remind: {
    savedSearches: '4ede68633411a7d73f6f', 'query:pulse_rollup': 'c26b1adc63bbec84e7c1', 'query:pulse_state': '6bcebab0839d06aff227',
    'query:pulse_ledger_asset': 'aaf251b6e24debba9599', 'query:pulse_ledger_source': '1cf3cd091f627769f632', 'query:pulse_alert_missing': 'd5f4317d0428d4a40bdf',
    'query:pulse_alert_source_down': 'cb3b7046c58582e0ebf2', 'query:pulse_source_digest': '0e352ff1510afba3311a', alertMissing: 'd5f4317d0428d4a40bdf',
    body: '694508df80fe233baeb1', entityQuery: 'ba73734fddb62b0e7a14', sourceQuery: 'b36ebc35b3b5e47357c5', rollupQuery: 'c26b1adc63bbec84e7c1',
    rollupBackfill: '5d584c1ca4604bc6df9f', ledgerAsset: 'aaf251b6e24debba9599', ledgerSource: '1cf3cd091f627769f632', activityQuery: '914362c0afc9efe0b7ba',
    fleetQuery: 'c349cfa1604751c1e97a', gapsQuery: 'e563af2616421ce87db8', gapsCutEdges: '9d9f4a0c9611c64ba50a',
    'activityParts:day': '4d2daa6f2fb759d8b9e4', 'activityParts60:day': '6d625dc1561baa435a38', 'fleetParts:day': '7bb3f84e516b5bb59446', 'gapsParts:day': '9e0f00cf51fbd25d1ba2', 'rollupApplies:day': 'b5bea41b6c623f7c09f1',
    'activityParts:old': '3ba1b7ebb3076db8d512', 'activityParts60:old': '6d625dc1561baa435a38', 'fleetParts:old': 'd9c8083fb39eccaa961a', 'gapsParts:old': 'a47997d7e2d03da68691', 'rollupApplies:old': 'b5bea41b6c623f7c09f1',
    'activityParts:hour': '6135675a2324263b8375', 'activityParts60:hour': '6d625dc1561baa435a38', 'fleetParts:hour': 'fef4c8304337d15c2d7b', 'gapsParts:hour': '71f3af7e30b9a1740324', 'rollupApplies:hour': 'fcbcf165908dd18a9e49',
    'activityParts:short': '6135675a2324263b8375', 'activityParts60:short': '6d625dc1561baa435a38', 'fleetParts:short': 'fef4c8304337d15c2d7b', 'gapsParts:short': '71f3af7e30b9a1740324', 'rollupApplies:short': 'fcbcf165908dd18a9e49',
    historyCutS: 'e13a7d74d8e66c718643',
  },
  legacy: {
    savedSearches: 'a482b55f91e6f6faefab', 'query:pulse_rollup': 'c26b1adc63bbec84e7c1', 'query:pulse_state': 'fc76a96d71859cdf3f0f',
    'query:pulse_ledger_asset': '3ed0caa4c8398ee3f2bc', 'query:pulse_ledger_source': '826ba4f37d3bdc2608e0', 'query:pulse_alert_missing': 'd5f4317d0428d4a40bdf',
    'query:pulse_alert_source_down': 'cb3b7046c58582e0ebf2', 'query:pulse_source_digest': 'a48c68b76cbde4f2068b', alertMissing: 'd5f4317d0428d4a40bdf',
    body: 'e97ca470cadf222c31df', entityQuery: 'a165777e00d9bcebc211', sourceQuery: '3819b82047475cef5a71', rollupQuery: 'c26b1adc63bbec84e7c1',
    rollupBackfill: '5d584c1ca4604bc6df9f', ledgerAsset: '3ed0caa4c8398ee3f2bc', ledgerSource: '826ba4f37d3bdc2608e0', activityQuery: '914362c0afc9efe0b7ba',
    fleetQuery: 'c349cfa1604751c1e97a', gapsQuery: 'e563af2616421ce87db8', gapsCutEdges: '9d9f4a0c9611c64ba50a',
    'activityParts:day': '6135675a2324263b8375', 'activityParts60:day': '6d625dc1561baa435a38', 'fleetParts:day': 'fef4c8304337d15c2d7b', 'gapsParts:day': '71f3af7e30b9a1740324', 'rollupApplies:day': 'fcbcf165908dd18a9e49',
    'activityParts:old': '6135675a2324263b8375', 'activityParts60:old': '6d625dc1561baa435a38', 'fleetParts:old': 'fef4c8304337d15c2d7b', 'gapsParts:old': '71f3af7e30b9a1740324', 'rollupApplies:old': 'fcbcf165908dd18a9e49',
    'activityParts:hour': '6135675a2324263b8375', 'activityParts60:hour': '6d625dc1561baa435a38', 'fleetParts:hour': 'fef4c8304337d15c2d7b', 'gapsParts:hour': '71f3af7e30b9a1740324', 'rollupApplies:hour': 'fcbcf165908dd18a9e49',
    'activityParts:short': '6135675a2324263b8375', 'activityParts60:short': '6d625dc1561baa435a38', 'fleetParts:short': 'fef4c8304337d15c2d7b', 'gapsParts:short': '71f3af7e30b9a1740324', 'rollupApplies:short': 'fcbcf165908dd18a9e49',
    historyCutS: 'e13a7d74d8e66c718643',
  },
};

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

/* 1 · Standard is byte-identical */
const got = hashes();
for (const [vn, want] of Object.entries(STANDARD))
  for (const [k, h] of Object.entries(want)) t(`standard ${vn}: ${k} unchanged`, () => got[vn]?.[k] === h || `${got[vn]?.[k]} != ${h}`);
t('the pin covers every output', () => Object.keys(STANDARD).length === Object.keys(variants).length
  && Object.keys(variants).every((vn) => Object.keys(STANDARD[vn]).length === Object.keys(got[vn]).length));

/* 2 · Hourly */
const hourly = { ...base, searchLoad: 'hourly' };
const hs = K.savedSearches(hourly);
const hc = C.cadenceOf('hourly', base.rollCall).crons;
t('hourly: the same seven searches', () => JSON.stringify(hs.map((d) => d.id)) === JSON.stringify(K.savedSearches(base).map((d) => d.id)));
t('hourly: crons from cadenceOf', () => hs.every((d) => d.cron === hc[d.id] && d.enabled !== false));
t('hourly: the Hourly crons', () => JSON.stringify(Object.fromEntries(hs.map((d) => [d.id, d.cron]))) === JSON.stringify({
  pulse_rollup: '3 * * * *', pulse_state: '5 * * * *', pulse_ledger_asset: '7 * * * *', pulse_ledger_source: '7 * * * *',
  pulse_alert_missing: '9 * * * *', pulse_alert_source_down: '9 * * * *', pulse_source_digest: '7 7 * * *' }));
const hr = hs.find((d) => d.id === 'pulse_rollup');
t("hourly: the rollup search's earliest is -130m", () => hr.earliest === '-130m');
t('hourly: the rollup query writes the -130m window', () => hr.query.includes('bin(now() - 7800, 300) + 300') && !hr.query.includes('now() - 1200'));
t('hourly: the backfill still takes its own range', () => K.rollupQuery(hourly, 86400).includes('bin(now() - 86400, 300) + 300'));
const hb = K.body(hourly);
t('hourly: newly_missing window is runEvery 3660', () => /silent_s <= tolerance_s \+ 0 \+ 3660$/.test(hb));
t('hourly: the tail cut is 5100 s', () => hb.includes('bin(now() - 5100, 300)') && !hb.includes('now() - 1800,'));
const hst = hs.find((d) => d.id === 'pulse_state').query;
t('hourly: rollup_ok against maxLagS 4800', () => hst.includes('now() - newest_bucket <= 4800'));
t('hourly: history cut follows the tail', () => K.historyCutS(NOW, 1800, hourly) === Math.floor((NOW - 5100) / 1800) * 1800
  && JSON.stringify(K.activityParts(hourly, 1800, 'g1', windows.day)).includes('bin(now() - 5100, 1800)'));

/* 3 · Daily */
const daily = { ...base, searchLoad: 'daily' };
const ds = K.savedSearches(daily);
const ds7 = ds.filter((d) => d.id !== 'pulse_roll_call');
t('daily: none of the seven is dropped', () => JSON.stringify(ds7.map((d) => d.id)) === JSON.stringify(K.savedSearches(base).map((d) => d.id)) && ds7.length === 7);
t('daily: all seven are enabled false', () => ds7.every((d) => d.enabled === false));
t('daily: pulse_roll_call is the eighth, enabled (F4)', () => ds.length === 8 && ds.filter((d) => d.id === 'pulse_roll_call' && d.enabled !== false).length === 1);
t('daily: each keeps a cron (the Standard one, as a placeholder)', () => ds7.every((d, i) => d.cron === K.savedSearches(base)[i].cron));
t('daily: the readers treat the rollup as off', () => !K.body(daily).includes('pulse_metrics_pq_5m') && !K.rollupOn(daily)
  && !ds.find((d) => d.id === 'pulse_ledger_asset').query.includes('rollup_ok') && !ds.find((d) => d.id === 'pulse_state').query.includes('rollup_ok')
  && K.body(daily).startsWith(K.body({ ...base, rollup: 'off' }).split('\n')[0]));
t('daily: no history reads the rollup', () => K.activityParts(daily, 1800, 'g1', windows.day).mode === 'raw');
t('standard: no enabled:false anywhere', () => K.savedSearches(base).every((d) => d.enabled !== false));

/* 4 · code */
const src = readFileSync(join(root, 'src/lib/kql.ts'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
t('kql.ts imports cadenceOf from ./cadence', () => /import\s*\{[^}]*\bcadenceOf\b[^}]*\}\s*from\s*'\.\/cadence'/.test(src));
t("kql.ts has no '/5' cron literal", () => !/'[^'\n]*\/5 \* \* \* \*'/.test(src) && !/cron:\s*'/.test(src));
t('kql.ts has no RUN_EVERY = 360 literal', () => !/RUN_EVERY\s*=\s*\d/.test(src) && !/\b360\b/.test(src));
t('kql.ts readers use effectiveRollup', () => /effectiveRollup\(s\)/.test(src));

/* 5 · constants */
t('kql.ts exports ROLLUP_SPAN, TAIL_S, ROLLUP_MAX_LAG_S at the Standard values', () => K.ROLLUP_SPAN === 300 && K.TAIL_S === 1800 && K.ROLLUP_MAX_LAG_S === 1500);
t('rollup.ts keeps them too', () => R.ROLLUP_SPAN === 300 && R.TAIL_S === 1800 && R.ROLLUP_MAX_LAG_S === 1500);

/* 6 · rollup.ts: cadence-aware verdict */
const saved = { query: K.rollupQuery(base), schedule: { enabled: true } };
const v = (newestAgo, maxLagS) => R.rollupVerdict({ saved, dataset: base.dataset, newestBucket: NOW - newestAgo, oldestBucket: NOW - 2 * 86400, nowS: NOW, lookbackS: 86400, maxLagS });
t('rollupVerdict: Standard default max lag 1500', () => v(1400).use === true && v(1600).reason === 'behind');
t('rollupVerdict: maxLagS from the Hourly cadence', () => v(4000, C.cadenceOf('hourly').rollup.maxLagS).use === true && v(5000, 4800).reason === 'behind');
t('rollupMaxLagS(load)', () => R.rollupMaxLagS('standard') === 1500 && R.rollupMaxLagS('hourly') === 4800 && R.rollupMaxLagS('daily') === 1500);
t('rollupTailS(load)', () => R.rollupTailS('standard') === 1800 && R.rollupTailS('hourly') === 5100);

/* 7 · rollCallQuery computes today once (F3) */
{
  const rq = K.rollCallQuery(daily);
  const today = K.entityQuery({ ...daily, rollup: 'off', searchLoad: 'daily' });
  t('rollCallQuery: entityQuery text appears once', () => rq.split(today).length === 2);
  t('rollCallQuery: eventstats only_carried then the keep filter', () => {
    const a = rq.indexOf('eventstats only_carried = min(carried) by worker_group, input, asset');
    return a >= 0 && rq.slice(a).split('\n')[1].trim() === '| where carried == 0 or only_carried == 1'.trim() || rq.slice(a).includes('| where carried == 0 or only_carried == 1');
  });
  t('rollCallQuery: reads $vt_results, no leftanti', () => rq.includes('$vt_results') && rq.includes('pulse_roll_call') && !rq.includes('join kind=leftanti'));
  t('rollCallQuery: n_missing totals after the filter', () => rq.indexOf('n_missing = sum(is_miss)') > rq.indexOf('only_carried == 1'));
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('kql-load ok');
