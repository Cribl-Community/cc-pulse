#!/usr/bin/env node
// T3: ack, mute, threshold, reset and maintenance windows show at once, with no entity search.
// (1) src/lib/overrideApply.ts (pure, no React) bundled with esbuild and unit-tested: override → entity row.
// (2) The wiring, read from source: state.tsx exposes applyOverride / applyWindows and re-applies changes newer than a
//     snapshot; Asset.tsx, Overview.tsx and Policies.tsx call them after a successful save, do not refresh or
//     recompute, and their success messages say Pulse's alerts pick the change up in the next cycle.
// Run: node scripts/test-override-apply.mjs   (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules/.tmp-override-apply-bundle.mjs');
const entry = join(root, 'node_modules/.tmp-override-apply-entry.ts');
writeFileSync(entry, "export * from '../src/lib/overrideApply';\nexport { toEntity } from '../src/lib/model';\n");
try {
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm',
    '--log-level=error', '--define:window.CRIBL_API_URL="http://pulse.test/api/v1"', `--outfile=${out}`], { stdio: 'inherit' });
} finally { rmSync(entry, { force: true }); }
const M = await import(`${out}?t=${Date.now()}`);
rmSync(out, { force: true });
const { applyOverride, applyWindows, reapplyPending, stateOf, NEXT_CYCLE, toEntity } = M;

let fail = 0, n = 0;
const ok = (name, cond) => { n++; if (!cond) { fail++; console.log('FAIL', name); } };

const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const NOW = Date.parse('2026-11-19T12:00:00Z'), NOW_S = NOW / 1000;
// expected_gap_s 60 → rule tolerance 300 s; silent 600 s → missing.
const row = (over = {}) => ({ worker_group: 'g1', input: 'in1', asset: 'a1', state: 'missing', raw_state: 'missing', signal: '',
  silent_min: 10, tolerance_s: 300, expected_gap_s: 60, active_min: 100, events: 50, vol_ratio: 1, lag_now_s: 0, min_lag_s: 0,
  maintenance: '', last_seen: NOW_S - 600, ...over });
const k = { input: 'in1', asset: 'a1' };
const ack = (r) => ({ ...k, action: 'ack', max_gap_s: 0, ack_seen: r.last_seen, until: new Date(NOW + 864e5).toISOString() });

// ack → acked; rows it doesn't cover are untouched (same object)
{
  const a = row(), b = row({ asset: 'a2' }), c = row({ input: 'in2' });
  const [x, y, z] = applyOverride([a, b, c], ack(a), L, NOW);
  ok('ack: missing → acked', x.state === 'acked' && x.raw_state === 'missing' && x.tolerance_s === 300);
  ok('ack: another asset is untouched', y === b);
  ok('ack: same asset on another input is untouched', z === c);
  const late = row({ state: 'late', raw_state: 'late', silent_min: 4 });
  ok('ack: late → acked', applyOverride([late], ack(late), L, NOW)[0].state === 'acked');
  const up = row({ state: 'ok', raw_state: 'ok', silent_min: 1 });
  ok('ack on a reporting asset changes nothing (KQL: acked only while missing/late)', applyOverride([up], ack(up), L, NOW)[0].state === 'ok');
}
// overrides are keyed by input + asset: every worker group's row changes
{
  const rows = applyOverride([row(), row({ worker_group: 'g2' })], { ...k, action: 'mute', max_gap_s: 0 }, L, NOW);
  ok('mute: both worker groups muted', rows.every((r) => r.state === 'muted'));
}
// mute → muted, also from ok; an expired mute does nothing; maintenance still wins (KQL order)
{
  ok('mute: missing → muted', applyOverride([row()], { ...k, action: 'mute', max_gap_s: 0 }, L, NOW)[0].state === 'muted');
  ok('mute 4 h: ok → muted', applyOverride([row({ state: 'ok', raw_state: 'ok', silent_min: 1 })], { ...k, action: 'mute', max_gap_s: 0, until: new Date(NOW + 4 * 36e5).toISOString() }, L, NOW)[0].state === 'muted');
  ok('mute with an until in the past is off', applyOverride([row()], { ...k, action: 'mute', max_gap_s: 0, until: new Date(NOW - 1000).toISOString() }, L, NOW)[0].state === 'missing');
  ok('mute in a maintenance window stays maintenance', applyOverride([row({ state: 'maintenance', maintenance: 'patch' })], { ...k, action: 'mute', max_gap_s: 0 }, L, NOW)[0].state === 'maintenance');
}
// unmute / reset → the learned rule from the row's own fields
{
  const muted = row({ state: 'muted' });
  ok('unmute: muted → missing (raw state)', applyOverride([muted], { ...k, remove: true }, L, NOW)[0].state === 'missing');
  const acked = row({ state: 'acked' });
  ok('remove acknowledgement: acked → missing', applyOverride([acked], { ...k, remove: true }, L, NOW)[0].state === 'missing');
  const thr = row({ state: 'ok', raw_state: 'ok', tolerance_s: 1200 });
  const r = applyOverride([thr], { ...k, remove: true }, L, NOW)[0];
  ok('reset: tolerance back to the rule (3 × 60 s, raised to 300 s)', r.tolerance_s === 300);
  ok('reset: state from the rule tolerance (600 s silent > 300 s → missing)', r.state === 'missing' && r.raw_state === 'missing');
  ok('reset: entity no longer overridden', toEntity(r, L).overridden === false && toEntity(thr, L).overridden === true);
  const quiet = row({ state: 'muted', raw_state: 'ok', silent_min: 1 });
  ok('unmute: a reporting asset goes back to ok', applyOverride([quiet], { ...k, remove: true }, L, NOW)[0].state === 'ok');
}
// threshold → the new tolerance and the state it implies
{
  const t1 = applyOverride([row()], { ...k, action: 'threshold', max_gap_s: 1200 }, L, NOW)[0];
  ok('threshold 1200 s: 600 s silent → ok', t1.tolerance_s === 1200 && t1.raw_state === 'ok' && t1.state === 'ok');
  ok('threshold: entity shows the override', toEntity(t1, L).overridden === true && toEntity(t1, L).tolerance_s === 1200);
  const t2 = applyOverride([row()], { ...k, action: 'threshold', max_gap_s: 900 }, L, NOW)[0];
  ok('threshold 900 s: 600 s silent > 0.6 × 900 → late', t2.state === 'late');
  const t3 = applyOverride([row({ state: 'ok', raw_state: 'ok', silent_min: 6 })], { ...k, action: 'threshold', max_gap_s: 300 }, L, NOW)[0];
  ok('threshold 300 s on an asset at the rule tolerance keeps its row state', t3.state === 'ok');
  const t4 = applyOverride([row({ state: 'ok', raw_state: 'ok', silent_min: 1, tolerance_s: 1200 })], { ...k, action: 'threshold', max_gap_s: 120 }, L, NOW)[0];
  ok('threshold 120 s: 60 s silent → ok (no clamp on an override)', t4.tolerance_s === 120 && t4.state === 'ok');
  const t5 = applyOverride([row({ silent_min: 1, state: 'ok', raw_state: 'ok', tolerance_s: 1200, lag_now_s: 1000 })], { ...k, action: 'threshold', max_gap_s: 600 }, L, NOW)[0];
  ok('threshold: a lagging reporting asset is delayed', t5.signal === 'delayed' && t5.state === 'delayed');
  const t6 = applyOverride([row({ active_min: 5, state: 'learning', raw_state: 'learning', tolerance_s: 1200 })], { ...k, action: 'threshold', max_gap_s: 60 }, L, NOW)[0];
  ok('threshold: a learning asset stays learning', t6.state === 'learning');
  ok('the input row is not mutated', row().state === 'missing' && stateOf(row(), L, undefined, NOW) !== undefined);
}
// maintenance windows apply the same way to the assets they cover
{
  const w = (scope, over = {}) => ({ id: scope, scope, start: NOW_S - 60, end: NOW_S + 3600, reason: `mw ${scope}`, ...over });
  const rows = [row(), row({ worker_group: 'g2', asset: 'a2' }), row({ worker_group: 'g2', input: 'in2', asset: 'a3', state: 'ok', raw_state: 'ok', silent_min: 1 })];
  const all = applyWindows(rows, [w('*')], [], L, NOW);
  ok('window *: every asset in maintenance with its reason', all.every((r) => r.state === 'maintenance' && r.maintenance === 'mw *'));
  const grp = applyWindows(rows, [w('g:g2')], [], L, NOW);
  ok('window g:g2: covers g2 only', grp[0] === rows[0] && grp[1].state === 'maintenance' && grp[2].state === 'maintenance');
  const src = applyWindows(rows, [w('*'), w('i:g2|in2')], [], L, NOW);
  ok('the most specific window wins', src[2].maintenance === 'mw i:g2|in2' && src[0].maintenance === 'mw *');
  const later = applyWindows(rows, [w('*', { start: NOW_S + 3600, end: NOW_S + 7200 })], [], L, NOW);
  ok('a scheduled window does not apply yet', later.every((r, i) => r === rows[i]));
  const inMw = [row({ state: 'maintenance', maintenance: 'mw *' }), row({ asset: 'a9', state: 'maintenance', maintenance: 'mw *' })];
  const ended = applyWindows(inMw, [w('*', { end: NOW_S })], [{ input: 'in1', asset: 'a9', action: 'mute', max_gap_s: 0 }], L, NOW);
  ok('window ended: back to the learned rule', ended[0].state === 'missing' && ended[0].maintenance === '');
  ok('window ended: an asset with a mute override is muted', ended[1].state === 'muted');
}
// a snapshot older than the change gets it re-applied; a newer one already has it
{
  const p = [{ kind: 'override', change: { ...k, action: 'mute', max_gap_s: 0 }, atS: NOW_S - 30 }];
  const old = reapplyPending([row()], p, NOW_S - 300, L, NOW);
  ok('older snapshot: change re-applied and kept pending', old.rows[0].state === 'muted' && old.pending.length === 1);
  const fresh = reapplyPending([row()], p, NOW_S, L, NOW);
  ok('newer snapshot: rows as they are, change dropped', fresh.rows[0].state === 'missing' && fresh.pending.length === 0);
  const pw = [{ kind: 'windows', windows: [{ id: 'x', scope: '*', start: NOW_S - 60, end: NOW_S + 60, reason: 'patch' }], overrides: [], atS: NOW_S - 30 }];
  ok('older snapshot: window re-applied', reapplyPending([row()], pw, NOW_S - 300, L, NOW).rows[0].state === 'maintenance');
}
ok('NEXT_CYCLE names the next cycle and 5 minutes', /next cycle/.test(NEXT_CYCLE) && /5 minutes/.test(NEXT_CYCLE) && /Pulse/.test(NEXT_CYCLE));

// (2) wiring, from source (comments stripped)
const read = (p) => readFileSync(join(root, p), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const state = read('src/state.tsx');
ok('state.tsx: Ctx has applyOverride and applyWindows', /applyOverride: \(change: OverrideChange\) => void/.test(state) && /applyWindows: \(windows: Window\[\]\) => Promise<void>/.test(state));
ok('state.tsx: both are in the provider value', /computing, applyOverride, applyWindows,/.test(state));
const fnBody = (src, name) => { const i = src.indexOf(`const ${name} = useCallback(`); return i < 0 ? '' : src.slice(i, src.indexOf('}, [', i)); };
const ao = fnBody(state, 'applyOverride'), aw = fnBody(state, 'applyWindows');
ok('state.tsx applyOverride patches the entities with the lib function', /setEntities\(\(rows\) => overrideRows\(rows, change/.test(ao));
ok('state.tsx applyWindows patches the entities with the lib function', /setEntities\(\(rows\) => windowRows\(rows, list/.test(aw));
ok('state.tsx: neither runs a search or a refresh', ![ao, aw].some((b) => /computeEntities|runSearch|run\(|refresh\(/.test(b)) && ao && aw);
ok('state.tsx: a used snapshot re-applies pending changes', /reapplyPending\(rows, pending\.current, v\.asOf/.test(state));

const asset = read('src/pages/Asset.tsx');
const act = asset.slice(asset.indexOf('async function act('), asset.indexOf('return (', asset.indexOf('async function act(')));
ok('Asset.tsx: act applies the change after setOverride succeeds', /await setOverride\(change\);\s*applyOverride\(change\);/.test(act));
ok('Asset.tsx: act no longer refreshes or recomputes', !/refresh\(|computeNow/.test(act));
ok('Asset.tsx: success message adds NEXT_CYCLE', /\$\{NEXT_CYCLE\}/.test(act));
const ov = read('src/pages/Overview.tsx');
const doAck = ov.slice(ov.indexOf('async function doAck('), ov.indexOf('if (setup ===', ov.indexOf('async function doAck(')));
ok('Overview.tsx: ack applies after setOverride', /await setOverride\(change\);\s*pulse\.applyOverride\(change\);/.test(doAck));
ok('Overview.tsx: ack no longer refreshes', !/refresh\(|computeNow/.test(doAck) && /\$\{NEXT_CYCLE\}/.test(doAck));
const pol = read('src/pages/Policies.tsx');
const save = pol.slice(pol.indexOf('async function save('), pol.indexOf('const startOf'));
ok('Policies.tsx: windows applied after save', /saveWindows\(next\)[\s\S]*await applyWindows\(saved\)/.test(save));
ok('Policies.tsx: save no longer refreshes', !/refresh\(|computeNow/.test(save) && /\$\{NEXT_CYCLE\}/.test(save));
ok('overrideApply.ts has no React', !/from 'react'/.test(readFileSync(join(root, 'src/lib/overrideApply.ts'), 'utf8')));

console.log(fail ? `${fail} failure(s)` : `override apply OK (${n} checks)`);
process.exit(fail ? 1 : 0);
