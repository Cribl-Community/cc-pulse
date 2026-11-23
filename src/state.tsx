import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { hostMode } from './lib/host';
import { api, items, kvGet, kvKeys, kvPut, runSearch, type Row } from './lib/api';
import { SNAPSHOT_CAP, readsRollup, rejectedRows, snapshotAge, snapshotQuery, snapshotVerdict, snapshotWins, type RowsOrigin, type SavedSearchLike, type SnapshotReason } from './lib/snapshot';
import { DEFAULT_SCOPE, fromParams, heartbeatSpan, previous, resolve, sparkSpan, type TimeScope, type Win } from './lib/timescope';
import { persistScope, resolveInitialScope, SCOPE_KEY } from './lib/scopeLoad';
import { putUrl, TimeScopeCtx } from './scopeContext';
import { computeNow as computeEntities } from './lib/computeNow';
import { activityParts, fleetParts, gapsCutEdges, gapsParts, lookbackSeconds, type HistoryParts, type HistoryWindow } from './lib/kql';
import { fetchRollupCheck, loadOverrides, type Override } from './lib/deploy';
import { applyOverride as overrideRows, applyWindows as windowRows, reapplyPending, type OverrideChange, type PendingChange } from './lib/overrideApply';
import { rollupMaxLagS, rollupVerdict as computeRollupVerdict, type RollupVerdict } from './lib/rollup';
import { sourcesOf } from './lib/sources';
import { loadClusters, loadInventory, loadRules, resolveInventory, type ClassRule, type Clusters, type Inventory } from './lib/inventory';
import { loadWindows, type Window } from './lib/maintenance';
import { applyClusters, toEntity, type Entity } from './lib/model';
import { fleetAvailability, incidentsOf, toLedger, type Incident, type Ledger } from './lib/history';
import { binSeries, runHistoryParts } from './lib/series';
import { newestDeployment as newestOf, setupState, type DeploymentRecord, type SetupState } from './lib/setup';
import { DEFAULT_AI, DEFAULT_SETTINGS, effectiveRollup, loadAi, loadSettings, type AiSettings, type AppSettings } from './lib/settings';
import { histDue, historyShouldRun, onVisible, tickDecision } from './lib/refresh';
import { cadenceOf } from './lib/cadence';
type HistKind = 'activity' | 'heartbeat' | 'gaps';

/** How often the refresh timer checks whether a cycle is due, and the activity / heartbeat job timeout (2 min). */
const CHECK_MS = 15_000, HIST_TIMEOUT = 2 * 60_000, ROLLUP_CHECK_MS = 15 * 60_000;

export type FleetPoint = { t: number; events: number; assets: number };

type Ctx = {
  settings: AppSettings; setSettings: (s: AppSettings) => void;
  ai: AiSettings; setAi: (a: AiSettings) => void;
  entities: Row[]; sources: Row[]; fleet: Entity[];
  activity: Record<string, number[]>; heartbeat?: FleetPoint[]; ledger?: Ledger;
  /** Explicit inventory as stored (edit this), and the view with classification rules applied (read this). */
  rawInventory: Inventory; inventory: Inventory; setInventory: (i: Inventory) => void;
  clusters: Clusters; setClusters: (c: Clusters) => void; rules: ClassRule[]; setRules: (r: ClassRule[]) => void;
  windows: Window[]; setWindows: (w: Window[]) => void;
  /** The active window, its previous period, and the sparkline bin span / count derived from it. */
  win: Win; prevWin: Win; actSpan: number; actBins: number;
  incidents: Incident[]; prevIncidents: Incident[]; availability?: number; prevAvailability?: number;
  /** A history result hit its row limit: that series may be incomplete. */
  truncated: { activity: boolean; heartbeat: boolean; gaps: boolean };
  /** The gap ledger for the current range is still loading (the ledger on hand, if any, is for another range): hide deltas. */
  histLoading: boolean;
  /** History queries have been started by loadCharts() (daily load); loadCharts() starts them. */
  historyLoaded: boolean; loadCharts: () => Promise<void>;
  loading: boolean; error?: string; updatedAt?: Date; demo: boolean;
  /** Spec 025 §3: where the entities on screen came from. `stateAsOf` (s) is the snapshot's max(computed_at), set
   *  for 'snapshot' and 'stale'; `stateReason` is why the snapshot was not used. T2: 'stale' = the snapshot was
   *  rejected and the rows on screen are the last ones loaded (for this dataset), as of `stateAsOf`. */
  stateSource: 'snapshot' | 'live' | 'stale'; stateAsOf?: number; stateReason?: SnapshotReason;
  /** Age (s) of the last snapshot when it was rejected. `computeNow` runs the entity search once, on demand. */
  stateAge?: number; computeNow: () => Promise<void>;
  /** A Compute now is in flight: its button shows pending, and another call does nothing until it settles. */
  computing: boolean;
  /** T3: after setOverride succeeds, the change shows on the entities at once (no entity search). Pulse's alerts pick
   *  it up from the lookup in their next cycle. A snapshot older than the change gets it re-applied on top. */
  applyOverride: (change: OverrideChange) => void;
  /** T3: after the maintenance windows are saved, the assets they cover (or stop covering) change state at once. */
  applyWindows: (windows: Window[]) => Promise<void>;
  /** Spec 026: whether the rollup dataset can be read (undefined until the first check lands). */
  rollupVerdict?: RollupVerdict;
  refresh: () => Promise<void>;
  /** Spec 019: first-run setup state, the newest deployment record (if any), and a reload of the KV deployment list. */
  setup: SetupState; newestDeployment: DeploymentRecord | null; reloadSetup: () => Promise<void>;
};
const PulseCtx = createContext<Ctx | null>(null);
export const usePulse = () => useContext(PulseCtx)!;

const nowS = () => Date.now() / 1000;
const curSearch = () => (typeof location === 'undefined' ? '' : location.search); // server render in tests
/** Spec 014 §6: one TimeScope for the whole app. Load order URL → KV `ui/timescope` → default. */
export function TimeScopeProvider({ children }: { children: ReactNode }) {
  // The URL is read synchronously before the first render, so no page can overwrite a deep link before it is used.
  const [init] = useState(() => { const search = curSearch(); return { search, r: resolveInitialScope(search, undefined, nowS()) }; });
  const fromUrl = init.r.source === 'url';
  const [scope, setScopeState] = useState(init.r.scope);
  const [ready, setReady] = useState(fromUrl); // false while KV loads: the mount helper waits for it
  const [notice, setNotice] = useState<string>();
  const touched = useRef(false);

  useEffect(() => {
    if (fromUrl) return;
    kvGet<unknown>(SCOPE_KEY, undefined).then((kv) => {
      // A setScope made while KV was loading wins over the stored value (and its notice would name the wrong range).
      if (!touched.current) { const r = resolveInitialScope(init.search, kv, nowS()); setScopeState(r.scope); setNotice(r.toast); }
      setReady(true);
    });
  }, []); // eslint-disable-line

  const setScope = useCallback((s: TimeScope) => {
    touched.current = true; setScopeState(s); setReady(true); setNotice(undefined);
    persistScope(s, kvPut); // fire-and-forget
    putUrl(s, true);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const s = fromParams(new URLSearchParams(location.search));
      if (s) { touched.current = true; setScopeState(s); persistScope(s, kvPut); }
    };
    addEventListener('popstate', onPop);
    return () => removeEventListener('popstate', onPop);
  }, []);

  return <TimeScopeCtx.Provider value={{ scope, setScope, ready, notice }}>{children}</TimeScopeCtx.Provider>;
}

export function PulseProvider({ children }: { children: ReactNode }) {
  const [DEMO] = useState(() => hostMode() === 'demo'); // once per mount; demo data outside Cribl
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [ai, setAi] = useState(DEFAULT_AI);
  const [entities, setEntities] = useState<Row[]>([]);
  const [activity, setActivity] = useState<Record<string, number[]>>({});
  const [heartbeat, setHeartbeat] = useState<FleetPoint[]>();
  const [ledger, setLedger] = useState<Ledger>();
  const [histLoading, setHistLoading] = useState(true);
  const histSeq = useRef<Record<HistKind, number>>({ activity: 0, heartbeat: 0, gaps: 0 }); // per-job sequence counters
  const histCtl = useRef<Record<HistKind, AbortController | undefined>>({ activity: undefined, heartbeat: undefined, gaps: undefined });
  const histLast = useRef<Record<HistKind, { at: number; rangeKey: string } | undefined>>({ activity: undefined, heartbeat: undefined, gaps: undefined });
  const ledgerKey = useRef<string | undefined>(undefined); // the range ('earliest|latest') the ledger is for
  const [rawInventory, setInventory] = useState<Inventory>({});
  const [clusters, setClusters] = useState<Clusters>({});
  const [rules, setRules] = useState<ClassRule[]>([]);
  const [windows, setWindows] = useState<Window[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [updatedAt, setUpdatedAt] = useState<Date>();
  const [stateSource, setStateSource] = useState<'snapshot' | 'live' | 'stale'>('live');
  const [stateAsOf, setStateAsOf] = useState<number>();
  /** T2: the settings dataset the entities on screen were loaded for, and their as-of time (s). Undefined: no rows. */
  const rowsOrigin = useRef<RowsOrigin | undefined>(undefined);
  /** T3: override / window changes applied in memory, newest last, until a snapshot or compute includes them. */
  const pending = useRef<PendingChange[]>([]);
  const [stateReason, setStateReason] = useState<SnapshotReason>();
  /** Age (s) of the last snapshot read when it was rejected; undefined when there was none. */
  const [stateAge, setStateAge] = useState<number>();
  /** When the last live entity result landed (ms): an older snapshot never replaces it. */
  const liveAt = useRef<number | undefined>(undefined);
  const [rollupVerdict, setRollupVerdict] = useState<RollupVerdict>();
  /** The last verdict, with the dataset it was computed for and the oldest bucket the rollup holds. A verdict for
   *  another dataset (e.g. right after Move to Parquet) is never used: reads stay raw until the new check lands. */
  const verdictRef = useRef<{ dataset: string; v: RollupVerdict; oldestS?: number } | undefined>(undefined);
  /** The rollup check in flight (or the last one). History jobs and the live fallback wait for it; the snapshot doesn't. */
  const rollupCheck = useRef<Promise<void> | undefined>(undefined);
  const rollupCheckKey = useRef<string | undefined>(undefined);
  /** The search load the periodic check last ran under: its rollup.maxLagS is the verdict's lag limit. */
  const rollupCheckLoad = useRef<string | undefined>(undefined);
  /** Only the newest check may write the verdict: an older one finishing last (e.g. across a dataset change) is dropped. */
  const rollupSeq = useRef(0);
  /** The settings of the latest render: the 15 min rollup timer reads them at fire time, never the ones it was started with. */
  const rollupSettings = useRef(settings);
  useEffect(() => { rollupSettings.current = settings; }, [settings]);
  /** Spec 026: one cheap job (newest/oldest bucket of the _5m dataset) plus the saved-search list -> rollupVerdict. */
  const checkRollup = useCallback(async (s: AppSettings) => {
    if (DEMO || effectiveRollup(s) !== 'auto') return;
    const seq = ++rollupSeq.current;
    const lookbackS = lookbackSeconds(s.learning.LOOKBACK);
    const { rows, saved } = await fetchRollupCheck(s);
    if (seq !== rollupSeq.current) return; // superseded by a newer check
    const num = (v: unknown) => { const x = Number(v); return v === null || v === undefined || !Number.isFinite(x) ? undefined : x > 1e11 ? x / 1000 : x; };
    const oldestS = num(rows[0]?.oldest);
    // Spec 033: the lag limit follows the search load (Hourly 4800 s), not Standard's 1500 s.
    const v = computeRollupVerdict({ saved, dataset: s.dataset, newestBucket: num(rows[0]?.newest), oldestBucket: oldestS, nowS: nowS(), lookbackS,
      maxLagS: rollupMaxLagS(s.searchLoad) });
    verdictRef.current = { dataset: s.dataset, v, oldestS }; setRollupVerdict(v);
  }, [DEMO]);
  /** Starts a check now and records it, so the reads that need the verdict can wait for it. Never throws. */
  const startRollupCheck = useCallback((s: AppSettings) => {
    if (effectiveRollup(s) !== 'auto') { setRollupVerdict(undefined); return Promise.resolve(); }
    rollupCheckKey.current = `${s.dataset}|${s.learning.LOOKBACK}`;
    if (verdictRef.current?.dataset !== s.dataset) setRollupVerdict(undefined); // the Overview line follows the dataset
    const p = checkRollup(s).catch(() => undefined);
    rollupCheck.current = p;
    return p;
  }, [checkRollup]);
  /** The verdict for this dataset when it says use, else undefined (read raw). */
  const rollupUse = (s: AppSettings) => {
    const r = verdictRef.current;
    return effectiveRollup(s) === 'auto' && r?.dataset === s.dataset && r.v.use === true ? r : undefined;
  };

  const sc = useContext(TimeScopeCtx) ?? { scope: DEFAULT_SCOPE, ready: true }; // tests render PulseProvider alone
  const scope = sc.scope;
  const [loaded, setLoaded] = useState(false);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const historyLoadedRef = useRef(false), histOpened = useRef(false);
  const [win, setWin] = useState<Win>(() => resolve(scope, nowS()) ?? resolve(DEFAULT_SCOPE, nowS())!);
  const [truncated, setTruncated] = useState({ activity: false, heartbeat: false, gaps: false });
  const scopeRef = useRef(scope);
  useEffect(() => { scopeRef.current = scope; }, [scope]);
  /** In-flight counters (busy while > 0) for the live entity search and the history jobs, and the last live refresh (ms). */
  const liveBusy = useRef(0), histBusy = useRef(0), lastRefresh = useRef<number | undefined>(undefined);
  const toFleet = (rows: Row[]) => rows.map((r) => ({ t: Number(r.b), events: Number(r.events) || 0, assets: Number(r.assets) || 0 })).sort((a, b) => a.t - b.t);

  /** One refresh: `live` = the 2 live jobs (learning.LOOKBACK, now); `hist` = the 3 history jobs over the window
   *  (activity, fleet heartbeat, and ONE gap ledger spanning the previous period plus MAX_GAP). */
  /** `snap` (open and ticks, never an explicit refresh()): read the pulse_state snapshot first and skip the entity job
   *  when its verdict is use. */
  const run = useCallback(async (s: AppSettings, sc: TimeScope, live: boolean, hist: boolean) => {
    const w = resolve(sc, nowS());
    // Daily: no history query runs until loadCharts() (which sets the flag first); ticks are gated by their caller.
    if (hist && !historyShouldRun({ historyOnTick: cadenceOf(s.searchLoad, s.rollCall).historyOnTick, loaded: historyLoadedRef.current, trigger: 'timescope' })) hist = false;
    if (DEMO) { // demo data follows the window and its bin spans, like the real jobs
      if (live) lastRefresh.current = Date.now(); // demo follows the refresh setting like live mode
      if (!hist || !w) return;
      const d = await import('./lib/demo');
      setWin(w);
      setActivity(d.activity(w, sparkSpan(w))); setHeartbeat(toFleet(d.fleet(w, heartbeatSpan(w)))); setLedger(toLedger(d.gaps(w, s.learning.MAX_GAP)));
      setHistLoading(false);
      return;
    }
    if (hist && w) {
      setWin(w);
      // Spec 026: the history jobs wait for the rollup check in flight (on open, or right after a dataset change), so
      // they never read raw just because the verdict hasn't landed yet. The wait counts as busy, so no tick stacks up.
      histBusy.current++;
      const s0 = s; // the settings of this call: the live path below re-binds `s` to its own rollup mode
      void (rollupCheck.current ?? Promise.resolve()).finally(() => { histBusy.current--; }).then(() => launchHistory(w, s0));
    }
    function launchHistory(w: Win, s: AppSettings) {
      const sp = sparkSpan(w), gFrom = previous(w).from - s.learning.MAX_GAP, e = (v: number) => String(Math.floor(v));
      /** `f` returns false for a stale result (a newer job superseded it): nothing is applied.
       *  Each job counts itself in `histBusy` until it settles, so overlapping runs never clear the flag early. */
      const rangeKey = `${sc.earliest}|${sc.latest}|${sc.tz}`, isLive = sc.latest === 'now', now = nowS();
      const due = (k: HistKind) => histDue({ job: k, rangeKey, live: isLive, last: histLast.current[k], nowS: now, span: heartbeatSpan(w) });
      // Spec 026: the rollup variants only when the setting is 'auto', the verdict for this dataset says use and the
      // window is longer than 1 h (≤ 1 h stays raw, also for the gap ledger whose own range is wider). Otherwise raw.
      // rollupFromS: a window that starts before the rollup's oldest bucket reads raw (kql.ts plan()).
      const ru = w.to - w.from > 3600 ? rollupUse(s) : undefined;
      const hs: AppSettings = { ...s, rollup: ru ? 'auto' : 'off' };
      const hw = (from: number): HistoryWindow => ({ earliestS: from, latestS: w.to, nowS: now, rollupFromS: ru?.oldestS });
      const job = (k: HistKind, p: HistoryParts, from: number, ms: number, lim: number, f: (r: Row[]) => void, fail?: () => void) => {
        const seq = ++histSeq.current[k]; // only the latest job of this kind may apply its result
        histCtl.current[k]?.abort(); // a newer job supersedes the older one
        const ctl = new AbortController(); histCtl.current[k] = ctl;
        histLast.current[k] = { at: now, rangeKey };
        histBusy.current++;
        // raw: the one raw query; rollup+tail: rollup, raw tail (and for gaps the cut edges) merged by mergeHistory
        return runHistoryParts(k, p, k === 'gaps' ? gapsCutEdges(hs) : undefined, e(from), e(w.to), ms, lim, { signal: ctl.signal }).then((r) => {
          if (seq !== histSeq.current[k]) return;
          f(r); setTruncated((t) => ({ ...t, [k]: r.length >= lim }));
        }).catch((err) => {
          if ((err instanceof Error && err.name === 'AbortError') || ctl.signal.aborted) return; // superseded, not a user error
          if (seq !== histSeq.current[k]) return;
          fail?.();
        }).finally(() => { histBusy.current--; });
      };
      if (due('activity'))
        job('activity', activityParts(hs, sp, undefined, hw(w.from)), w.from, HIST_TIMEOUT, 50_000, (r) => setActivity(binSeries(r, sp, Math.max(1, Math.ceil((w.to - w.from) / sp)), (x) => `${x.worker_group}|${x.input}|${x.asset}`, w.to)));
      if (due('heartbeat'))
        job('heartbeat', fleetParts(hs, heartbeatSpan(w), hw(w.from)), w.from, HIST_TIMEOUT, 400, (r) => setHeartbeat(toFleet(r)));
      // Deltas hide from the moment the range changes until its own ledger lands: the old ledger doesn't cover the new
      // previous period. A same-range refresh keeps them (the ledger on hand is for this range, a refresh tick behind).
      if (due('gaps')) {
        const key = `${sc.earliest}|${sc.latest}`;
        if (ledgerKey.current !== key) setHistLoading(true);
        job('gaps', gapsParts(hs, undefined, hw(gFrom)), gFrom, 180_000, 20_000 * Math.ceil((w.to - gFrom) / 86400), (r) => {
          setLedger(toLedger(r)); ledgerKey.current = key; setHistLoading(false);
        }, () => {
          if (ledgerKey.current !== key) { setLedger(undefined); ledgerKey.current = undefined; } // never compare against another range
          setHistLoading(false);
        });
      }
    }
    if (!live) return;
    liveBusy.current++;
    setLoading(true); setError(undefined);
    try {
      let reason: SnapshotReason | undefined, age: number | undefined;
      {
        // Both reads start together. A failed read counts as no rows / no saved search, so the verdict falls back to live.
        const cad = cadenceOf(s.searchLoad, s.rollCall);
        const [rows, saved] = await Promise.all([
          runSearch(snapshotQuery(cad), cad.snapshotEarliest, 'now', 30_000, SNAPSHOT_CAP).catch((): Row[] => []),
          api<{ items?: SavedSearchLike[] }>(`/m/default_search/search/saved/${cad.snapshotJob}`).then((r) => items(r)[0] ?? null).catch(() => null),
        ]);
        // A rollup-mode pulse_state is used only while the rollup is in use: only then does this read wait for the check.
        if (readsRollup(saved?.query, s.dataset)) await rollupCheck.current;
        const v = snapshotVerdict({ saved, dataset: s.dataset, rows, nowS: nowS(), rollupOk: !!rollupUse(s), maxAgeS: cad.snapshotMaxAgeS });
        if (v.use) {
          // Entities and their source fields change together, so stateSource/stateAsOf always describe what is shown.
          // A snapshot older than the last live result is skipped and the live fields stay as they are.
          if (snapshotWins(liveAt.current, v.asOf)) {
            // T3: an override or window applied after this snapshot was computed stays on screen until a snapshot has it.
            const re = reapplyPending(rows, pending.current, v.asOf, s.learning, Date.now());
            pending.current = re.pending;
            setEntities(rows); setUpdatedAt(new Date(v.asOf * 1000));
            setStateSource('snapshot'); setStateAsOf(v.asOf); setStateReason(undefined); setStateAge(undefined);
            if (re.pending.length) setEntities(re.rows); // the snapshot's rows with the newer changes on top
            rowsOrigin.current = { dataset: s.dataset, asOf: v.asOf };
          }
          return; // no entity job
        }
        reason = v.reason; age = snapshotAge(rows, nowS());
      }
      // Rollup mode only when the setting is 'auto' and the verdict for this dataset says use; otherwise raw. Only this
      // fallback waits for a check in flight: the snapshot read above never does.
      // The snapshot was rejected: nothing is computed here. The reason and the age of the last snapshot (if any)
      // are exposed; only the computeNow action runs the entity search.
      // T2: the rows on screen are never labelled Live here. Rows loaded for another dataset (or none) are cleared;
      // otherwise they stay, marked 'stale' with their own as-of time.
      const kept = rejectedRows(rowsOrigin.current, s.dataset);
      if (kept.keep) { setStateSource(kept.source); setStateAsOf(kept.asOf); }
      else { rowsOrigin.current = undefined; setEntities([]); setUpdatedAt(undefined); setStateSource('live'); setStateAsOf(undefined); }
      setStateReason(reason); setStateAge(age);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { liveBusy.current--; lastRefresh.current = Date.now(); setLoading(false); } // a failed cycle also waits a full interval
  }, [DEMO]);
  const [deployments, setDeployments] = useState<DeploymentRecord[]>();
  const [kvListFailed, setKvListFailed] = useState(false);
  const [setupLoaded, setSetupLoaded] = useState(DEMO);
  /** Reads only: the keys POST, then a GET per key. A failed key list is kept as a flag. */
  const reloadSetup = useCallback(async () => {
    if (DEMO) return;
    try {
      const keys = await kvKeys('deployments/');
      const recs = await Promise.all(keys.map((k) => kvGet<DeploymentRecord | null>(k, null)));
      setDeployments(recs.filter((r): r is DeploymentRecord => !!r)); setKvListFailed(false);
    } catch { setDeployments(undefined); setKvListFailed(true); }
    setSetupLoaded(true);
  }, [DEMO]);
  const refresh = useCallback(async (s = settings) => { void reloadSetup(); histLast.current = { activity: undefined, heartbeat: undefined, gaps: undefined }; /* explicit: rerun all */ await run(s, scopeRef.current, true, true); }, [settings, run, reloadSetup]);
  /** Daily: the charts' history queries start only here (a user action); afterwards a TimeScope change re-runs them. */
  /** Called before the settings or the scope have landed (a page opened directly), it only sets the flag: the history
   *  effect below then runs the queries once, with the real settings and scope (trigger 'open', loaded). */
  const loadCharts = useCallback(async () => {
    historyLoadedRef.current = true; setHistoryLoaded(true);
    if (!loaded || !sc.ready) return;
    await run(settings, scopeRef.current, false, true);
  }, [settings, run, loaded, sc.ready]);

  /** One on-demand entity compute. It leaves liveAt alone, so the next refresh reads the snapshot and may replace it. */
  /** In-flight guard: a second Compute now while one runs does nothing (the ref, since state updates are async). */
  const computeBusy = useRef(false);
  const [computing, setComputing] = useState(false);
  const computeNow = useCallback(async () => {
    if (DEMO || computeBusy.current) return;
    computeBusy.current = true; setComputing(true);
    liveBusy.current++; setLoading(true); setError(undefined);
    try {
      await rollupCheck.current;
      const startS = nowS(); // the compute reads the lookups as published now: changes before this are in its rows
      const e = await computeEntities({ ...settings, rollup: rollupUse(settings) ? 'auto' : 'off' });
      const re = reapplyPending(e, pending.current, startS, settings.learning, Date.now());
      pending.current = re.pending;
      setEntities(e); setUpdatedAt(new Date()); rowsOrigin.current = { dataset: settings.dataset, asOf: nowS() };
      // The entities on screen are fresh now, so the "Snapshot not used" Alert goes away until a refresh rejects again.
      setStateSource('live'); setStateAsOf(undefined); setStateReason(undefined); setStateAge(undefined);
      if (re.pending.length) setEntities(re.rows); // T3: a change made while the compute ran stays on top
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { liveBusy.current--; setLoading(false); computeBusy.current = false; setComputing(false); }
  }, [DEMO, settings]); // eslint-disable-line

  /** T3: no recompute after an action (each would be a ~50 CPU-s 24 h read). The rows on screen are patched instead. */
  const applyOverride = useCallback((change: OverrideChange) => {
    pending.current = [...pending.current, { kind: 'override', change, atS: nowS() }];
    setEntities((rows) => overrideRows(rows, change, settings.learning, Date.now()));
  }, [settings.learning]);
  const applyWindows = useCallback(async (list: Window[]) => {
    // The override list (a KV read, not a search) gives the state an asset falls back to when a window stops covering it.
    const overrides: Override[] = DEMO ? [] : await loadOverrides().catch((): Override[] => []);
    pending.current = [...pending.current, { kind: 'windows', windows: list, overrides, atS: nowS() }];
    setEntities((rows) => windowRows(rows, list, overrides, settings.learning, Date.now()));
  }, [DEMO, settings.learning]);

  useEffect(() => { (async () => {
    if (DEMO) {
      const d = await import('./lib/demo');
      setInventory(d.inventory()); setClusters(d.clusters()); setRules(d.rules()); setWindows(d.windows());
      setEntities(d.entities());
      lastRefresh.current = Date.now();
      setUpdatedAt(new Date()); setLoading(false); setLoaded(true); return; // the history effect fills activity, heartbeat and ledger
    }
    const [s, a, inv, cl, ru, w] = await Promise.all([loadSettings(), loadAi(), loadInventory(), loadClusters(), loadRules(), loadWindows(), reloadSetup()]);
    setSettings(s); setAi(a); setInventory(inv); setClusters(cl); setRules(ru); setWindows(w);
    void startRollupCheck(s); // before setLoaded: the history effect and the live fallback wait for it, the snapshot doesn't
    setLoaded(true);
    await run(s, scopeRef.current, true, false); // opens from the snapshot when it is usable
  })(); }, []); // eslint-disable-line
  // History follows the scope (once the scope and settings are settled). A timer tick never re-runs it for an absolute range.
  useEffect(() => {
    if (!loaded || !sc.ready) return;
    const trigger = histOpened.current ? 'timescope' : 'open';
    histOpened.current = true;
    if (historyShouldRun({ historyOnTick: cadenceOf(settings.searchLoad, settings.rollCall).historyOnTick, loaded: historyLoadedRef.current, trigger })) void run(settings, scope, false, true);
  }, [loaded, sc.ready, scope.earliest, scope.latest, scope.tz]); // eslint-disable-line
  // Spec 025 §1: a 15 s check asks tickDecision whether a cycle is due (never while hidden, in flight, or on 'manual').
  // Coming back to the tab runs a cycle at once when the data is at least one interval old.
  useEffect(() => {
    const onTick = historyShouldRun({ historyOnTick: cadenceOf(settings.searchLoad, settings.rollCall).historyOnTick, loaded: historyLoadedRef.current, trigger: 'tick' });
    const cycle = () => void run(settings, scopeRef.current, true, onTick && scopeRef.current.latest === 'now');
    const inFlight = () => liveBusy.current > 0 || histBusy.current > 0;
    const t = setInterval(() => {
      if (tickDecision({ choice: settings.refresh, hidden: document.hidden, inFlight: inFlight(), lastAt: lastRefresh.current, nowMs: Date.now() }) === 'run') cycle();
    }, CHECK_MS);
    const onVis = () => {
      if (document.hidden || inFlight()) return;
      if (onVisible({ choice: settings.refresh, lastAt: lastRefresh.current, nowMs: Date.now() })) cycle();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); };
  }, [settings, run]);

  // Spec 026: the rollup check repeats every 15 min; the timer is cleared on unmount. A dataset (or lookback) change
  // checks at once: until it lands, rollupUse() reads raw, since the verdict on hand is for the old dataset.
  // settings.rollup is a dependency: off -> auto starts a check and the timer at once, auto -> off clears the timer.
  useEffect(() => {
    if (DEMO || !loaded) return;
    if (effectiveRollup(settings) !== 'auto') { // Economy: no _5m check at all
      rollupCheckKey.current = undefined; rollupCheckLoad.current = settings.searchLoad; rollupSeq.current++; verdictRef.current = undefined; // the exposed rollupVerdict is cleared in render below
      return;
    }
    if (rollupCheckKey.current !== `${settings.dataset}|${settings.learning.LOOKBACK}`) void startRollupCheck(settings);
    // Spec 033: a search-load change moves the lag limit (rollup.maxLagS), so the verdict is recomputed for it.
    else if (rollupCheckLoad.current !== undefined && rollupCheckLoad.current !== settings.searchLoad) void checkRollup(settings).catch(() => undefined);
    rollupCheckLoad.current = settings.searchLoad;
    // The periodic re-check doesn't make reads wait: the verdict on hand is for this dataset and stays valid meanwhile.
    const t = setInterval(() => { void checkRollup(rollupSettings.current).catch(() => undefined); }, ROLLUP_CHECK_MS);
    return () => clearInterval(t);
  }, [DEMO, loaded, settings.dataset, settings.rollup, settings.learning.LOOKBACK, settings.searchLoad, checkRollup, startRollupCheck]); // eslint-disable-line

  const sources = useMemo(() => sourcesOf(entities), [entities]);
  const seen = useMemo(() => entities.map((r) => ({ asset: String(r.asset), input: String(r.input) })), [entities]);
  const inventory = useMemo(() => resolveInventory(rawInventory, rules, seen), [rawInventory, rules, seen]);
  const fleet = useMemo(() => applyClusters(entities.map((r) => toEntity(r, settings.learning)), inventory, clusters), [entities, settings.learning, inventory, clusters]);
  const prevWin = useMemo(() => previous(win), [win]);
  const hist = useMemo(() => {
    const now = nowS();
    return ledger ? {
      incidents: incidentsOf(fleet, ledger, win, now), prevIncidents: incidentsOf(fleet, ledger, prevWin, now),
      availability: fleetAvailability(fleet, ledger, win, now), prevAvailability: fleetAvailability(fleet, ledger, prevWin, now),
    } : { incidents: [], prevIncidents: [], availability: undefined, prevAvailability: undefined };
  }, [fleet, ledger, win, prevWin]);
  const setup = setupState({ demo: DEMO, deployments: kvListFailed ? undefined : deployments, fleetCount: fleet.length,
    loading: !DEMO && (!loaded || !setupLoaded || loading && updatedAt === undefined), error });
  const newest = useMemo(() => newestOf(deployments), [deployments]);
  const actSpan = sparkSpan(win), actBins = Math.max(1, Math.ceil((win.to - win.from) / actSpan));
  return <PulseCtx.Provider value={{ settings, setSettings, ai, setAi, entities, sources, fleet, activity, heartbeat, ledger,
    win, prevWin, actSpan, actBins, ...hist, truncated, histLoading, historyLoaded, loadCharts,
    rawInventory, inventory, setInventory, clusters, setClusters, rules, setRules, windows, setWindows,
    loading, error, updatedAt, demo: DEMO, refresh: () => refresh(), stateSource, stateAsOf, stateReason, stateAge, computeNow, computing, applyOverride, applyWindows, rollupVerdict: effectiveRollup(settings) === 'auto' ? rollupVerdict : undefined,
    setup, newestDeployment: newest, reloadSetup }}>{children}</PulseCtx.Provider>;
}

export const STATE_COLOR = { missing: 'danger', late: 'warning', delayed: 'warning', covered: 'info', acked: 'info', ok: 'success', learning: 'info', maintenance: 'default', muted: 'default' } as const;
export type { AssetState } from './lib/model';
