// Pure reference model of the 5-minute rollup (spec 026). No I/O.
import { cadenceOf, normalizeLoad, type Cadence, type SearchLoad } from './cadence';
import { datasetsOf } from './snapshot';
/** The Standard values (spec 026 as built). Spec 033: the cadence-aware ones come from rollupWindow(load). */
export const ROLLUP_SPAN = 300;
export const TAIL_S = 1800;
export const ROLLUP_MAX_LAG_S = 1500;
export const GAP_S = 120;

/** Spec 033: the rollup window for a search load. Daily has no rollup (effectiveRollup is 'off'); it falls back to the
 *  Standard window so a caller that still builds the (disabled) rollup search gets the Standard text. */
export const rollupWindow = (load: SearchLoad = 'standard'): NonNullable<Cadence['rollup']> =>
  cadenceOf(normalizeLoad(load)).rollup ?? (cadenceOf('standard').rollup as NonNullable<Cadence['rollup']>);
export const rollupMaxLagS = (load: SearchLoad = 'standard') => rollupWindow(load).maxLagS;
export const rollupTailS = (load: SearchLoad = 'standard') => rollupWindow(load).tailS;

export const rollupDataset = (ds: string): string => `${ds}_5m`;

export interface MinuteRow {
  worker_group: string; input: string; asset: string;
  minute: number; ev: number; bytes: number;
  lag_s?: number; asset_src?: number;
  /** Exact first / last `_time` (seconds) inside the minute; default: the minute itself. */
  first_s?: number; last_s?: number;
}
export interface RollupRow {
  worker_group: string; input: string; asset: string; bucket: number; _time: number;
  events: number; bytes: number; active_min: number; first_min: number; last_min: number; first_s: number; last_s: number;
  in_gap_start: number | null; in_gap_end: number | null;
  max_lag_s: number | null; min_lag_s: number | null; asset_src: number | null; written_at: number;
}
export interface Gap { worker_group: string; input: string; asset: string; start: number; end: number; gap_s: number }
export interface Summary { worker_group: string; input: string; asset: string; first_min: number; last_min: number; first_s: number; last_s: number; active_min: number; events: number }

type Ent = { worker_group: string; input: string; asset: string };
const keyOf = (r: Ent) => `${r.worker_group}\u0000${r.input}\u0000${r.asset}`;
const cmp = (a: Ent, b: Ent) => (keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0);
const bin = (t: number) => Math.floor(t / ROLLUP_SPAN) * ROLLUP_SPAN;
const firstS = (rs: MinuteRow[]) => Math.min(...rs.map((r) => r.first_s ?? r.minute));
const lastS = (rs: MinuteRow[]) => Math.max(...rs.map((r) => r.last_s ?? r.minute));

function byEntity<T extends Ent>(rows: T[]): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const r of rows) { const k = keyOf(r); const l = m.get(k); if (l) l.push(r); else m.set(k, [r]); }
  return m;
}
const sortedEntities = <T extends Ent>(m: Map<string, T[]>) => [...m.values()].sort((a, b) => cmp(a[0], b[0]));

/** Minute rows (several per minute allowed, e.g. per worker process) -> one row per entity and 5-minute bucket. */
export function rollupOf(minuteRows: MinuteRow[], writtenAt = 0): RollupRow[] {
  const out: RollupRow[] = [];
  for (const rows of sortedEntities(byEntity(minuteRows))) {
    const byB = new Map<number, MinuteRow[]>();
    for (const r of rows) { const b = bin(r.minute); const l = byB.get(b); if (l) l.push(r); else byB.set(b, [r]); }
    for (const b of [...byB.keys()].sort((x, y) => x - y)) {
      const rs = byB.get(b)!;
      const mins = [...new Set(rs.map((r) => r.minute))].sort((x, y) => x - y);
      let gs: number | null = null, ge: number | null = null;
      for (let i = 1; i < mins.length; i++) if (mins[i] - mins[i - 1] > GAP_S) { gs = mins[i - 1]; ge = mins[i]; break; }
      const lags = rs.map((r) => r.lag_s).filter((x): x is number => typeof x === 'number');
      const srcs = rs.map((r) => r.asset_src).filter((x): x is number => typeof x === 'number');
      out.push({
        worker_group: rs[0].worker_group, input: rs[0].input, asset: rs[0].asset, bucket: b, _time: b,
        events: rs.reduce((s, r) => s + r.ev, 0), bytes: rs.reduce((s, r) => s + r.bytes, 0),
        active_min: mins.length, first_min: mins[0], last_min: mins[mins.length - 1], first_s: firstS(rs), last_s: lastS(rs),
        in_gap_start: gs, in_gap_end: ge,
        max_lag_s: lags.length ? Math.max(...lags) : null, min_lag_s: lags.length ? Math.min(...lags) : null,
        asset_src: srcs.length ? Math.max(...srcs) : null, written_at: writtenAt,
      });
    }
  }
  return out;
}

const gap = (e: Ent, start: number, end: number): Gap => ({ worker_group: e.worker_group, input: e.input, asset: e.asset, start, end, gap_s: end - start });

export function gapsFromMinutes(minuteRows: MinuteRow[]): Gap[] {
  const out: Gap[] = [];
  for (const rows of sortedEntities(byEntity(minuteRows))) {
    const mins = [...new Set(rows.map((r) => r.minute))].sort((x, y) => x - y);
    for (let i = 1; i < mins.length; i++) if (mins[i] - mins[i - 1] > GAP_S) out.push(gap(rows[0], mins[i - 1], mins[i]));
  }
  return out;
}

export function gapsFromRollup(rollup: RollupRow[]): Gap[] {
  const out: Gap[] = [];
  for (const rows of sortedEntities(byEntity(rollup))) {
    const rs = [...rows].sort((a, b) => a.bucket - b.bucket);
    rs.forEach((r, i) => {
      if (i > 0 && r.first_min - rs[i - 1].last_min > GAP_S) out.push(gap(r, rs[i - 1].last_min, r.first_min));
      if (r.in_gap_start != null && r.in_gap_end != null) out.push(gap(r, r.in_gap_start, r.in_gap_end));
    });
  }
  return out.sort((a, b) => cmp(a, b) || a.start - b.start);
}

export function summaryFromMinutes(minuteRows: MinuteRow[]): Summary[] {
  return sortedEntities(byEntity(minuteRows)).map((rows) => {
    const mins = new Set(rows.map((r) => r.minute));
    return {
      worker_group: rows[0].worker_group, input: rows[0].input, asset: rows[0].asset,
      first_min: Math.min(...mins), last_min: Math.max(...mins), first_s: firstS(rows), last_s: lastS(rows), active_min: mins.size,
      events: rows.reduce((s, r) => s + r.ev, 0),
    };
  });
}

export function summaryFromRollup(rollup: RollupRow[]): Summary[] {
  return sortedEntities(byEntity(rollup)).map((rows) => ({
    worker_group: rows[0].worker_group, input: rows[0].input, asset: rows[0].asset,
    first_min: Math.min(...rows.map((r) => r.first_min)), last_min: Math.max(...rows.map((r) => r.last_min)),
    first_s: Math.min(...rows.map((r) => r.first_s)), last_s: Math.max(...rows.map((r) => r.last_s)),
    active_min: rows.reduce((s, r) => s + r.active_min, 0), events: rows.reduce((s, r) => s + r.events, 0),
  }));
}

export type RollupVerdict = { use: true } | { use: false; reason: 'no-search' | 'disabled' | 'other-dataset' | 'wrong-target' | 'empty' | 'behind' | 'not-backfilled' };
export function rollupVerdict(p: {
  saved?: { query?: string; schedule?: { enabled?: boolean } }; dataset: string;
  newestBucket?: number; oldestBucket?: number; nowS: number; lookbackS: number;
  /** How far behind the newest bucket may be: the cadence's rollup.maxLagS (default: Standard, ROLLUP_MAX_LAG_S). */
  maxLagS?: number;
}): RollupVerdict {
  const maxLagS = p.maxLagS ?? ROLLUP_MAX_LAG_S;
  const q = p.saved?.query ?? '';
  if (!p.saved) return { use: false, reason: 'no-search' };
  if (!p.saved.schedule?.enabled) return { use: false, reason: 'disabled' };
  // What it reads (dataset=…), not a substring: the export target <dataset>_5m always contains <dataset>.
  if (!datasetsOf(q).includes(p.dataset)) return { use: false, reason: 'other-dataset' };
  if (!new RegExp(`export\\s+to\\s+lake\\s+${rollupDataset(p.dataset).replace(/[^\w]/g, '\\$&')}(?![\\w])`).test(q)) return { use: false, reason: 'wrong-target' };
  if (p.newestBucket === undefined) return { use: false, reason: 'empty' };
  if (p.nowS - p.newestBucket > maxLagS) return { use: false, reason: 'behind' };
  if (p.oldestBucket === undefined || p.oldestBucket > p.nowS - p.lookbackS + 600) return { use: false, reason: 'not-backfilled' };
  return { use: true };
}
