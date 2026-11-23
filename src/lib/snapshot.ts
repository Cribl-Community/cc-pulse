// Pure helpers for reading the `pulse_state` snapshot (spec 025 §3). No imports, no React, no fetch.

export const SNAPSHOT_JOB = 'pulse_state';
export const SNAPSHOT_CAP = 50_000;
export const SNAPSHOT_MAX_AGE_S = 900;

export type SnapshotReason = 'no-search' | 'disabled' | 'exports' | 'other-dataset' | 'rollup' | 'empty' | 'truncated' | 'stale';
export type SnapshotVerdict = { use: true; asOf: number } | { use: false; reason: SnapshotReason };

export interface SavedSearchLike {
  query?: string;
  schedule?: { enabled?: boolean };
}

/** What snapshotQuery needs from a Cadence (structural, so this module keeps no imports). */
export type SnapshotCadence = { snapshotJob: string; snapshotEarliest: string };
const LOAD_SNAPSHOT: Record<string, SnapshotCadence> = {
  standard: { snapshotJob: 'pulse_state', snapshotEarliest: '-1h' },
  hourly: { snapshotJob: 'pulse_state', snapshotEarliest: '-2h' },
  daily: { snapshotJob: 'pulse_roll_call', snapshotEarliest: '-26h' },
};
function snapCadence(load: string | SnapshotCadence | undefined): SnapshotCadence {
  if (load && typeof load === 'object') return load;
  return LOAD_SNAPSHOT[load ?? 'standard'] ?? LOAD_SNAPSHOT.standard;
}

/** The query reading the snapshot of a load (or a cadence). Standard is unchanged from spec 025. */
export function snapshotQuery(load?: string | SnapshotCadence): string {
  return `dataset="$vt_results" | where jobName == "${snapCadence(load).snapshotJob}"`;
}

/** The `earliest` to run snapshotQuery with: cadence.snapshotEarliest. */
export function snapshotEarliest(load?: string | SnapshotCadence): string {
  return snapCadence(load).snapshotEarliest;
}

/** The saved search that produces the snapshot: cadence.snapshotJob. */
export function snapshotJobOf(load?: string | SnapshotCadence): string {
  return snapCadence(load).snapshotJob;
}

const DATASET_RE = /\bdataset\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s|"')]+))/g;

/** The dataset a query reads: `dataset="x"`, `dataset='x'` or `dataset=x`; otherwise undefined. The first one wins. */
export function datasetOf(query: string | undefined | null): string | undefined {
  return datasetsOf(query)[0];
}

/** Every dataset a query reads, in order (a rollup-mode body reads `<ds>_5m` and then `<ds>`). */
export function datasetsOf(query: string | undefined | null): string[] {
  if (typeof query !== 'string') return [];
  return [...query.matchAll(DATASET_RE)].map((m) => m[1] ?? m[2] ?? m[3]);
}

/** True when a saved query reads the spec 026 rollup of `dataset` (a rollup-mode pulse_state). */
export function readsRollup(query: string | undefined | null, dataset: string | undefined): boolean {
  return dataset !== undefined && datasetsOf(query).includes(`${dataset}_5m`);
}

/** The app's own saved-search results. Reading it is not reading "another dataset": the Economy roll call
 *  (spec 033 §4) carries the previous roll call forward from `$vt_results`. */
export const VT_RESULTS = '$vt_results';

/** True when the query reads `dataset`, and otherwise only its spec 026 rollup `<dataset>_5m` or the app's own
 *  results `$vt_results` (the roll call's carry-forward). A query with no user dataset matches an undefined
 *  `dataset` (unchanged from spec 025). Kept inline: this module has no imports. */
function readsDataset(query: string, dataset: string | undefined): boolean {
  const ds = datasetsOf(query).filter((d) => d !== VT_RESULTS);
  if (dataset === undefined) return ds.length === 0;
  return ds.includes(dataset) && ds.every((d) => d === dataset || d === `${dataset}_5m`);
}

function parseTs(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return NaN;
}

/** Spec 025 §3: a snapshot never replaces newer live data. `liveAtMs` is when the last live result landed (ms),
 *  `asOfS` the snapshot's max(computed_at) (s). True when the snapshot may replace the entities. */
export function snapshotWins(liveAtMs: number | undefined, asOfS: number): boolean {
  return liveAtMs === undefined || liveAtMs <= asOfS * 1000;
}

const REASON_MESSAGE: Record<SnapshotReason, string> = {
  'no-search': 'The Pulse snapshot search pulse_state does not exist: re-apply Settings → Alerts',
  disabled: 'The Pulse snapshot search is not scheduled: re-apply Settings → Alerts',
  exports: 'The Pulse snapshot search still exports to a lookup: re-apply Settings → Alerts',
  'other-dataset': 'The Pulse snapshot reads another dataset: re-apply Settings → Alerts',
  rollup: "The Pulse snapshot reads the rollup, which is not in use right now, so it can't be used. Compute now runs the asset search once.",
  empty: "The Pulse snapshot has no results yet, so it can't be used. Compute now runs the asset search once.",
  truncated: "The Pulse snapshot hit its row limit, so it can't be used. Compute now runs the asset search once.",
  stale: "The Pulse snapshot is older than 15 minutes, so it can't be used. Compute now runs the asset search once.",
};

/** Human message for why the snapshot was not used (the Overview's Snapshot not used Alert and Live tooltip).
 *  Nothing reads live data on its own (spec 034 §4): only Compute now runs the asset search, once. */
export function reasonMessage(reason: SnapshotReason): string {
  return REASON_MESSAGE[reason] ?? "The Pulse snapshot can't be used. Compute now runs the asset search once.";
}

/** Where the entities on screen came from: the settings dataset they were loaded for and their as-of time (s). */
export type RowsOrigin = { dataset: string | undefined; asOf: number };
export type RejectedRows = { keep: false } | { keep: true; source: 'stale'; asOf: number };

/** T2: what a rejected snapshot does to the entities on screen. No entity search runs either way (spec 034 §4).
 *  No rows, or rows loaded for another dataset than the settings' → clear them (and updatedAt). Otherwise keep them,
 *  marked 'stale' with their own as-of time, so they are never labelled Live. */
export function rejectedRows(rows: RowsOrigin | null | undefined, dataset: string | undefined): RejectedRows {
  if (!rows || rows.dataset !== dataset || !Number.isFinite(rows.asOf)) return { keep: false };
  return { keep: true, source: 'stale', asOf: rows.asOf };
}

/** R1: title of the empty state every page shows instead of "no assets" / "not deployed" during a snapshot gap. */
export const SNAPSHOT_GAP_TITLE = 'Asset state not loaded';

/** R1: the snapshot was rejected and no rows are on screen (rejectedRows cleared them). An empty fleet then says
 *  nothing about the assets or the deployment, so pages must not show "No assets yet", "not deployed" or
 *  "has not sent anything": they show the reason and Compute now instead. Stale rows on screen are not a gap. */
export function snapshotGap(a: { demo?: boolean; stateReason?: SnapshotReason; stateSource?: string; fleetCount: number }): boolean {
  return !a.demo && !!a.stateReason && a.stateSource !== 'snapshot' && (a.fleetCount ?? 0) === 0;
}

/** Age (s) of the newest row of the last snapshot read, or undefined when there is none. */
export function snapshotAge(rows: ReadonlyArray<Record<string, unknown>> | null | undefined, nowS: number): number | undefined {
  let asOf = -Infinity;
  for (const r of rows ?? []) {
    const t = parseTs(r?.computed_at);
    if (Number.isFinite(t) && t > asOf) asOf = t;
  }
  return asOf === -Infinity ? undefined : Math.max(0, nowS - asOf);
}

export function snapshotVerdict(a: {
  saved: SavedSearchLike | null | undefined;
  dataset: string | undefined;
  rows: ReadonlyArray<Record<string, unknown>> | null | undefined;
  nowS: number;
  /** Spec 026: the rollup verdict for this dataset says use. A snapshot computed from the rollup is used only then,
   *  since pulse_state has no rollup_ok guard and would keep reading a rollup that fell behind. */
  rollupOk?: boolean;
  /** Oldest acceptable snapshot, in seconds. Default 900 (spec 025); a daily roll call passes 90000. */
  maxAgeS?: number;
}): SnapshotVerdict {
  const { saved, dataset, nowS } = a;
  const rows = a.rows ?? [];
  if (!saved) return { use: false, reason: 'no-search' };
  if (saved.schedule?.enabled !== true) return { use: false, reason: 'disabled' };
  const q = saved.query ?? '';
  if (/\|\s*export\b/.test(q)) return { use: false, reason: 'exports' };
  if (!readsDataset(q, dataset)) return { use: false, reason: 'other-dataset' };
  if (readsRollup(q, dataset) && a.rollupOk !== true) return { use: false, reason: 'rollup' };
  if (rows.length === 0) return { use: false, reason: 'empty' };
  if (rows.length >= SNAPSHOT_CAP) return { use: false, reason: 'truncated' };
  let asOf = -Infinity;
  for (const r of rows) {
    const t = parseTs(r?.computed_at);
    if (Number.isFinite(t) && t > asOf) asOf = t;
  }
  if (asOf === -Infinity || nowS - asOf > (a.maxAgeS ?? SNAPSHOT_MAX_AGE_S)) return { use: false, reason: 'stale' };
  return { use: true, asOf };
}
