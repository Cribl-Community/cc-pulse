import { hostMode } from './host';
import { runSearch } from './api';
import { activityQuery, entityActivityQuery, type HistoryParts } from './kql';
import type { Entity } from './model';
import type { AppSettings } from './settings';
import type { Row } from './api';

/* On-demand time series for the drill-down pages. Outside Cribl (`npm run dev`) they come from demo.ts. */
/** Turns `summarize … by key, b` rows into fixed arrays ending at now (missing bins = 0 = silence). */
export function binSeries(rows: Row[], span: number, bins: number, keyOf: (r: Row) => string, endS: number = Date.now() / 1000) {
  const end = Math.floor(endS / span) * span, start = end - (bins - 1) * span;
  const out: Record<string, number[]> = {};
  for (const r of rows) {
    const b = typeof r.b === 'number' ? r.b : Date.parse(String(r.b)) / 1000;
    const i = Math.round((b - start) / span);
    if (i < 0 || i >= bins) continue;
    const k = keyOf(r);
    (out[k] ??= new Array(bins).fill(0))[i] += Number(r.events) || 0;
  }
  return out;
}

/* ---------- spec 026: merging the rollup part and the raw tail of a history job ---------- */
export type HistKindMerge = 'activity' | 'heartbeat' | 'gaps';
const secs = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : Date.parse(String(v)) / 1000);
const ekey = (r: Row) => `${r.worker_group}|${r.input}|${r.asset}`;

/** The gap that straddles the cut: an entity's last minute before the cut (`before`, rows with last_min) joined to
 *  its first minute at or after it (`after`, rows with first_min). Emitted when the silence is longer than 2 min,
 *  exactly like gapsQuery (`minute - pm > 120`). An entity seen on one side only yields nothing. Pure. */
export function joinCutGaps(before: Row[], after: Row[]): Row[] {
  const last = new Map<string, number>();
  for (const r of before) { const v = secs(r.last_min); if (Number.isFinite(v)) last.set(ekey(r), Math.max(v, last.get(ekey(r)) ?? -Infinity)); }
  const first = new Map<string, { r: Row; v: number }>();
  for (const r of after) { const v = secs(r.first_min); const k = ekey(r); if (Number.isFinite(v) && (!first.has(k) || v < first.get(k)!.v)) first.set(k, { r, v }); }
  const out: Row[] = [];
  for (const [k, { r, v }] of first) {
    const pm = last.get(k);
    if (pm === undefined || v - pm <= 120) continue;
    out.push({ worker_group: r.worker_group, input: r.input, asset: r.asset, gap_start: pm, gap_end: v, gap_s: v - pm });
  }
  return out;
}

/** Merge the rollup rows and the raw-tail rows of one history job into the rows the raw query would return. Pure.
 *  - activity: both parts' `by key, b` rows; binSeries sums them by key and bin.
 *  - heartbeat: one row per bin, events and assets summed (the parts never share a bin: the cut is span-aligned).
 *  - gaps: both ledgers plus the gap that straddles the cut (joinCutGaps over `edges`). */
export function mergeHistory(kind: HistKindMerge, rollup: Row[], tail: Row[], edges?: { before: Row[]; after: Row[] }): Row[] {
  if (kind === 'heartbeat') {
    const by = new Map<number, { b: number; events: number; assets: number }>();
    for (const r of [...rollup, ...tail]) {
      const b = secs(r.b); if (!Number.isFinite(b)) continue;
      const o = by.get(b) ?? { b, events: 0, assets: 0 };
      o.events += Number(r.events) || 0; o.assets += Number(r.assets) || 0; by.set(b, o);
    }
    return [...by.values()].sort((x, y) => x.b - y.b);
  }
  if (kind === 'gaps') return [...rollup, ...tail, ...(edges ? joinCutGaps(edges.before, edges.after) : [])];
  return [...rollup, ...tail];
}

/** Activity in either mode: the merged rows through binSeries (key = worker_group|input|asset). Pure. */
export const mergedActivity = (rollup: Row[], tail: Row[], span: number, bins: number, endS?: number) =>
  binSeries(mergeHistory('activity', rollup, tail), span, bins, ekey, endS);

/** Runs a history job from its parts (kql.ts *Parts): the raw query alone, the rollup alone, or the rollup, the raw
 *  tail (and for gaps, the two cut edges) in parallel, merged by mergeHistory. */
export async function runHistoryParts(kind: HistKindMerge, p: HistoryParts, edges: { rollup: string; raw: string } | undefined,
  earliest: string, latest: string, ms: number, lim: number, opts?: { signal?: AbortSignal }): Promise<Row[]> {
  const go = (q: string) => runSearch(q, earliest, latest, ms, lim, opts);
  if (p.mode === 'raw') return go(p.raw!);
  if (p.mode === 'rollup') return mergeHistory(kind, await go(p.rollup!), []);
  const withEdges = kind === 'gaps' && edges;
  const [r, t, b, a] = await Promise.all([go(p.rollup!), go(p.raw!), withEdges ? go(edges.rollup) : [], withEdges ? go(edges.raw) : []]);
  return mergeHistory(kind, r, t, withEdges ? { before: b, after: a } : undefined);
}

export const seriesEnd =(span: number) => Math.floor(Date.now() / 1000 / span) * span;

/** Every entity of a worker group, `bins` × `span` seconds ending now. Key = entity key. */
export async function groupSeries(s: AppSettings, group: string, list: Entity[], span = 600, bins = 144): Promise<Record<string, number[]>> {
  if (hostMode() === 'demo') { const d = await import('./demo'); return Object.fromEntries(list.map((e) => [e.key, d.entitySeries(e.asset, span, bins)])); }
  const rows = await runSearch(activityQuery(s, span, group), `-${Math.ceil((span * bins) / 3600)}h`, 'now', 120_000, 50_000);
  return binSeries(rows, span, bins, (r) => `${r.worker_group}|${r.input}|${r.asset}`);
}

/** One entity. span=60 / bins=1440 gives the per-minute grid used to replay gaps. */
export async function entitySeries(s: AppSettings, e: Pick<Entity, 'input' | 'asset'>, span = 600, bins = 144): Promise<number[]> {
  if (hostMode() === 'demo') { const d = await import('./demo'); return d.entitySeries(e.asset, span, bins); }
  const rows = await runSearch(entityActivityQuery(s, e.input, e.asset, span), `-${Math.ceil((span * bins) / 3600)}h`, 'now', 120_000, bins + 10);
  return binSeries(rows, span, bins, () => 'x').x ?? new Array(bins).fill(0);
}
