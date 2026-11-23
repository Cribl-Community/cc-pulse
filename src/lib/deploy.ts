import { api, items, runSearch, commitGroup, deployGroup, kvGet, kvPut, listDatasets, publishLookup, setPackVar, ApiError, type LakeDataset, type Row } from './api';
import { savedSearches, rollupQuery, lookbackSeconds, ROLL_CALL_MESSAGE } from './kql';
import { cadenceOf, normalizeLoad } from './cadence';
import { rollupDataset, rollupMaxLagS, rollupVerdict, type RollupVerdict } from './rollup';
import { loadClusters, loadInventory, loadRules, publishInventory } from './inventory';
import { loadWindows, publishWindows } from './maintenance';
import { defaultEvents, validDestination, type AppSettings } from './settings';
import { channelRows, disabledSaved } from './channels';
import { routeFilterFor } from './routeFilter';
import { baseIdOf, defaultSearchId, defaultSearchQuery, defaultTargetOrder, effectiveCondition, isRouteNotification, notificationsFor, oneTargetProblem, routeSearchId,
  routeSearchQuery, rollCallNotifications, routesFor, routingMode, searchKind, shiftCron, staleDefaults, staleNotifications, vtSearches,
  type NotificationBody, type Route } from './routes';
import { listTargets } from './channelsApi';
import { MAX_SPAN_S } from './timescope';

export { routeFilterFor };
export { listTargets } from './channelsApi';

export const PACK_ID = 'cribl-pulse';
export const PACK_VERSION = '1.3.0';
export const ROUTE_ID = 'pulse_observer';
const SEARCH = '/m/default_search';

/** A confirmable unit of work. Nothing runs until the user applies the plan.
 *  `needs` (spec 016): ids of earlier steps this one depends on. When the user skips a failed step, the steps that
 *  need it are skipped too, instead of running against a half-built config (a route to a destination that isn't there). */
/** `lines`: extra plan lines under the detail, e.g. one per notification the step writes (spec 035). */
export type Step = { id: string; title: string; detail: string; lines?: string[]; volatile?: boolean; needs?: string[]; run: () => Promise<string> };

const quote = (s: string) => `'${s.replace(/'/g, "\\'")}'`;

/** Stream's refusal to re-install the version that is already there. The pre-check below normally avoids it; this
 *  covers a pack list that omits `version`. */
const sameVersion = (e: unknown) => e instanceof ApiError && e.status >= 400 && e.status < 500 &&
  /same version|already (installed|exists|at)|up.to.date|nothing to (upgrade|update)/i.test(`${e.message} ${e.body}`);

async function uploadPack(group: string): Promise<string> {
  const installed = items<{ id: string; version?: string }>(await api(`/m/${group}/packs`)).find((p) => p.id === PACK_ID);
  // Spec 016: the same version is not re-uploaded (Stream refuses an upgrade to the installed version). The variables
  // are still set, so a re-deploy keeps doing its job: the worker group name and the asset keys.
  let kept = installed?.version === PACK_VERSION;
  if (!kept) {
    const blob = await (await fetch(`${import.meta.env.BASE_URL}cribl-pulse.crbl`)).blob();
    const up = await api<{ source: string }>(`/m/${group}/packs?filename=cribl-pulse.crbl`, {
      method: 'PUT', body: blob, headers: { 'Content-Type': 'application/octet-stream' } });
    try {
      if (installed) await api(`/m/${group}/packs/${PACK_ID}`, { method: 'PATCH', json: { source: up.source } });
      else await api(`/m/${group}/packs`, { method: 'POST', json: { source: up.source, id: PACK_ID } });
    } catch (e) { if (!installed || !sameVersion(e)) throw e; kept = true; }
  }
  await setPackVar(group, PACK_ID, 'PULSE_WORKER_GROUP', 'string', quote(group), 'Set by Pulse app');
  // An upgrade resets pack variables to the shipped defaults; app KV keys/<group> holds the asset keys the user chose.
  const keys = await kvGet<Record<string, string>>(`keys/${group}`, {});
  if (Object.keys(keys).length) await setPackVar(group, PACK_ID, 'PULSE_KEYS', 'object', JSON.stringify(keys), 'Asset key per source (set by the Pulse app)');
  const what = kept ? `pack ${PACK_VERSION} already installed, kept` : `${installed ? 'pack upgraded to' : 'pack installed,'} ${PACK_VERSION}`;
  return `${what}${Object.keys(keys).length ? `, ${Object.keys(keys).length} asset key rule(s) restored` : ''}`;
}

/** 409 "already exists" from a create call — the object is there, which is what we wanted. */
const alreadyExists = (e: unknown) => e instanceof ApiError && e.status === 409;

/** Spec 015: new Pulse datasets are Parquet, already on Search Dataset Type v2 (the v2 config lives on the Lake
 *  dataset itself as `searchConfig`; this is what the UI writes for a Parquet dataset set to v2). */
const DESCRIPTION = 'Pulse heartbeat metrics (pulse.heartbeat)';
const PARQUET_V2 = { description: DESCRIPTION, metadata: { enableAcceleration: false }, searchVersion: 'v2',
  pathFilters: [{ filter: '**/*.parquet', dataTypeId: 'cribl_lake_parquet', dataPathFormat: 'parquet' }] };

/** A Lake dataset's format; undefined when the dataset doesn't exist (yet). A listed dataset without one is JSON. */
export const formatOf = (datasets: LakeDataset[], id: string) => { const d = datasets.find((x) => x.id === id); return d ? d.format ?? 'json' : undefined; };

/** The destination a Deploy plan writes through when the user picks `dataset` (spec 015). A switch to a dataset of
 *  another format gets its own destination — `<destination>_pq` for Parquet, the plain id back for JSON — because an
 *  existing destination's format is never changed in place (CRIBL-37604). New datasets are created as Parquet. */
export function destinationFor(s: AppSettings, datasets: LakeDataset[], dataset: string) {
  const cur = formatOf(datasets, s.dataset), next = formatOf(datasets, dataset) ?? 'parquet';
  if (dataset === s.dataset || !cur || cur === next) return s.destination;
  const plain = s.destination.replace(/_pq$/, '');
  return next === 'parquet' ? `${plain}_pq` : plain;
}

/** Creates `name` if missing. `format` is the format a new dataset gets: Parquet (Search v2) by default; the rollup
 *  dataset passes the raw dataset's format. */
export async function ensureDataset(name: string, format: string = 'parquet') {
  // Best-effort pre-check: under policiesOnly the list may hide (or refuse) existing datasets.
  const ds = await listDatasets().catch(() => [] as LakeDataset[]);
  const found = ds.find((d) => d.id === name);
  // An existing dataset is never re-formatted in place: CRIBL-37604 leaves files whose extension doesn't match their
  // content after a format change, and Search then fails. Moving to Parquet means a new dataset (see the Deploy page).
  if (found) return `dataset ${name} exists (${found.format ?? 'json'}, kept as is)`;
  const parquet = format === 'parquet';
  try {
    await api('/products/lake/lakes/default/datasets', { method: 'POST', json: {
      id: name, format, retentionPeriodInDays: 30, description: DESCRIPTION, ...(parquet ? { searchConfig: PARQUET_V2 } : {}) } });
  } catch (e) {
    if (alreadyExists(e)) return `dataset ${name} already exists — kept as is`;
    throw e;
  }
  return `dataset ${name} created (${parquet ? 'Parquet, Search v2' : format})`;
}

/** Spec 026: the 5-minute rollup dataset follows the raw dataset's format (Parquet for a new install). */
async function ensureRollupDataset(s: AppSettings) {
  const ds = await listDatasets().catch(() => [] as LakeDataset[]);
  return ensureDataset(rollupDataset(s.dataset), formatOf(ds, s.dataset) ?? 'parquet');
}

/** What a Lake destination writes: its own `format` when set, else its dataset's (a destination without `format`
 *  follows its dataset), else JSON. */
export const destFormatOf = (datasets: LakeDataset[], o: { format?: string; destPath?: string }) =>
  o.format ?? formatOf(datasets, o.destPath ?? '') ?? 'json';

async function ensureDestination(group: string, s: AppSettings) {
  // The destination writes in its dataset's format. Spec 016: a Parquet destination carries no `format` field, as the UI
  // creates them — `format: 'parquet'` makes Stream ask for a Parquet schema (500 "A Parquet schema must be selected
  // from the Parquet Settings tab"), which a Lake destination doesn't use. JSON keeps an explicit `format: 'json'`.
  // An existing destination never changes format (CRIBL-37604: leftover staging files are finalized in the new format
  // under the old extension). A move to Parquet uses a new destination id instead.
  if (!validDestination(s.destination))
    throw new Error(`destination id "${s.destination}" can only use letters, digits, _ and - (Stream refuses it). Change it in Settings → Data, for example to pulse_lake.`);
  const datasets = await listDatasets().catch(() => [] as LakeDataset[]);
  const current = items<{ id: string; format?: string; destPath?: string }>(await api(`/m/${group}/system/outputs`)).find((o) => o.id === s.destination);
  const known = formatOf(datasets, s.dataset);
  // Already writing this dataset: the format can't change (a dataset is never re-formatted), so keep the destination's
  // own `format` field as it is — also when the dataset list is unavailable and the format can't be looked up.
  const same = !!current && current.destPath === s.dataset;
  const format = known ?? (same ? current!.format ?? 'its dataset format' : 'parquet');   // a new dataset is Parquet
  const field = same && !known ? current!.format : format === 'parquet' ? undefined : format;
  const body = { id: s.destination, type: 'cribl_lake', destPath: s.dataset, storageLocationId: 'cribl_lake', compress: 'gzip',
    ...(field ? { format: field } : {}), maxFileOpenTimeSec: 60, maxFileIdleTimeSec: 30, maxFileSizeMB: 32, onBackpressure: 'drop',
    description: `Pulse heartbeat metrics → Cribl Lake ${s.dataset} (${known ?? field ?? (same ? 'dataset format' : 'parquet')}, 60s roll)` };
  const was = current && (same ? (current.format && known ? current.format : format) : destFormatOf(datasets, current));
  if (current && was !== format)
    throw new Error(`destination ${s.destination} writes ${was} to ${current.destPath}; it is not switched to ${format} in place (CRIBL-37604). ` +
      `Pick the dataset again on the Deploy page, or set another destination id in Settings (for example ${s.destination.replace(/_pq$/, '')}${format === 'parquet' ? '_pq' : ''}).`);
  const exists = !!current;
  if (!exists) {
    try { await api(`/m/${group}/system/outputs`, { method: 'POST', json: body }); return `destination ${s.destination} created`; }
    catch (e) { if (!alreadyExists(e)) throw e; }
  }
  await api(`/m/${group}/system/outputs/${s.destination}`, { method: 'PATCH', json: body });
  return `destination ${s.destination} updated`;
}

async function upsertRoute(group: string, filter: string, s: AppSettings) {
  const table = items<{ id: string; routes: Row[] }>(await api(`/m/${group}/routes/default`))[0];
  const routes = table.routes.filter((r) => r.id !== ROUTE_ID);
  routes.unshift({ id: ROUTE_ID, name: ROUTE_ID, filter, pipeline: `pack:${PACK_ID}`, output: s.destination,
    final: false, disabled: false, description: 'Pulse observer: clones events into the heartbeat pack' });
  await api(`/m/${group}/routes/default`, { method: 'PATCH', json: { ...table, routes } });
  return 'route pulse_observer at top (final=false)';
}

/** Commit, then deploy, as two steps (spec 016): a failed deploy is retried with the commit already made, instead of
 *  committing again (which has nothing new to commit). Nothing new to commit is not an error: the plan carries on. */
function commitSteps(group: string, message: string): Step[] {
  let commit: string | undefined;
  return [
    { id: 'commit', title: 'Commit', detail: `group ${group}: ${message}`,
      run: async () => { commit = await commitGroup(group, message); return commit ? `committed ${commit.slice(0, 8)}` : 'nothing new to commit'; } },
    { id: 'deploy', title: 'Deploy', detail: `push group ${group}'s committed config to its workers`, needs: ['commit'],
      run: async () => { if (!commit) return `nothing new to deploy (if an earlier deploy did not finish, deploy ${group} in Stream)`;
        await deployGroup(group, commit); return `deployed ${commit.slice(0, 8)}`; } },
  ];
}

/** What app KV deployments/<group> holds. `dataset` and `destination` are recorded since spec 016 (older records
 *  don't have them). `inputs` is empty when every source is watched. */
export type Deployment = { group: string; inputs: string[]; filter: string; at: string; pack: string; dataset?: string; destination?: string };

const routeSteps = (group: string, inputs: string[], s: AppSettings, message: string): Step[] => {
  const filter = routeFilterFor(inputs, s.routeFilter);
  return [
    { id: 'route', title: `Route ${ROUTE_ID}`, detail: `top of routing table, final=false, filter: ${filter}`, volatile: true, needs: ['dest'], run: () => upsertRoute(group, filter, s) },
    ...commitSteps(group, message),
    { id: 'record', title: 'Record deployment', detail: 'app KV deployments/' + group, needs: ['route', 'deploy'], run: async () => {
      const rec: Deployment = { group, inputs, filter, at: new Date().toISOString(), pack: PACK_VERSION, dataset: s.dataset, destination: s.destination };
      await kvPut(`deployments/${group}`, rec); return 'saved'; } },
  ];
};

const sourcesLabel = (inputs: string[]) => inputs.join(', ') || 'all sources';

export function deployPlan(group: string, inputs: string[], s: AppSettings): Step[] {
  return [
    { id: 'pack', title: `Install / upgrade pack ${PACK_ID} ${PACK_VERSION}`, detail: `group ${group}, sets PULSE_WORKER_GROUP='${group}', keeps the asset keys you chose`, run: () => uploadPack(group) },
    { id: 'dataset', title: `Lake dataset ${s.dataset}`, detail: 'Parquet + Search v2, 30 days — created only if missing (an existing dataset keeps its format)', run: () => ensureDataset(s.dataset) },
    { id: 'dataset5m', title: `Lake dataset ${rollupDataset(s.dataset)}`, detail: 'the 5-minute rollup, same format as the raw dataset — created only if missing', run: () => ensureRollupDataset(s) },
    { id: 'dest', title: `Destination ${s.destination}`, detail: `cribl_lake → ${s.dataset}, 60 s file roll`, run: () => ensureDestination(group, s) },
    ...routeSteps(group, inputs, s, `Pulse: deploy to ${sourcesLabel(inputs)}`),
  ];
}

/** Spec 016: the sources changed and nothing else did — only the route filter is rewritten (then commit, deploy, record).
 *  The pack, dataset and destination are already there and are not touched. */
export function routePlan(group: string, inputs: string[], s: AppSettings): Step[] {
  return routeSteps(group, inputs, s, `Pulse: watch ${sourcesLabel(inputs)}`);
}

/** Spec 016: a re-deploy only needs the route when the group already runs this pack version and the previous
 *  deployment wrote to the same dataset through the same destination. An older record without dataset/destination
 *  counts as the current settings (it was made before they were recorded, with the settings Pulse still uses). */
export function routeOnly(prev: Deployment | null | undefined, installed: string | undefined, s: AppSettings, dataset: string, destination: string) {
  if (!prev || installed !== PACK_VERSION || prev.pack !== PACK_VERSION) return false;
  return (prev.dataset ?? s.dataset) === dataset && (prev.destination ?? s.destination) === destination;
}

/** The sources a plan adds and removes, compared with the previous deployment. An empty list means every source. */
export function sourceDelta(prev: string[] | undefined, next: string[]) {
  const was = new Set(prev ?? []), now = new Set(next);
  return { added: next.filter((x) => !was.has(x)), removed: [...was].filter((x) => !now.has(x)), same: !!prev && was.size === now.size && next.every((x) => was.has(x)) };
}

/* ---------- asset keys per source (spec 003): app KV keys/<group> is the master copy, the pack var follows ---------- */
export const loadKeys = (group: string) => kvGet<Record<string, string>>(`keys/${group}`, {});
/** Input ids look like "syslog:in_syslog:tcp"; the pack matches the full id, then "type:id", then "id". */
export const keyIdOf = (input: string) => input.split(':').slice(0, 2).join(':');
export const keyFor = (keys: Record<string, string>, input: string) => keys[input] ?? keys[keyIdOf(input)] ?? keys[input.split(':')[1] ?? ''] ?? 'auto';

export function nextKeys(current: Record<string, string>, input: string, spec: string) {
  const next = { ...current };
  delete next[input];
  if (!spec || spec === 'auto') delete next[keyIdOf(input)]; else next[keyIdOf(input)] = spec;
  return next;
}
export function keyPlan(group: string, input: string, spec: string, current: Record<string, string>): Step[] {
  const next = nextKeys(current, input, spec);
  const n = Object.keys(next).length;
  return [
    { id: 'keys', title: `Asset key for ${keyIdOf(input)}: ${spec || 'auto'}`, volatile: true, detail: `pack variable PULSE_KEYS on ${group} (${n} source rule${n === 1 ? '' : 's'})`,
      run: async () => {
        await setPackVar(group, PACK_ID, 'PULSE_KEYS', 'object', JSON.stringify(next), 'Asset key per source (set by the Pulse app)');
        await kvPut(`keys/${group}`, next); return 'variable set';
      } },
    ...commitSteps(group, `Pulse: asset key for ${keyIdOf(input)} = ${spec || 'auto'}`),
  ];
}

/* ---------- overrides (KV is the master copy, lookup pulse_overrides.csv is what KQL reads) ---------- */
export type Override = { input: string; asset: string; action: 'mute' | 'threshold' | 'ack'; max_gap_s: number; until?: string; ack_seen?: number; note?: string };
export const loadOverrides = () => kvGet<Override[]>('overrides', []);

export async function publishOverrides(list: Override[]) {
  const now = Date.now();
  const live = list.filter((o) => !o.until || Date.parse(o.until) > now);
  // until_s is checked by the KQL too, so an override expires on time even if nobody republishes the lookup.
  await publishLookup('pulse_overrides.csv', ['input', 'asset', 'action', 'max_gap_s', 'until_s', 'ack_seen', 'note'],
    [['__example__', '__example__', 'none', 0, 0, 0, 'template'],
      ...live.map((o) => [o.input, o.asset, o.action, o.max_gap_s, o.until ? Math.floor(Date.parse(o.until) / 1000) : 0, o.ack_seen ?? 0, o.note])],
    'Pulse overrides (managed by the Pulse app)');
}

export async function setOverride(o: Override | { input: string; asset: string; remove: true }) {
  const list = (await loadOverrides()).filter((x) => !(x.input === o.input && x.asset === o.asset));
  if (!('remove' in o)) list.push(o);
  await kvPut('overrides', list);
  await publishOverrides(list);
  return list;
}

/** Acknowledge (spec 005): silences the current incident only. It lapses when the asset sends again, or after `hours`. */
export const ackOverride = (e: { input: string; asset: string; last_seen: number }, hours = 24, note?: string): Override =>
  ({ input: e.input, asset: e.asset, action: 'ack', max_gap_s: 0, ack_seen: e.last_seen, until: new Date(Date.now() + hours * 36e5).toISOString(), note });

/* ---------- Search assets: lookups, saved searches + notifications ---------- */
export type SavedStatus = { id: string; desc: string; enabled: boolean; cron: string; exists: boolean; extra?: boolean };
type Saved = { id: string; schedule?: { enabled?: boolean; cronSchedule?: string } };

export async function savedStatus(s: AppSettings): Promise<SavedStatus[]> {
  const all = items<Saved>(await api(`${SEARCH}/search/saved`));
  const row = (d: { id: string; desc: string; cron: string }, extra?: boolean): SavedStatus => { const x = all.find((a) => a.id === d.id);
    return { id: d.id, desc: d.desc, exists: !!x, enabled: !!x?.schedule?.enabled, cron: x?.schedule?.cronSchedule ?? d.cron, ...(extra ? { extra: true } : {}) }; };
  const main = savedSearches(s);
  // Every other Pulse search a load can install, so installedLoad sees the load actually in the org (spec 038).
  const other = savedSearches({ ...s, searchLoad: normalizeLoad(s.searchLoad) === 'daily' ? 'standard' : 'daily' });
  // A search this load turns off (enabled: false) is an extra row too: whatever is installed there came from another load.
  return [...main.map((d) => row(d, d.enabled === false)), ...other.filter((d) => !main.some((m) => m.id === d.id)).map((d) => row(d, true))];
}

/** The lookups every Pulse search joins on. Search rejects a query (500 "Unknown lookup table name") until they exist. */
export function lookupSteps(): Step[] {
  return [
    { id: 'lookup', title: 'Lookup pulse_overrides.csv', detail: 'mutes, thresholds and acknowledgements from app KV',
      run: async () => { const list = await loadOverrides(); await publishOverrides(list); return `published ${list.length} override(s)`; } },
    { id: 'assets', title: 'Lookup pulse_assets.csv', detail: 'owners, criticality and HA clusters (Assets and Policies pages)',
      run: async () => { const [inv, cl, rules] = await Promise.all([loadInventory(), loadClusters(), loadRules()]); await publishInventory(inv, cl, rules); return `published ${Object.keys(inv).length} asset(s)`; } },
    { id: 'maint', title: 'Lookup pulse_maintenance.csv', detail: 'maintenance windows (Policies page)',
      run: async () => { const w = await loadWindows(); await publishWindows(w); return `published ${w.length} window(s)`; } },
  ];
}

/** What the Alerts plan knows about the rollup: the saved search and the dataset's oldest/newest bucket (epoch s). */
export type RollupContext = { saved?: { query?: string; schedule?: { enabled?: boolean } }; newestBucket?: number; oldestBucket?: number; nowS: number;
  /** ids of the saved searches that exist; when known, a search the load turns off and that is absent gets no step */ existing?: string[] };

/** Spec 026: the alert searches read the rollup only when the setting is 'auto' and the verdict says use. Without a
 *  context nothing is known about the rollup, so they stay on raw. The backfill is due when the rollup has no bucket
 *  older than the lookback. */
export function rollupDecision(s: AppSettings, ctx?: RollupContext): { rollup: boolean; backfill: boolean; verdict?: RollupVerdict } {
  if (!ctx || s.rollup !== 'auto') return { rollup: false, backfill: false };
  const lookbackS = lookbackSeconds(s.learning.LOOKBACK);
  // Spec 033: the lag limit follows the search load (Hourly 4800 s), not Standard's 1500 s.
  const verdict = rollupVerdict({ saved: ctx.saved, dataset: s.dataset, newestBucket: ctx.newestBucket, oldestBucket: ctx.oldestBucket, nowS: ctx.nowS, lookbackS,
    maxLagS: rollupMaxLagS(normalizeLoad(s.searchLoad)) });
  return { rollup: verdict.use, verdict, backfill: ctx.oldestBucket === undefined || ctx.oldestBucket > ctx.nowS - lookbackS };
}

/** Reads the rollup's state for the Alerts plan. Failures (no dataset yet, no search) read as "nothing there". */
export async function loadRollupContext(s: AppSettings): Promise<RollupContext> {
  const nowS = Math.floor(Date.now() / 1000);
  let existing: string[] | undefined;
  const list = await api<{ items?: Saved[] }>(`${SEARCH}/search/saved`).then((r) => { existing = items<Saved & { id: string }>(r).map((x) => x.id); return r; }, () => ({}));
  const saved = items<Saved & { query?: string }>(list).find((x) => x.id === 'pulse_rollup');
  let oldestBucket: number | undefined, newestBucket: number | undefined;
  try {
    const [r] = await runSearch(`dataset="${rollupDataset(s.dataset)}" | summarize oldest=min(_time), newest=max(_time)`,
      `-${lookbackSeconds(s.learning.LOOKBACK) + s.learning.MAX_GAP + 600}s`, 'now', 120_000, 1);
    const n = (v: unknown) => { const x = Number(v); return v === null || v === undefined || !Number.isFinite(x) ? undefined : x > 1e11 ? x / 1000 : x; };
    oldestBucket = n(r?.oldest); newestBucket = n(r?.newest);
  } catch { /* no rollup dataset yet */ }
  return { saved, oldestBucket, newestBucket, nowS, existing };
}

/** Spec 026 rollup check: one cheap job (newest/oldest bucket) and the saved-search list. A failed read counts as
 *  "nothing there", so the verdict falls back to raw. It reaches back as far as any history read does (the gap ledger
 *  of the longest range: two MAX_SPAN_S periods plus MAX_GAP, and an hour of slack), so `oldest` tells the history
 *  reads whether the rollup covers them; the verdict itself only needs the lookback. */
export const rollupCheckEarliest = (s: AppSettings) => `-${2 * MAX_SPAN_S + s.learning.MAX_GAP + 3600}s`;

export async function fetchRollupCheck(s: AppSettings): Promise<{ rows: Row[]; saved?: Saved & { query?: string } }> {
  const [rows, list] = await Promise.all([
    runSearch(`dataset="${rollupDataset(s.dataset)}" | summarize newest=max(bucket), oldest=min(bucket)`, rollupCheckEarliest(s), 'now', 60_000, 1).catch((): Row[] => []),
    api<{ items?: Saved[] }>(`${SEARCH}/search/saved`).catch(() => ({})),
  ]);
  return { rows, saved: items<Saved & { id?: string; query?: string }>(list).find((x) => x.id === 'pulse_rollup') };
}

/** The default targets, in spec 035 ID order: system_email first when recipients are set, then the chosen ones; no
 *  duplicates. Each one gets its own notification (one target per body), never one body for all of them. */
export const notifyTargets = (s: AppSettings): string[] => defaultTargetOrder(s.notify.targets, s.notify.email);

const NOTES = `${SEARCH}/notifications`; // reads (GET) elsewhere use this; every write goes through writeNotification

/**
 * The only code that sends write requests to the notifications collection (spec 035). An enabled body needs exactly one target and exactly
 * one config entry whose id is that target (oneTargetProblem, routes.ts); the check runs before any request. A disabled body may keep its
 * old targets. Creates (POST) or updates (PATCH) by id; stale ones are disabled this way, never deleted.
 */
export async function writeNotification(n: NotificationBody, known?: Set<string>): Promise<void> {
  const problem = oneTargetProblem(n);
  if (problem) throw new Error(problem);
  const exists = known ? known.has(n.id) : items<{ id: string }>(await api(NOTES)).some((x) => x.id === n.id);
  await api(`${NOTES}${exists ? `/${n.id}` : ''}`, { method: exists ? 'PATCH' : 'POST', json: n });
  known?.add(n.id);
}

/** A stored notification switched off: the whole object goes back with `disabled: true`, minus its `status`. */
export function disabledNotification<T extends { status?: unknown }>(cur: T): Omit<T, 'status'> & { disabled: true } {
  const { status: _status, ...rest } = cur;
  void _status;
  return { ...rest, disabled: true };
}

/** `link`: the host origin and base path for the incident link in messages, read by the caller at plan time
 *  (`hostOrigin()`, `window.CRIBL_BASE_PATH`). Without an origin the messages leave that link out. */
export function alertsPlan(s: AppSettings, enabled: boolean, ctx?: RollupContext, known: { id: string; type: string }[] = [],
  link: { origin?: string; base?: string } = {}): Step[] {
  const kinds = new Map(channelRows(known).map((r) => [r.id, r.kind]));
  const named = (id: string) => id === 'system_email' ? 'system_email (Email)' : kinds.has(id) ? `${id} (${kinds.get(id)})`
    : id === 'system_notifications' ? 'system_notifications (In-product)' : id;
  // Spec 035: one plan line per notification (its slot copies _s1… folded in), naming its one target and the kind.
  const noteLines = (ns: NotificationBody[]): string[] => {
    const by = new Map<string, { t: string; n: number }>();
    for (const n of ns) { const id = baseIdOf(n); const e = by.get(id); if (e) e.n++; else by.set(id, { t: n.targets[0], n: 1 }); }
    return [...by].map(([id, e]) => `${id} → ${named(e.t)}${e.n > 1 ? ` (${e.n} result slots)` : ''}`);
  };
  // The lines go under the detail, one per line (PlanRunner shows the detail; .plan-body keeps the line breaks).
  const withLines = (st: Step): Step => (st.lines?.length ? { ...st, detail: `${st.detail}\n${st.lines.join('\n')}` } : st);
  // The searches are built for the mode that was decided: rollup mode only on a use:true verdict, else raw. The
  // decision starts from the context the page loaded, and the rollup_check step re-reads it once pulse_rollup and the
  // backfill have run, so a first install publishes in rollup mode in the same run. Each search builds its query
  // when its step runs, from the decision at that moment.
  const load = normalizeLoad(s.searchLoad);
  const daily = load === 'daily';
  const cad = cadenceOf(load, s.rollCall);
  // Economy (daily) runs no rollup: no backfill, no check, the searches read raw.
  let dec = daily ? { rollup: false, backfill: false } as ReturnType<typeof rollupDecision> : rollupDecision(s, ctx);
  const auto = s.rollup === 'auto' && !daily;
  const all = () => savedSearches({ ...s, rollup: dec.rollup ? 'auto' : 'off' });
  const backfillS = lookbackSeconds(s.learning.LOOKBACK) + s.learning.MAX_GAP;
  // Without a context (AskBar) the step is listed and decides at run time; with one, only when the context says so.
  const backfill: Step[] = auto && (!ctx || dec.backfill) ? [{
    id: 'rollup_backfill', title: `Backfill the rollup (last ${s.learning.LOOKBACK.replace('-', '')} + ${Math.round(s.learning.MAX_GAP / 3600)} h)`,
    detail: `one-off: runs the rollup query over the lookback + MAX_GAP, writes ${rollupDataset(s.dataset)} (re-running is safe: readers keep the newest copy)`,
    run: async () => {
      if (!rollupDecision(s, await loadRollupContext(s)).backfill) return 'already backfilled: skipped';
      await runSearch(rollupQuery(s, backfillS), `-${backfillS}s`, 'now', 600_000, 1);
      return 'backfill done';
    } }] : [];
  const check: Step[] = auto ? [{
    id: 'rollup_check', title: 'Check the rollup',
    detail: 'reads the rollup state again: the searches below publish in rollup mode only when it is in use',
    run: async () => {
      dec = rollupDecision(s, await loadRollupContext(s));
      const why = dec.verdict && !dec.verdict.use ? dec.verdict.reason : 'unknown';
      return dec.rollup ? 'rollup in use: the searches below read it' : `rollup not in use (${why}): the searches below read raw data; run this plan again later`;
    } }] : [];
  // Spec 029: every notification comes from notificationsFor (routes.ts). A target's type decides the message format
  // and the notification id, so the steps read the target list again when they run (once per plan run): a caller
  // without the list (AskBar) or with a stale one still writes the same bodies as the Alerts page. `known` is the
  // fallback when that read fails. The origin (for the incident link) was read by the caller at plan time.
  const routes = s.notify.routes ?? [];
  const evs = defaultEvents(s); // Send recovery notifications off → routes without when.events and the default skip resolved/expired
  const asTypes = (ts: { id: string; type: string }[]) => Object.fromEntries(ts.map((t) => [t.id, t.type]));
  let typesP: Promise<Record<string, string>> | undefined;
  const types = () => (typesP ??= listTargets().then((ts) => ({ ...asTypes(known), ...asTypes(ts) }), () => asTypes(known)));
  const notes = (d: { id: string; desc: string }, targetTypes: Record<string, string>) =>
    notificationsFor(d, routes, { targets: s.notify.targets, email: s.notify.email, events: evs }, { targetTypes, origin: link.origin, base: link.base });
  const vt = routingMode === 'vt_results';
  const upsertSaved = async (body: { id: string }) => {
    const exists = items<Saved>(await api(`${SEARCH}/search/saved`)).some((x) => x.id === body.id);
    await api(`${SEARCH}/search/saved${exists ? `/${body.id}` : ''}`, { method: exists ? 'PATCH' : 'POST', json: body });
    return exists;
  };
  const savedBody = (d: { id: string; desc: string; query: string; cron: string; earliest?: string; latest?: string }) => ({
    id: d.id, name: d.id, description: d.desc, isPrivate: false, query: d.query, earliest: d.earliest ?? s.learning.LOOKBACK,
    latest: d.latest ?? 'now', sampleRate: 1, schedule: { enabled, cronSchedule: d.cron, tz: cad.tz, keepLastN: 2, emptyNotifications: {}, emptyAdvanced: {} } });
  // Notifications live in their own collection, linked by conf.savedQueryId (inline ones are not persisted).
  const upsertNotes = async (ns: NotificationBody[]) => {
    const known = new Set(items<{ id: string }>(await api(NOTES)).map((x) => x.id)); // one read for the whole step
    for (const n of ns) await writeNotification(n, known);
  };
  const routeSearch = (parent: { id: string; cron: string }, r: Route) => {
    const kind = searchKind(parent.id);
    return { id: routeSearchId(r.id, kind), desc: `Pulse route ${r.id} (${r.name || r.id}): ${parent.id} rows that match`,
      query: routeSearchQuery(parent.id, r, routes, evs), cron: shiftCron(parent.cron), earliest: '-5m', latest: 'now' };
  };
  // vt_results mode with a final route: the default notifications move to pulse_route_default_<kind> (F1, t0.md),
  // which keeps the parent's rows no final route matches. Without one they stay on the parent (resultsCount > 0).
  const defaultSearch = (parent: { id: string; cron: string }) => {
    const query = vt ? defaultSearchQuery(parent.id, routes, evs) : undefined;
    return query ? { id: defaultSearchId(searchKind(parent.id)), desc: `Pulse default route: ${parent.id} rows no final route took`,
      query, cron: shiftCron(parent.cron), earliest: '-5m', latest: 'now' } : undefined;
  };
  // vt_results: the searches a route's / the default's notifications read (vtSearches). A native PagerDuty group takes
  // firing rows only (spec 030 §3: the plain pager_duty preset has no auto-resolve), so next to other targets it reads
  // its own `<search>_firing`.
  const firingDesc = (id: string, desc: string) => (id.includes('_firing') ? `${desc}, firing only (native PagerDuty)` : desc);
  const routeSearches = (parent: { id: string; cron: string }, r: Route, ns: NotificationBody[]) => {
    const rs = routeSearch(parent, r);
    const v = vtSearches(parent.id, rs.id, ns);
    const searches = v.searches.length ? v.searches.map((x) => ({ ...rs, id: x.id, desc: firingDesc(x.id, rs.desc), query: x.query })) : [rs];
    return { searches, notes: v.notes };
  };
  const defaultSearches = (parent: { id: string; cron: string }, ns: NotificationBody[]) => {
    const v = vtSearches(parent.id, defaultSearchId(searchKind(parent.id)), ns);
    const desc = `Pulse default route: ${parent.id} rows no final route took`;
    return { notes: v.notes, searches: v.searches.map((x) => ({ id: x.id, desc: firingDesc(x.id, desc), query: x.query, cron: shiftCron(parent.cron), earliest: '-5m', latest: 'now' })) };
  };
  const rollCallNotes = (targets: string[]) => rollCallNotifications(targets, { email: s.notify.email, allClear: !!s.rollCall?.allClear, message: ROLL_CALL_MESSAGE });
  const steps = all().flatMap((d0): Step[] => {
    if (d0.enabled === false) {
      // The load turns this search off. Never deleted: an existing one is PATCHed with its schedule off. The spec 029
      // searches built on a notifying parent (pulse_route_r<N>_<kind>, pulse_route_default_<kind>, their _firing /
      // _s<N> variants) read its $vt_results on their own schedule, so they are switched off in the same step (R4).
      const childRe = d0.notify ? new RegExp(`^pulse_route_(r\\d+|default)_${searchKind(d0.id)}(_firing\\d*)?(_s[1-4])?$`) : undefined;
      const isChild = (id: string) => !!childRe && childRe.test(id);
      // Spec 038 decision 1: always emitted, whatever ctx.existing says (it can be stale); the run-time checks skip.
      return [{ id: d0.id, title: `Disable ${d0.id} if installed (schedule off, never deleted)`, volatile: true,
        detail: `the ${load} load does not run ${d0.id}: sets schedule.enabled false${childRe ? ` on it and on its route searches (pulse_route_*_${searchKind(d0.id)}*)` : ''} (never deleted)`,
        run: async () => {
          const saved = items<Saved & { id: string }>(await api(`${SEARCH}/search/saved`));
          const cur = saved.find((x) => x.id === d0.id);
          const done: string[] = [];
          if (cur && cur.schedule?.enabled !== false) {
            await api(`${SEARCH}/search/saved/${d0.id}`, { method: 'PATCH', json: disabledSaved(cur) });
            done.push(d0.id);
          }
          for (const x of saved.filter((x) => isChild(x.id) && x.schedule?.enabled !== false)) {
            await api(`${SEARCH}/search/saved/${x.id}`, { method: 'PATCH', json: disabledSaved(x) });
            done.push(x.id);
          }
          if (!done.length) return cur ? 'already disabled: skipped' : 'not present: skipped';
          return done.length === 1 && done[0] === d0.id ? 'disabled' : `disabled ${done.join(', ')}`;
        } }];
    }
    if (d0.id === 'pulse_roll_call') return [{
      id: d0.id, title: `Saved search ${d0.id}`, volatile: true,
      detail: `${d0.cron} (${cad.tz}) · ${enabled ? 'enabled' : 'disabled'} · notify → ${notifyTargets(s).map(named).join(', ') || 'no targets'} · ${s.rollCall?.allClear ? 'every run' : 'when n_missing > 0'}`,
      lines: noteLines(rollCallNotes(notifyTargets(s))),
      run: async () => {
        const d = all().find((x) => x.id === d0.id)!;
        const exists = await upsertSaved(savedBody(d));
        const targets = notifyTargets(s);
        const ns = rollCallNotes(targets);
        const have = items<{ id: string; disabled?: boolean; status?: unknown; [k: string]: unknown }>(await api(NOTES));
        const known = new Set(have.map((x) => x.id));
        for (const n of ns) await writeNotification(n, known);
        // Spec 035: 033's pulse_roll_call_notification__<first target> (and removed targets' ones) are disabled, never deleted.
        const off: string[] = [];
        for (const id of staleNotifications('pulse_roll_call', [], have.map((x) => x.id), targets)) {
          const cur = have.find((x) => x.id === id)!;
          if (cur.disabled === true) continue;
          await writeNotification(disabledNotification(cur) as unknown as NotificationBody, known);
          off.push(id);
        }
        return `${exists ? 'updated' : 'created'}${ns.map((n) => ` + ${n.id}`).join('')}${off.length ? ` · disabled ${off.join(', ')}` : ''}`;
      } }];
    const ds0 = d0.notify ? defaultSearch(d0) : undefined;
    const main: Step = {
      id: d0.id, title: `Saved search ${d0.id}`, volatile: true,
      detail: `${d0.cron} · ${enabled ? 'enabled' : 'disabled'}${d0.id === 'pulse_state' || d0.id === 'pulse_rollup' ? '' : ' · reads pulse_state'}${d0.notify ? ` · notify → ${notifyTargets(s).map(named).join(', ')}` : ''}` +
        (ds0 ? ` · default targets via saved search ${ds0.id} (${ds0.cron})` : ''),
      ...(d0.notify ? { lines: noteLines(notes(d0, asTypes(known)).filter((n) => !n.id.startsWith(`${d0.id}_route_`))) } : {}),
      run: async () => {
        const d = all().find((x) => x.id === d0.id)!; // the query for the mode decided by now
        const exists = await upsertSaved(savedBody(d));
        if (!d.notify) return exists ? 'updated' : 'created';
        const defaults = notes(d, await types()).filter((n) => !n.id.startsWith(`${d.id}_route_`));
        if (!vt) { await upsertNotes(defaults); return `${exists ? 'updated' : 'created'} + ${defaults.map((n) => n.id).join(', ')}`; }
        // One search per distinct condition: the default's rows, and (native PagerDuty, spec 030 §3) its firing rows.
        const v = defaultSearches(d, defaults);
        for (const x of v.searches) await upsertSaved(savedBody(x));
        await upsertNotes(v.notes);
        return `${exists ? 'updated' : 'created'}${v.searches.map((x) => ` + ${x.id}`).join('')} + ${defaults.map((n) => n.id).join(', ')}`;
      },
    };
    if (!d0.notify) return [main];
    const mine = routesFor(d0.id, routes);
    const perRoute = mine.map((r): Step => {
      const rs = routeSearch(d0, r);
      return {
        id: `${d0.id}_route_${r.id}`, title: `Route ${r.id} on ${d0.id}`, volatile: true, needs: [d0.id],
        detail: `${r.name ? `${r.name} · ` : ''}when ${effectiveCondition(r, routes, d0.id, evs)} → ${r.targets.map(named).join(', ') || 'no targets'}` +
          `${r.final ? ' · final' : ''}${vt ? ` · via saved search ${rs.id} (${rs.cron})` : ''}`,
        lines: noteLines(notes(d0, asTypes(known)).filter((n) => isRouteNotification(n.id, d0.id, r.id))),
        run: async () => {
          const ns = notes(all().find((x) => x.id === d0.id)!, await types()).filter((n) => isRouteNotification(n.id, d0.id, r.id));
          if (!vt) { await upsertNotes(ns); return `wrote ${ns.map((n) => n.id).join(', ')}`; }
          const v = routeSearches(d0, r, ns);
          let exists = false;
          for (const [i, x] of v.searches.entries()) { const e = await upsertSaved(savedBody(x)); if (i === 0) exists = e; }
          await upsertNotes(v.notes);
          return `${exists ? 'updated' : 'created'} ${v.searches.map((x) => x.id).join(', ')} + ${ns.map((n) => n.id).join(', ')}`;
        },
      };
    });
    const stale: Step = {
      id: `${d0.id}_stale_routes`, title: `Disable removed notifications on ${d0.id}`, volatile: true,
      detail: `sets disabled: true on any ${d0.id}_notification* or ${d0.id}_route_* notification the settings no longer produce (never deleted)`,
      run: async () => {
        const have = items<{ id: string; disabled?: boolean; status?: unknown; [k: string]: unknown }>(await api(NOTES));
        const haveIds = have.map((x) => x.id);
        const known = new Set(haveIds);
        // Removed routes, a live route's notification for a format it no longer has (e.g. its Slack target left), and
        // default-route notifications whose targets were switched off (incl. 0.2.8's _notification once no text target is left).
        const produced = notes(d0, await types()).map((n) => n.id);
        const now = new Set(produced);
        const ids = [...new Set([...staleNotifications(d0.id, routes, haveIds), ...staleDefaults(d0.id, produced, haveIds),
          ...have.filter((x) => !now.has(x.id) && mine.some((r) => isRouteNotification(x.id, d0.id, r.id))).map((x) => x.id)])];
        const done: string[] = [];
        for (const id of ids) {
          const cur = have.find((x) => x.id === id)!;
          if (cur.disabled === true) continue;
          // Full object back, minus status (T0: Search's PATCH wants the whole object).
          await writeNotification(disabledNotification(cur) as unknown as NotificationBody, known);
          done.push(id);
        }
        // The F1 route searches of removed routes stop running too (their schedule is switched off, full body).
        // So does the default route search once no final route is left.
        const kind = searchKind(d0.id);
        const all0 = notes(d0, await types());
        const live = new Set([
          ...mine.flatMap((r) => routeSearches(d0, r, all0.filter((n) => isRouteNotification(n.id, d0.id, r.id))).searches.map((x) => x.id)),
          ...(vt ? defaultSearches(d0, all0.filter((n) => !n.id.startsWith(`${d0.id}_route_`))).searches.map((x) => x.id) : []),
        ]);
        const re = new RegExp(`^pulse_route_(r\\d+|default)_${kind}(_firing\\d*)?(_s[1-4])?$`);
        const saved = items<Saved & { id: string }>(await api(`${SEARCH}/search/saved`));
        for (const x of saved.filter((x) => re.test(x.id) && !live.has(x.id) && x.schedule?.enabled)) {
          await api(`${SEARCH}/search/saved/${x.id}`, { method: 'PATCH', json: disabledSaved(x) });
          done.push(x.id);
        }
        return done.length ? `disabled ${done.join(', ')}` : 'nothing to disable: skipped';
      },
    };
    return [main, ...perRoute, stale];
  });
  // Spec 033 §3, switching back: savedSearches lists pulse_roll_call in daily only, so the other loads turn it off
  // here. An existing roll call is PATCHed with its schedule off and its notifications get `disabled: true`; never
  // deleted. Spec 038: emitted in every load but daily whatever ctx.existing says; the run skips when absent or off.
  const rollCallOff: Step[] = !daily ? [{
    id: 'pulse_roll_call', title: 'Disable pulse_roll_call if installed (schedule off, never deleted)', volatile: true,
    detail: `the ${load} load does not run pulse_roll_call: sets schedule.enabled false and disabled: true on its pulse_roll_call_notification* notifications (never deleted)`,
    run: async () => {
      const done: string[] = [];
      const cur = items<Saved & { id: string }>(await api(`${SEARCH}/search/saved`)).find((x) => x.id === 'pulse_roll_call');
      if (cur && cur.schedule?.enabled !== false) {
        await api(`${SEARCH}/search/saved/pulse_roll_call`, { method: 'PATCH', json: disabledSaved(cur) });
        done.push('pulse_roll_call');
      }
      const have = items<{ id: string; disabled?: boolean; status?: unknown; [k: string]: unknown }>(await api(NOTES));
      const known = new Set(have.map((x) => x.id));
      for (const n of have.filter((x) => /^pulse_roll_call_notification(__.+)?$/.test(x.id) && x.disabled !== true)) {
        await writeNotification(disabledNotification(n) as unknown as NotificationBody, known);
        done.push(n.id);
      }
      return done.length ? `disabled ${done.join(', ')}` : cur ? 'already disabled: skipped' : 'not present: skipped';
    } }] : [];
  steps.push(...rollCallOff);
  const at = steps.findIndex((x) => x.id === 'pulse_rollup') + 1;
  const stopTestStep: Step = {
    id: 'stop_test', title: 'Stop the test notification',
    detail: 'disables the schedule of pulse_notify_test when that saved search exists; skipped otherwise',
    run: async () => {
      const cur = items<Saved>(await api(`${SEARCH}/search/saved`)).find((x) => x.id === 'pulse_notify_test');
      if (!cur) return 'no test notification: skipped';
      await api(`${SEARCH}/search/saved/pulse_notify_test`, { method: 'PATCH', json: disabledSaved(cur) }); // full body (T0)
      return 'test notification stopped';
    } };
  return [...lookupSteps(), ...steps.slice(0, at), ...backfill, ...check, ...steps.slice(at), stopTestStep].map(withLines);
}
