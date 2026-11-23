// Spec 026 F10: history jobs read the rollup + raw tail when the verdict says use, and merge them (src/lib/series.ts).
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-histmerge-'));
const bundle = (src, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
bundle('src/lib/series.ts', 's.mjs');
bundle('src/lib/kql.ts', 'k.mjs');
const S = await import(join(tmp, 's.mjs'));
const K = await import(join(tmp, 'k.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const eq = (a, b) => { deepStrictEqual(a, b); return true; };

const span = 1800, end = 1_800_000_000 - (1_800_000_000 % span), bins = 6, start = end - (bins - 1) * span;
const E = (asset, b, events) => ({ worker_group: 'g', input: 'i', asset, b, events });

// Activity: rollup bins before the cut, tail bins after it; one key appears on both sides and twice in one bin.
t('activity: merged bins sum, one series per key, no duplicated bucket', () => {
  const rollup = [E('a', start, 10), E('a', start + span, 5), E('b', start + 2 * span, 7)];
  const tail = [E('a', start + 4 * span, 3), E('a', start + 4 * span, 2), E('b', end, 1)];
  const out = S.mergedActivity(rollup, tail, span, bins, end);
  return eq(Object.keys(out).sort(), ['g|i|a', 'g|i|b'])
    && eq(out['g|i|a'], [10, 5, 0, 0, 5, 0]) && eq(out['g|i|b'], [0, 0, 7, 0, 0, 1])
    && out['g|i|a'].length === bins;
});
t('activity: merge equals binSeries over the concatenation', () => {
  const rollup = [E('a', start, 1)], tail = [E('a', start, 2)];
  return eq(S.mergedActivity(rollup, tail, span, bins, end), S.binSeries([...rollup, ...tail], span, bins, (r) => `${r.worker_group}|${r.input}|${r.asset}`, end))
    && S.mergedActivity(rollup, tail, span, bins, end)['g|i|a'][0] === 3;
});
t('activity: total of merged bins = total of both parts', () => {
  const rollup = [E('a', start, 4), E('c', start + span, 6)], tail = [E('a', end, 9)];
  const out = S.mergedActivity(rollup, tail, span, bins, end);
  return Object.values(out).flat().reduce((x, y) => x + y, 0) === 19;
});

// Fleet heartbeat: one row per bin.
t('heartbeat: one row per bin, sorted, events and assets summed', () => eq(
  S.mergeHistory('heartbeat', [{ b: 300, events: 4, assets: 2 }, { b: 0, events: 1, assets: 1 }], [{ b: 600, events: 5, assets: 3 }, { b: 300, events: 1, assets: 0 }]),
  [{ b: 0, events: 1, assets: 1 }, { b: 300, events: 5, assets: 2 }, { b: 600, events: 5, assets: 3 }]));

// Gaps: an outage that crosses the cut is recovered exactly once; no gap at the cut gives no extra row.
const G = (asset, gs, ge) => ({ worker_group: 'g', input: 'i', asset, gap_start: gs, gap_end: ge, gap_s: ge - gs });
const cut = 1_800_000_000 - (1_800_000_000 % 300);
t('gaps: outage crossing the cut is recovered exactly once', () => {
  const rollup = [G('a', cut - 7200, cut - 6000)], tail = [G('a', cut + 900, cut + 1200)];
  const edges = { before: [{ worker_group: 'g', input: 'i', asset: 'a', last_min: cut - 600 }, { worker_group: 'g', input: 'i', asset: 'b', last_min: cut - 60 }],
    after: [{ worker_group: 'g', input: 'i', asset: 'a', first_min: cut + 300 }, { worker_group: 'g', input: 'i', asset: 'b', first_min: cut }] };
  const out = S.mergeHistory('gaps', rollup, tail, edges);
  const crossing = out.filter((r) => r.gap_start < cut && r.gap_end >= cut);
  return out.length === 3 && eq(crossing, [G('a', cut - 600, cut + 300)]);
});
t('gaps: no gap at the cut -> no extra row', () => {
  const edges = { before: [{ worker_group: 'g', input: 'i', asset: 'a', last_min: cut - 60 }], after: [{ worker_group: 'g', input: 'i', asset: 'a', first_min: cut + 60 }] };
  return eq(S.joinCutGaps(edges.before, edges.after), []) && S.mergeHistory('gaps', [G('a', 0, 600)], [], edges).length === 1;
});
t('gaps: exactly 120 s is not a gap; 180 s is', () =>
  S.joinCutGaps([{ worker_group: 'g', input: 'i', asset: 'a', last_min: cut - 60 }], [{ worker_group: 'g', input: 'i', asset: 'a', first_min: cut + 60 }]).length === 0
  && S.joinCutGaps([{ worker_group: 'g', input: 'i', asset: 'a', last_min: cut - 120 }], [{ worker_group: 'g', input: 'i', asset: 'a', first_min: cut + 60 }]).length === 1);
t('gaps: an entity on one side of the cut only yields nothing', () =>
  S.joinCutGaps([{ worker_group: 'g', input: 'i', asset: 'a', last_min: cut - 900 }], [{ worker_group: 'g', input: 'i', asset: 'z', first_min: cut + 600 }]).length === 0);

// The cut-edge queries read the rollup before the cut and the raw tail from it.
const L = { LOOKBACK: '-7d', MIN_GAP: 300, MAX_GAP: 86400, K: 3 };
const auto = { dataset: 'ds1', learning: L, rollup: 'auto' };
t('gapsCutEdges', () => { const e = K.gapsCutEdges(auto); return /dataset="ds1_5m"/.test(e.rollup) && /bucket < bin\(now\(\) - 1800, 300\)/.test(e.rollup) && /last_min=max\(last_min\)/.test(e.rollup)
  && /dataset="ds1"/.test(e.raw) && /_time >= bin\(now\(\) - 1800, 300\)/.test(e.raw) && /first_min=min\(minute\)/.test(e.raw); });

// ≤ 1 h stays raw; > 1 h ending now is rollup+tail; 'off' is raw.
const nowS = 1_800_000_000;
t('≤ 1 h windows stay raw', () => ['activity', 'fleet', 'gaps'].every((k) => {
  const w = { earliestS: nowS - 3600, latestS: nowS, nowS };
  const p = k === 'activity' ? K.activityParts(auto, 1800, undefined, w) : k === 'fleet' ? K.fleetParts(auto, 300, w) : K.gapsParts(auto, undefined, w);
  return p.mode === 'raw';
}));
t('> 1 h ending now: rollup+tail; off: raw', () => {
  const w = { earliestS: nowS - 86400, latestS: nowS, nowS };
  return K.gapsParts(auto, undefined, w).mode === 'rollup+tail' && K.gapsParts({ ...auto, rollup: 'off' }, undefined, w).mode === 'raw';
});

// state.tsx wiring (source-level: the provider needs a browser).
const src = readFileSync(join(root, 'src/state.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
t('state.tsx: loaders use the part variants', () => /job\('activity', activityParts\(hs,/.test(src) && /job\('heartbeat', fleetParts\(hs,/.test(src) && /job\('gaps', gapsParts\(hs,/.test(src));
t('state.tsx: rollup only for auto + verdict use (for this dataset) + window > 1 h', () => /const ru = w\.to - w\.from > 3600 \? rollupUse\(s\) : undefined;/.test(src)
  && /rollup: ru \? 'auto' : 'off'/.test(src) && /effectiveRollup\(s\) === 'auto' && r\?\.dataset === s\.dataset && r\.v\.use === true/.test(src));
t('state.tsx: history windows carry the rollup coverage', () => /rollupFromS: ru\?\.oldestS/.test(src));
t('state.tsx: history and the live fallback wait for the rollup check; the snapshot read does not', () => {
  const open = src.slice(src.indexOf('const [s, a, inv, cl, ru, w] = await Promise.all'));
  const live = src.slice(src.indexOf('if (!live) return;'), src.indexOf('// The snapshot was rejected'));
  return /void startRollupCheck\(s\);[^\n]*\n\s*setLoaded\(true\);/.test(open) && !/await checkRollup|await startRollupCheck/.test(src)
    && /\(rollupCheck\.current \?\? Promise\.resolve\(\)\)[\s\S]{0,80}\.then\(\(\) => launchHistory\(w, s0\)\)/.test(src)
    && live.indexOf('snapshotQuery(cad)') < live.indexOf('await rollupCheck.current');
});
t('state.tsx: a rollup-mode snapshot waits for the check and is used only while the rollup is in use', () =>
  /if \(readsRollup\(saved\?\.query, s\.dataset\)\) await rollupCheck\.current;\n\s*const v = snapshotVerdict\(\{[^}]*rollupOk: !!rollupUse\(s\), maxAgeS: cad\.snapshotMaxAgeS \}\);/.test(src));
t('state.tsx: a superseded rollup check never writes the verdict', () => /const seq = \+\+rollupSeq\.current;[\s\S]{0,200}await fetchRollupCheck\(s\);\n\s*if \(seq !== rollupSeq\.current\) return;/.test(src));
t('state.tsx: a dataset change checks the rollup at once', () => /if \(rollupCheckKey\.current !== `\$\{settings\.dataset\}\|\$\{settings\.learning\.LOOKBACK\}`\) void startRollupCheck\(settings\);/.test(src));
t('state.tsx: parts run through runHistoryParts with the gap cut edges', () => /runHistoryParts\(k, p, k === 'gaps' \? gapsCutEdges\(hs\)/.test(src));
t('state.tsx: activity still goes through binSeries', () => /setActivity\(binSeries\(r,/.test(src));

if (fail) process.exit(1);
console.log('historymerge: ok');
