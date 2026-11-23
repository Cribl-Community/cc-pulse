// Spec 026 §1: the rollup is lossless for gaps and summaries (src/lib/rollup.ts), on seeded random data.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rollup-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/rollup.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'r.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const R = await import(join(tmp, 'r.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

t('constants', () => R.ROLLUP_SPAN === 300 && R.TAIL_S === 1800 && R.ROLLUP_MAX_LAG_S === 1500);
t('rollupDataset', () => R.rollupDataset('x') === 'x_5m');

let seed = 20261112;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const t0 = 1_800_000_000 - (1_800_000_000 % 86400);
const rows = [];
for (let e = 0; e < 200; e++) {
  const g = `g${e % 3}`, i = `in_${e % 7}`, a = `a${e}`, style = e % 6;
  // 0 steady; 1 quiet hours; 2 coin flip (silences inside one bucket); 3 single-minute blips; 4 long outage; 5 steady, 2 processes
  for (let m = 0; m < 2 * 1440; m++) {
    const hour = Math.floor(m / 60) % 24;
    const p = style === 0 ? 0.97 : style === 1 ? (hour < 7 ? 0.03 : 0.9) : style === 2 ? 0.5 : style === 3 ? (m % 17 === 0 ? 1 : 0.01) : style === 4 ? (hour >= 13 && hour < 19 ? 0 : 0.95) : 0.95;
    if (rnd() >= p) continue;
    const n = style === 5 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const off = (m * 7 + e * 3 + k * 11) % 50; // exact seconds inside the minute, without touching the seeded stream
      rows.push({ worker_group: g, input: i, asset: a, minute: t0 + m * 60, ev: 1 + Math.floor(rnd() * 50), bytes: 100 + k, lag_s: Math.floor(rnd() * 30), asset_src: 1, first_s: t0 + m * 60 + off, last_s: t0 + m * 60 + off + 9 });
    }
  }
}
rows.push(...rows.splice(0, 1000).reverse());

const buckets = R.rollupOf(rows);
const gm = R.gapsFromMinutes(rows);
t('rollup is smaller than minutes', () => buckets.length > 0 && buckets.length < rows.length);
t('columns', () => ['worker_group', 'input', 'asset', 'bucket', 'events', 'bytes', 'active_min', 'first_min', 'last_min', 'first_s', 'last_s', 'in_gap_start', 'in_gap_end', 'max_lag_s', 'min_lag_s', 'asset_src', 'written_at'].every((k) => k in buckets[0]));
t('buckets on grid', () => buckets.every((b) => b.bucket % 300 === 0 && b.active_min >= 1 && b.active_min <= 5 && b.first_min >= b.bucket && b.last_min < b.bucket + 300));
t('fixture has silences inside one bucket', () => gm.some((x) => x.gap_s > 120 && x.gap_s < 300) && buckets.some((b) => b.in_gap_start !== null));
t('fixture has silences across many buckets', () => gm.some((x) => x.gap_s >= 3600));
t('fixture has quiet hours', () => gm.some((x) => x.gap_s >= 5 * 3600));
t('fixture has single-minute blips', () => buckets.some((b) => b.active_min === 1 && b.first_min === b.last_min));
t('gapsFromRollup deep-equals gapsFromMinutes', () => { deepStrictEqual(R.gapsFromRollup(buckets), gm); return true; });
const sm = R.summaryFromMinutes(rows);
t('200 entities', () => sm.length === 200);
t('summaryFromRollup deep-equals summaryFromMinutes', () => { deepStrictEqual(R.summaryFromRollup(buckets), sm); return true; });
t('summary first_s / last_s are exact seconds, not minutes', () => sm.every((x) => x.first_s >= x.first_min && x.first_s < x.first_min + 60 && x.last_s >= x.last_min && x.last_s < x.last_min + 60)
  && sm.some((x) => x.first_s % 60 !== 0) && sm.some((x) => x.last_s % 60 !== 0));
t('bucket first_s / last_s inside the bucket', () => buckets.every((b) => b.first_s >= b.bucket && b.last_s < b.bucket + 300 && b.first_s <= b.last_s));

// rollupVerdict
const NOW = 1_800_000_000, LB = 86400, DS = 'pulse_metrics';
const good = { query: `dataset="${DS}" | summarize x=count() by bin(_time, 5m) | export to lake ${DS}_5m`, schedule: { enabled: true } };
const v = (o) => R.rollupVerdict({ saved: good, dataset: DS, newestBucket: NOW - 300, oldestBucket: NOW - LB, nowS: NOW, lookbackS: LB, ...o });
const is = (o, reason) => { const r = v(o); return reason ? r.use === false && r.reason === reason : r.use === true; };
t('verdict no-search', () => is({ saved: undefined }, 'no-search'));
t('verdict disabled', () => is({ saved: { ...good, schedule: { enabled: false } } }, 'disabled'));
t('verdict other-dataset', () => is({ saved: { ...good, query: good.query.replaceAll(DS, 'other') } }, 'other-dataset'));
t('verdict other-dataset: reads another dataset but exports to <dataset>_5m', () => is({ saved: { ...good, query: good.query.replace(`dataset="${DS}"`, 'dataset="other"') } }, 'other-dataset'));
t('verdict wrong-target', () => is({ saved: { ...good, query: `dataset="${DS}" | export to lake elsewhere` } }, 'wrong-target'));
t('verdict empty', () => is({ newestBucket: undefined }, 'empty'));
t('verdict behind', () => is({ newestBucket: NOW - 1501 }, 'behind'));
t('verdict lag 1500 is not behind', () => is({ newestBucket: NOW - 1500 }));
t('verdict not-backfilled', () => is({ oldestBucket: NOW - LB + 601 }, 'not-backfilled'));
t('verdict backfill boundary', () => is({ oldestBucket: NOW - LB + 600 }));
t('verdict use', () => is({}));
t('verdict order: disabled beats empty', () => is({ saved: { ...good, schedule: {} }, newestBucket: undefined }, 'disabled'));

// F4: rollupQuery and the pulse_rollup saved search
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));
for (const ds of ['pulse_metrics', 'my_custom_ds']) {
  const st = { dataset: ds, learning: { LOOKBACK: '-24h', K: 3, MIN_GAP: 120, MAX_GAP: 3600, MIN_ACTIVE: 5, GRACE: 0 } };
  const q = K.rollupQuery(st);
  t(`rollupQuery exports to ${ds}_5m`, () => q.trimEnd().endsWith(`| export to lake ${ds}_5m`));
  t(`rollupQuery closed bounds ${ds}`, () => q.includes('bin(now() - 1200, 300) + 300') && q.includes('bin(now(), 300) - 300'));
  t(`rollupQuery reads ${ds}`, () => q.includes(`dataset="${ds}"`) && q.includes('prev(') && q.includes('written_at = now(), _time = bucket'));
  t(`rollupQuery writes exact first_s / last_s ${ds}`, () => q.includes('t_first=min(_time), t_last=max(_time) by worker_group, input, asset, bucket, minute') && q.includes('first_s=min(t_first), last_s=max(t_last)'));
  const p = K.savedSearches(st).find((x) => x.id === 'pulse_rollup');
  t(`pulse_rollup ${ds}`, () => p && p.cron === '3-59/5 * * * *' && p.earliest === '-20m' && p.latest === 'now' && !p.notify && p.query === q);
}

// F5: body() in rollup mode, the off-mode snapshot, and the rollup_ok guard
{
  const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
  const snap = readFileSync(join(root, 'scripts/fixtures/body-off.kql'), 'utf8'); // captured from body() before F5
  const off = { dataset: 'pulse_metrics', learning: L, rollup: 'off' }, auto = { ...off, rollup: 'auto' };
  const bOff = K.body(off), bAuto = K.body(auto);
  t('body off is byte-identical to the pre-F5 snapshot', () => bOff === snap);
  t('body without a rollup field reads raw (same as off)', () => K.body({ dataset: 'pulse_metrics', learning: L }) === snap);
  t('body off reads only the raw dataset', () => !/_5m|\bunion\b|arg_max/.test(bOff));
  const cut = 'bin(now() - 1800, 300)';
  const [head, tail] = bAuto.split('| union (');
  t('body auto reads the deduped rollup up to the cut', () => head.startsWith('dataset="pulse_metrics_5m"') && head.includes(`| where bucket < ${cut}`)
    && head.includes('summarize events=max(events), bytes=max(bytes), active_min=max(active_min), first_min=min(first_min), last_min=max(last_min),') && /written_at=max\(written_at\)\n\s*by worker_group, input, asset, bucket/.test(head));
  t('no KQL the org rejects (arg_max, max_by, take_any(*), mv-expand of a dynamic literal; probed 2026-11-13)', () => {
    const all = [bAuto, ...K.savedSearches(auto).map((x) => x.query)].join('\n');
    return !/arg_max|max_by|take_any\(\*\)|mv-expand/.test(all);
  });
  t('body auto unions the raw tail from the cut', () => tail !== undefined && tail.startsWith('dataset="pulse_metrics" _metric=="pulse.heartbeat"') && tail.includes(`| where _time >= ${cut}`));
  const tailLeg = tail.slice(0, tail.indexOf('by worker_group, input, asset, bucket)'));
  const after = tail.slice(tail.indexOf('by worker_group, input, asset, bucket)'));
  t('body auto: dcount(minute) only inside the raw tail, per entity and bucket', () => (bAuto.match(/dcount\(/g) || []).length === 1 && tailLeg.includes('active_min=dcount(minute)'));
  t('body auto: no dcount after the union, active_min summed', () => !/dcount\(/.test(after) && /summarize[\s\S]*active_min=sum\(active_min\)[\s\S]*by worker_group, input, asset\n/.test(after));
  t('body auto: lag_now_s from the last 15 min of the tail, events_1h from tail + rollup', () => tailLeg.includes('lag_now_s=maxif(event_lag_s, _time > now() - 900)')
    && !head.includes('lag_now_s') && head.includes('events_1h = iff(bucket > now() - 3600, events, 0)') && after.includes('events_1h=sum(events_1h)'));
  t('body auto: first_seen / last_seen from the exact rollup seconds', () => head.includes('first_seen = coalesce(first_s, first_min), last_seen = coalesce(last_s, last_min)'));
  const from = (b, m) => b.slice(b.indexOf(m));
  t('text after | lookup pulse_overrides is the same in both modes', () => bOff.includes('| lookup pulse_overrides') && from(bOff, '| lookup pulse_overrides') === from(bAuto, '| lookup pulse_overrides'));
  t('text after the head summarize is the same in both modes', () => from(bOff, '| extend silent_raw') === from(bAuto, '| extend silent_raw'));
  const alerts = (st) => K.savedSearches(st).filter((x) => ['pulse_alert_missing', 'pulse_alert_source_down', 'pulse_source_digest'].includes(x.id));
  // Spec 034: every alert reads pulse_state's rollup_ok through $vt_results.
  // Spec 030 F5: the two alert searches read the ledger writers (which filter on rollup_ok), not pulse_state.
  t('alert searches in rollup mode filter on pulse_state rollup_ok', () => alerts(auto).length === 3 && alerts(auto).filter((x) => x.id === 'pulse_source_digest').every((x) =>
    x.query.startsWith('dataset="$vt_results"') && x.query.includes('\n| where rollup_ok\n') && !/_5m|newest_bucket/.test(x.query)));
  t('alert searches in off mode have no rollup_ok guard', () => alerts(off).length === 3 && alerts(off).every((x) => !/rollup_ok|_5m/.test(x.query)));
  // Spec 034 §1: pulse_state outputs rollup_ok as a column but keeps every row (its readers filter on it).
  t('pulse_state has no rollup_ok filter', () => !/where\s+rollup_ok/.test(K.savedSearches(auto).find((x) => x.id === 'pulse_state').query));
  t('pulse_state in off mode has no rollup_ok', () => !/rollup_ok/.test(K.savedSearches(off).find((x) => x.id === 'pulse_state').query));
}

// F6: history queries in rollup mode
{
  const base = { dataset: 'pulse_metrics', learning: { LOOKBACK: '-24h' } };
  const off = { ...base, rollup: 'off' }, auto = { ...base, rollup: 'auto' };
  const NOW = 1_800_000_000, H = 3600;
  const cutS = Math.floor((NOW - 1800) / 1800) * 1800; // aligned for every span used below
  const long = { earliestS: NOW - 24 * H, latestS: cutS, nowS: NOW }; // ends at the cut
  const live = { earliestS: NOW - 24 * H, latestS: NOW, nowS: NOW };
  const short = { earliestS: NOW - H, latestS: NOW, nowS: NOW };
  const rawOf = { gaps: K.gapsQuery(auto), act: K.activityQuery(auto, 1800), fleet: K.fleetQuery(auto, 300) };
  const run = (st, w, span = 300) => ({ gaps: K.gapsParts(st, undefined, w), act: K.activityParts(st, 1800, undefined, w), fleet: K.fleetParts(st, span, w) });
  for (const [name, st, w] of [['≤1h', auto, short], ['off', off, long], ['off live', off, live], ['no window', auto, undefined]]) {
    const r = run(st, w);
    t(`${name}: exactly the raw queries`, () => ['gaps', 'act', 'fleet'].every((k) => r[k].mode === 'raw' && r[k].rollup === undefined && r[k].raw === rawOf[k]));
  }
  t('span < 300 stays raw', () => K.fleetParts(auto, 60, long).mode === 'raw' && K.fleetParts(auto, 60, long).raw === K.fleetQuery(auto, 60));
  const r = run(auto, long);
  t('window ending before the cut: rollup only, deduped, bounded at the cut', () => ['gaps', 'act', 'fleet'].every((k) => r[k].mode === 'rollup' && r[k].raw === undefined
    && r[k].rollup.startsWith('dataset="pulse_metrics_5m"') && r[k].rollup.includes('| where bucket < bin(now() - 1800, ') && r[k].rollup.includes('summarize events=max(events), bytes=max(bytes), active_min=max(active_min), first_min=min(first_min), last_min=max(last_min),') && !/arg_max|mv-expand/.test(r[k].rollup)));
  const l = run(auto, live);
  t('window ending now: rollup part plus raw tail from the cut', () => ['gaps', 'act', 'fleet'].every((k) => l[k].mode === 'rollup+tail'
    && l[k].rollup.includes('bucket < bin(now() - 1800, ') && l[k].raw.includes('dataset="pulse_metrics"') && l[k].raw.includes('| where _time >= bin(now() - 1800, ')));
  // Review fix: a window that starts before the rollup's oldest bucket reads raw (the rollup would come back short).
  const covered = run(auto, { ...live, rollupFromS: live.earliestS }), short_ = run(auto, { ...live, rollupFromS: live.earliestS + 300 });
  t('window inside the rollup coverage: rollup + tail', () => ['gaps', 'act', 'fleet'].every((k) => covered[k].mode === 'rollup+tail'));
  t('window starting before the oldest bucket: exactly the raw queries', () => ['gaps', 'act', 'fleet'].every((k) => short_[k].mode === 'raw' && short_[k].raw === rawOf[k]));
  t('fleet assets is an exact count, not dcount', () => !/dcount/.test(l.fleet.rollup + l.fleet.raw) && l.fleet.rollup.includes('assets=count()'));
  t('gaps rollup uses in_gap_* and first_min/last_min', () => /in_gap_start/.test(l.gaps.rollup) && /prev\(last_min\)/.test(l.gaps.rollup));
  t('gaps rollup: the cross-bucket leg, then a union with the inner-gap leg (both deduped)', () => /\| where pk == k and first_min - pl > 120\n\| project worker_group, input, asset, gap_start=pl, gap_end=first_min/.test(l.gaps.rollup)
    && /\| union \(dataset="pulse_metrics_5m"[\s\S]*\| where isnotnull\(in_gap_start\)/.test(l.gaps.rollup) && (l.gaps.rollup.match(/written_at=max\(written_at\)/g) || []).length === 2);
  t('entityActivity/samples/retired unchanged', () => K.entityActivityQuery(auto, 'i', 'a').startsWith('dataset="pulse_metrics" _metric=="pulse.heartbeat" input=="i"') && !/_5m/.test(K.entityActivityQuery(auto, 'i', 'a') + K.samplesQuery(auto, 'i') + K.retiredQuery(auto)));
}

// F7: the Deploy plan creates <dataset>_5m in the raw dataset's format
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));
const runStep = async (dataset, existing) => {
  const posts = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const send = (o, status = 200) => ({ ok: status < 400, status, text: async () => JSON.stringify(o) });
    if (init.method === 'POST') { posts.push({ url: u, body: JSON.parse(init.body) }); return send({}); }
    if (u.endsWith('/datasets')) return send({ items: existing });
    return send({});
  };
  const plan = D.deployPlan('g', [], { dataset, destination: 'pulse_lake' });
  const step = plan.find((x) => x.id === 'dataset5m');
  const out = step && await step.run();
  return { plan, step, posts, out };
};
{
  const r = await runStep('pulse_metrics', []);
  t('plan has a dataset5m step after the raw one', () => r.plan.map((x) => x.id).indexOf('dataset5m') === r.plan.map((x) => x.id).indexOf('dataset') + 1);
  t('new install: _5m created as Parquet v2', () => r.posts.length === 1 && r.posts[0].body.id === 'pulse_metrics_5m' && r.posts[0].body.format === 'parquet' && r.posts[0].body.searchConfig?.searchVersion === 'v2');
  const j = await runStep('my_ds', [{ id: 'my_ds', format: 'json' }]);
  t('json raw dataset: _5m created as json', () => j.posts.length === 1 && j.posts[0].body.id === 'my_ds_5m' && j.posts[0].body.format === 'json' && !j.posts[0].body.searchConfig);
  const e = await runStep('pulse_metrics', [{ id: 'pulse_metrics_5m', format: 'parquet' }]);
  t('existing _5m is kept', () => e.posts.length === 0 && /exists/.test(e.out));
}
const pol = readFileSync(join(root, 'config/policies.yml'), 'utf8');
t('policies grant both _5m datasets', () => /datasets\/pulse_metrics_5m'/.test(pol) && /datasets\/pulse_metrics_pq_5m'/.test(pol));

// F8: Alerts plan decisions
{
  const base = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'auto', notify: { targets: [], email: '' },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 } };
  const now = 1_800_000_000;
  const saved = { query: 'dataset="pulse_metrics" | export to lake pulse_metrics_5m', schedule: { enabled: true } };
  const ok = { saved, newestBucket: now - 300, oldestBucket: now - 86400 - 300, nowS: now };
  const ids = (p) => p.map((x) => x.id);
  const alert = (p) => p.find((x) => x.id === 'pulse_ledger_asset');
  const modeOf = async (s, ctx) => {
    let q;
    globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
    globalThis.fetch = async (url, init = {}) => {
      const send = (o) => ({ ok: true, status: 200, text: async () => JSON.stringify(o) });
      if (init.method === 'POST' || init.method === 'PATCH') { const b = JSON.parse(init.body ?? '{}'); if (b.id === 'pulse_ledger_asset') q = b.query; }
      return send({ items: [] });
    };
    await alert(D.alertsPlan(s, true, ctx)).run();
    return q.includes('rollup_ok') ? 'rollup' : 'raw'; // alert_missing reads pulse_state's rollup_ok (spec 034)
  };
  t('plan publishes pulse_rollup', () => ids(D.alertsPlan(base, true, ok)).includes('pulse_rollup'));
  t('plan publishes pulse_rollup without context', () => ids(D.alertsPlan(base, true)).includes('pulse_rollup'));
  t('backfill absent when an old bucket exists', () => !ids(D.alertsPlan(base, true, ok)).includes('rollup_backfill'));
  t('backfill present when the oldest bucket is newer than now - lookback', () => {
    const p = D.alertsPlan(base, true, { ...ok, oldestBucket: now - 3600 });
    return ids(p).includes('rollup_backfill') && ids(p).indexOf('rollup_backfill') === ids(p).indexOf('pulse_rollup') + 1 && /Backfill the rollup/.test(p.find((x) => x.id === 'rollup_backfill').title);
  });
  t('backfill present when the rollup is empty', () => ids(D.alertsPlan(base, true, { ...ok, oldestBucket: undefined, newestBucket: undefined })).includes('rollup_backfill'));
  t('backfill query starts at the first whole bucket of its range', () => { const q = K.rollupQuery(base, 100800);
    return !q.includes('bin(now() - 1200') && q.includes('bucket >= bin(now() - 100800, 300) + 300 and bucket < bin(now(), 300) - 300'); });
  t('plan has rollup_check right after the backfill, before the other searches', () => { const p = ids(D.alertsPlan(base, true, { ...ok, oldestBucket: now - 3600 }));
    return p.indexOf('rollup_check') === p.indexOf('rollup_backfill') + 1 && p.indexOf('rollup_check') < p.indexOf('pulse_state'); });
  t('plan without context (AskBar) lists the backfill and the check', () => ['rollup_backfill', 'rollup_check'].every((x) => ids(D.alertsPlan(base, true)).includes(x)));
  t('plan with rollup off has neither', () => !ids(D.alertsPlan({ ...base, rollup: 'off' }, true)).some((x) => x === 'rollup_backfill' || x === 'rollup_check'));
  const m = [await modeOf(base, ok), await modeOf({ ...base, rollup: 'off' }, ok), await modeOf(base, { ...ok, newestBucket: now - 4000 }),
    await modeOf(base, { ...ok, oldestBucket: now - 3600 }), await modeOf(base, undefined)];
  t('mode rollup on use:true + auto', () => m[0] === 'rollup');
  t('mode raw when rollup off', () => m[1] === 'raw');
  t('mode raw when verdict use:false (behind)', () => m[2] === 'raw');
  t('mode raw when verdict use:false (not backfilled)', () => m[3] === 'raw');
  t('mode raw without context', () => m[4] === 'raw');
  t('rollupDecision', () => D.rollupDecision(base, ok).rollup === true && D.rollupDecision({ ...base, rollup: 'off' }, ok).rollup === false);
  const sv = await (async () => { globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) }); return D.savedStatus(base); })();
  t('saved-search status includes pulse_rollup', () => sv.some((x) => x.id === 'pulse_rollup'));
}

// Review fix: the rollup-mode pulse_state the Alerts plan publishes still passes the spec 025 snapshot verdict.
{
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/snapshot.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'sn.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
  const N = await import(join(tmp, 'sn.mjs'));
  const st = (rollup) => ({ dataset: 'pulse_metrics', learning: { LOOKBACK: '-24h' }, rollup });
  const v = (rollup, rollupOk) => N.snapshotVerdict({ saved: { query: K.savedSearches(st(rollup)).find((x) => x.id === 'pulse_state').query, schedule: { enabled: true } },
    dataset: 'pulse_metrics', rows: [{ computed_at: 1000 }], nowS: 1100, rollupOk });
  t('snapshotVerdict uses a rollup-mode pulse_state while the rollup is in use', () => v('auto', true).use === true);
  t('snapshotVerdict skips a rollup-mode pulse_state when the rollup is not in use', () => v('auto', false).reason === 'rollup' && v('auto').reason === 'rollup');
  t('snapshotVerdict uses a raw pulse_state whatever the rollup', () => v('off', false).use === true);
}

// Review fix: a first install (no pulse_rollup yet) publishes in rollup mode in the same Alerts run, because
// rollup_check re-reads the rollup once pulse_rollup and the backfill have run.
{
  const base = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'auto', notify: { targets: [], email: '' },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 } };
  const fake = (rollupReady) => {
    const saved = new Map(), searches = [], published = {};
    globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url), m = init.method ?? 'GET', b = init.body ? JSON.parse(init.body) : undefined;
      const send = (o) => ({ ok: true, status: 200, text: async () => (typeof o === 'string' ? o : JSON.stringify(o)) });
      if (/\/search\/jobs$/.test(u) && m === 'POST') { searches.push(b); return send({ items: [{ id: `j${searches.length}` }] }); }
      if (/\/jobs\/j(\d+)\/status$/.test(u)) return send({ items: [{ status: 'completed' }] });
      if (/\/jobs\/j(\d+)\/results/.test(u)) {
        const q = searches[Number(u.match(/\/jobs\/j(\d+)\//)[1]) - 1].query, nowS = Math.floor(Date.now() / 1000);
        return send(/summarize oldest=min\(_time\), newest=max\(_time\)/.test(q) && rollupReady() ? JSON.stringify({ oldest: nowS - 90000, newest: nowS - 300 }) : '');
      }
      if (/\/search\/saved(\/[\w]+)?$/.test(u) && (m === 'POST' || m === 'PATCH')) { saved.set(b.id, b); published[b.id] = b.query; return send({}); }
      if (/\/search\/saved$/.test(u)) return send({ items: [...saved.values()] });
      return send({ items: [] });
    };
    return { searches, published, saved };
  };
  const runFrom = async (plan, from) => { const out = {}; for (const st of plan.slice(plan.findIndex((x) => x.id === from))) out[st.id] = await st.run(); return out; };
  const first = { nowS: Math.floor(Date.now() / 1000) }; // no pulse_rollup, no buckets
  {
    let backfilled = false;
    const f = fake(() => backfilled);
    const plan = D.alertsPlan(base, true, first);
    const bf = plan.find((x) => x.id === 'rollup_backfill'), run0 = bf.run;
    bf.run = async () => { const r = await run0(); backfilled = true; return r; };
    const out = await runFrom(plan, 'pulse_rollup');
    t('first install: backfill runs, aligned to the grid', () => out.rollup_backfill === 'backfill done' && f.searches.some((x) => /bucket >= bin\(now\(\) - 100800, 300\) \+ 300/.test(x.query) && x.earliest === '-100800s'));
    t('first install: rollup_check finds the rollup in use', () => /^rollup in use/.test(out.rollup_check));
    t('first install: the alert searches and pulse_state publish in rollup mode in the same run', () =>
      f.published.pulse_state?.includes('pulse_metrics_5m') && ['pulse_ledger_asset', 'pulse_ledger_source'].every((id) => f.published[id]?.includes('where rollup_ok')));
  }
  {
    const f = fake(() => false); // the rollup is still empty after the backfill (e.g. Lake not caught up yet)
    const out = await runFrom(D.alertsPlan(base, true, first), 'pulse_rollup');
    t('rollup not ready: rollup_check says so and the searches publish on raw', () => /^rollup not in use \(empty\)/.test(out.rollup_check)
      && ['pulse_state', 'pulse_ledger_asset'].every((id) => f.published[id] && !f.published[id].includes('_5m')));
  }
  {
    const f = fake(() => true);
    const out = await runFrom(D.alertsPlan(base, true), 'pulse_rollup'); // AskBar: no context
    t('AskBar plan: the backfill is skipped when already done, and the searches publish in rollup mode', () => out.rollup_backfill === 'already backfilled: skipped'
      && f.published.pulse_ledger_asset?.includes('where rollup_ok'));
  }
}

// Review fix (org, 2026-11-13): /kvstore/keys answers with a bare array; kvKeys read only `items`, so the installed app
// saw no deployment record and the Overview said "Pulse isn't watching anything yet".
{
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/api.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'api.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
  const A = await import(join(tmp, 'api.mjs'));
  const keysFrom = async (payload) => { globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }); return A.kvKeys('deployments/'); };
  const bare = await keysFrom(['deployments/04-2025']), wrapped = await keysFrom({ items: ['deployments/g2', { key: 'deployments/g3' }] });
  t('kvKeys: bare array', () => bare.length === 1 && bare[0] === 'deployments/04-2025');
  t('kvKeys: { items } still accepted', () => wrapped.join(',') === 'deployments/g2,deployments/g3');
}

// Review fix: a destination id with a ':' (e.g. cribl_lake:pulse) is refused before Stream sees it.
{
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/settings.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'set.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
  const St = await import(join(tmp, 'set.mjs'));
  t('validDestination', () => ['pulse_lake', 'cribl_lake_pulse', 'pulse-lake', 'P2'].every(St.validDestination)
    && !['cribl_lake:pulse', '', 'a b', 'x/y'].some(St.validDestination));
  let posted = 0, err = '';
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (u, init = {}) => { if (init.method === 'POST' || init.method === 'PATCH') posted++; return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) }; };
  const step = D.deployPlan('g', [], { dataset: 'pulse_metrics', destination: 'cribl_lake:pulse' }).find((x) => x.id === 'dest');
  try { await step.run(); } catch (e) { err = String(e.message); }
  t('Deploy refuses a destination id Stream would reject, before any write', () => posted === 0 && /letters, digits, _ and -/.test(err) && /Settings/.test(err));
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('rollup: ok');
