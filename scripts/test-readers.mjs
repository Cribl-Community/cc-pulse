// Spec 034: table-driven checks on the query text of savedSearches(s), in raw and rollup mode.
// Run: node scripts/test-readers.mjs   (bundles src/lib/kql.ts with esbuild; `npm test` runs it via test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-readers-'));
const bundle = (src, out) => {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
  return import(join(tmp, out));
};
const K = await bundle('src/lib/kql.ts', 'k.mjs');
const R = await bundle('src/lib/rollup.ts', 'r.mjs');

const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const MODES = {
  raw: { dataset: 'pulse_metrics', learning: L, rollup: 'off' },
  rollup: { dataset: 'pulse_metrics', learning: L, rollup: 'auto' },
};
// Must match ENTITY_COLS in src/lib/kql.ts (the columns the app and the readers use).
const ENTITY_COLS = ['worker_group', 'input', 'asset', 'state', 'raw_state', 'signal', 'newly_missing', 'silent_min', 'tolerance_s', 'expected_gap_s',
  'active_min', 'events', 'events_1h', 'vol_ratio', 'bytes', 'max_lag_s', 'lag_now_s', 'min_lag_s', 'key_src', 'maintenance', 'criticality', 'team',
  'cluster', 'cluster_min', 'last_seen_utc', 'last_seen'];

const query = (s, id) => K.savedSearches(s).find((x) => x.id === id)?.query ?? '';
/** Columns of the last `| project a, b, …` in a query (later stages only extend or drop rk/newest_bucket). */
const projected = (q) => { const m = [...q.matchAll(/\| project ([^\n]+)/g)].pop(); return m ? m[1].split(',').map((c) => c.trim()) : []; };
const lagExpr = `rollup_ok = isnotnull(newest_bucket) and now() - newest_bucket <= ${R.ROLLUP_MAX_LAG_S}`;

// [mode(s), description, check(s, q) → true]
const checks = [
  [['raw', 'rollup'], 'pulse_state contains body(s)', (s, q) => q.includes(K.body(s))],
  [['raw', 'rollup'], 'pulse_state projects every ENTITY_COLS column', (s, q) => ENTITY_COLS.every((c) => projected(q).includes(c))],
  [['raw', 'rollup'], 'pulse_state stamps computed_at', (s, q) => /\| extend computed_at = now\(\)$/.test(q)],
  [['raw', 'rollup'], 'pulse_state has no where rollup_ok filter (keeps every row)', (s, q) => !/where\s+rollup_ok/.test(q)],
  [['raw', 'rollup'], 'pulse_state starts with entityQuery(s)', (s, q) => q.startsWith(K.entityQuery(s))],
  [['raw'], 'raw: pulse_state is entityQuery + computed_at, unchanged', (s, q) => q === `${K.entityQuery(s)}\n| extend computed_at = now()`],
  [['raw'], 'raw: pulse_state has no rollup_ok and no rollup read', (s, q) => !/rollup_ok|_5m/.test(q)],
  [['rollup'], 'rollup: pulse_state computes rollup_ok against ROLLUP_MAX_LAG_S', (s, q) => q.includes(lagExpr)],
  [['rollup'], 'rollup: newest_bucket comes from one summarize of the rollup', (s, q) =>
    (q.match(/summarize newest_bucket=max\(bucket\)/g) || []).length === 1 && /join kind=leftouter \(dataset="pulse_metrics_5m"\n\s*\| summarize newest_bucket=max\(bucket\)/.test(q)],
  [['rollup'], 'rollup: rollup_ok is kept in the output (helper columns dropped)', (s, q) => /\| project-away rk, newest_bucket\n/.test(q) && !/project-away[^\n]*rollup_ok/.test(q)],
];

const START = 'dataset="$vt_results" | where jobName == "pulse_state"';
const ALERT_START = (kind) => `dataset="$vt_results" | where jobName == "pulse_ledger_${kind}"`;
const missing = [
  [['raw', 'rollup'], 'alert_missing has no body(s) and no heartbeat dataset', (s, q) => !q.includes(K.body(s)) && !/s\.dataset|pulse_metrics|_5m|pulse\.heartbeat/.test(q) && !q.includes(`dataset="${s.dataset}"`)],
  [['raw', 'rollup'], 'alert_missing starts with $vt_results/pulse_ledger_asset', (s, q) => q.startsWith(ALERT_START('asset'))],
  [['raw', 'rollup'], 'alert_missing reads ledger latest run', (s, q) => {
    const i = q.indexOf('pulse_ledger_asset');
    const head = q.slice(i, i + 280);
    return head.includes('eventstats mx = max(computed_at)') && head.includes('computed_at == mx') && !q.includes('computed_at >= now() - 300');
  }],
  [['raw', 'rollup'], 'alert_missing keeps only the four lifecycle events', (s, q) => q.includes('where event in ("opened", "resolved", "reminder", "expired")')],
  [['raw', 'rollup'], 'alert_missing leftanti-joins its own earlier runs on (incident_id, event)', (s, q) =>
    q.includes('join kind=leftanti (dataset="$vt_results" | where jobName == "pulse_alert_missing" | project incident_id, event) on incident_id, event') && q.includes('alerted_at = now()')],
  [['raw', 'rollup'], 'alert_missing no longer reads pulse_state or newly_missing', (s, q) => !/pulse_state|newly_missing/.test(q)],
  [['raw', 'rollup'], 'alert_missing keeps sort by criticality', (s, q) => /\| sort by (__pad asc, )?criticality/.test(q)],
  [['raw', 'rollup'], 'alert_missing keeps event, state, incident_id', (s, q) => /extend state = iff\(event in \("opened", "reminder"\), "firing", "resolved"\)/.test(q) && /incident_id_s = /.test(q)],
  [['raw', 'rollup'], 'alert_missing is under 4000 characters', (s, q) => q.length < 4000 || `length ${q.length}`],
  [['raw', 'rollup'], 'alert_missing has no rollupGuard helpers', (s, q) => !/newest_bucket|\brk\b|project-away (?!__pad)/.test(q)],
  [['raw'], 'raw: alert_missing has no rollup_ok', (s, q) => !/rollup_ok/.test(q)],
  [['rollup'], 'rollup: alert_missing has no rollup_ok filter (the writer has it)', (s, q) => !/rollup_ok/.test(q)],
];

const down = [
  [['raw', 'rollup'], 'source_down has no body(s) and no heartbeat dataset', (s, q) => !q.includes(K.body(s)) && !/s\.dataset|pulse_metrics|_5m|pulse\.heartbeat/.test(q) && !q.includes(`dataset="${s.dataset}"`)],
  [['raw', 'rollup'], 'source_down starts with $vt_results/pulse_ledger_source', (s, q) => q.startsWith(ALERT_START('source'))],
  [['raw', 'rollup'], 'source_down reads ledger latest run', (s, q) => {
    const i = q.indexOf('pulse_ledger_source');
    const head = q.slice(i, i + 280);
    return head.includes('eventstats mx = max(computed_at)') && head.includes('computed_at == mx') && !q.includes('computed_at >= now() - 300');
  }],
  [['raw', 'rollup'], 'source_down keeps only the four lifecycle events', (s, q) => q.includes('where event in ("opened", "resolved", "reminder", "expired")')],
  [['raw', 'rollup'], 'source_down leftanti-joins its own earlier runs on (incident_id, event)', (s, q) =>
    q.includes('join kind=leftanti (dataset="$vt_results" | where jobName == "pulse_alert_source_down" | project incident_id, event) on incident_id, event') && q.includes('alerted_at = now()')],
  [['raw', 'rollup'], 'source_down no longer reads pulse_state or newly_missing', (s, q) => !/pulse_state|newly_missing|\bnewly\b/.test(q)],
  [['raw', 'rollup'], 'source_down is under 4000 characters', (s, q) => q.length < 4000 || `length ${q.length}`],
  [['raw', 'rollup'], 'source_down has no rollupGuard helpers', (s, q) => !/newest_bucket|\brk\b/.test(q)],
  [['raw', 'rollup'], 'source_down keeps output columns', (s, q) => /extend pct = /.test(q) && /missing_s = /.test(q) && /crit_min = coalesce\(crit_min, 3\)/.test(q) && /teams_j = /.test(q)],
  [['raw'], 'raw: source_down has no rollup_ok', (s, q) => !/rollup_ok/.test(q)],
  [['rollup'], 'rollup: source_down has no rollup_ok filter (the writer has it)', (s, q) => !/rollup_ok/.test(q)],
];

const digest = [
  [['raw', 'rollup'], 'digest has no body(s) and no heartbeat dataset', (s, q) => !q.includes(K.body(s)) && !/s\.dataset|pulse_metrics|_5m|pulse\.heartbeat/.test(q) && !q.includes(`dataset="${s.dataset}"`)],
  [['raw', 'rollup'], 'digest starts with $vt_results/pulse_state and filters computed_at', (s, q) => q.startsWith(`${START} | where computed_at >= now() - 300`)],
  [['raw', 'rollup'], 'digest keeps missing > 0 or signals > 0', (s, q) => q.includes('| where missing > 0 or signals > 0')],
  [['raw', 'rollup'], 'digest keeps output columns', (s, q) => /expected = countif/.test(q) && /signal_list = values\(signal_asset\)/.test(q) && /extend signals_s =/.test(q)],
  [['raw', 'rollup'], 'digest is under 4000 characters', (s, q) => q.length < 4000 || `length ${q.length}`],
  [['raw', 'rollup'], 'digest has no rollupGuard helpers', (s, q) => !/newest_bucket|\brk\b/.test(q)],
  [['raw'], 'raw: digest has no rollup_ok', (s, q) => !/rollup_ok/.test(q)],
  [['rollup'], 'rollup: digest filters where rollup_ok', (s, q) => /\n\| where rollup_ok\n/.test(q)],
];

let fail = 0, n = 0;
for (const [id, list] of [['pulse_state', checks], ['pulse_alert_missing', missing], ['pulse_alert_source_down', down], ['pulse_source_digest', digest]]) {
  for (const [modes, msg, fn] of list) {
    for (const m of modes) {
      n++;
      let r; try { r = fn(MODES[m], query(MODES[m], id)); } catch (e) { r = `threw ${e.message}`; }
      if (r !== true) { fail++; console.log(`FAIL [${m}] ${msg}`, r === false ? '' : r); }
    }
  }
}
// Whole plan: every saved search, in both modes.
const HEAVY = ['pulse_state', 'pulse_rollup'];
const offsetOf = (cron) => { const m = /^(\d+)(?:-59\/5)?\s/.exec(cron) || (/^\*\/5\s/.test(cron) ? [0, '0'] : null); return m ? Number(m[1]) % 5 : NaN; };
const EXPECT = { pulse_state: '*/5 * * * *', pulse_ledger_asset: '2-59/5 * * * *', pulse_ledger_source: '2-59/5 * * * *',pulse_alert_missing: '4-59/5 * * * *', pulse_alert_source_down: '4-59/5 * * * *', pulse_source_digest: '7 * * * *', pulse_rollup: '3-59/5 * * * *' };
for (const [m, s] of Object.entries(MODES)) {
  const all = K.savedSearches(s);
  const chk = (ok, msg) => { n++; if (ok !== true) { fail++; console.log(`FAIL [${m}] plan: ${msg}`, ok || ''); } };
  for (const [id, cron] of Object.entries(EXPECT)) { const x = all.find((y) => y.id === id); if (x) chk(x.cron === cron, `${id} cron is ${cron}`); }
  const bodyCount = all.filter((x) => x.query.includes(K.body(s))).map((x) => x.id);
  chk(bodyCount.length === 1 && bodyCount[0] === 'pulse_state', 'body(s) appears only in pulse_state');
  chk((all.find((x) => x.id === 'pulse_state')?.query.split(K.body(s)).length ?? 0) === 2, 'body(s) appears exactly once');
  for (const x of all) {
    const heavy = HEAVY.includes(x.id);
    const touches = x.query.includes(`dataset="${s.dataset}"`) || x.query.includes(`${s.dataset}_5m`) || /\bs\.dataset\b/.test(x.query);
    chk(heavy || !touches, `${x.id} does not read the heartbeat dataset or rollup`);
    if (!heavy) {
      chk(/^dataset="\$vt_results" \| where jobName == "pulse_/.test(x.query), `${x.id} starts with $vt_results reader`);
      chk(x.query.length < 4000, `${x.id} under 4000 chars`);
      const o = offsetOf(x.cron);
      chk(x.id === 'pulse_source_digest' || (o >= 2 && o <= 4), `${x.id} reader offset 2-4 (${x.cron})`);
    }
  }
  const offs = all.filter((x) => HEAVY.includes(x.id)).map((x) => offsetOf(x.cron));
  chk(new Set(offs).size === offs.length, 'heavy searches do not share an offset');
}
console.log(fail ? `readers: ${fail} failure(s)` : `readers OK (${n} checks)`);
process.exit(fail ? 1 : 0);
