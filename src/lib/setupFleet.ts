/* The Setup page's one loader (spec 039 §2): demo data under plain `npm run dev`, the API otherwise. */
import { api, items, kvGet, listGroups, listInputs, listPacks } from './api';
import { PACK_ID, savedStatus, type Deployment } from './deploy';
import { setupFleet, type FleetData, type FleetGroup, type FleetSearch, type FleetSource } from './demo';
import { hostMode } from './host';
import { loadSettings } from './settings';

export type { FleetData, FleetGroup, FleetSearch, FleetSource };

async function readGroup(g: { id: string; workerCount?: number }): Promise<FleetGroup> {
  const [packs, inputs, prev] = await Promise.all([
    listPacks(g.id).catch(() => [] as { id: string; version?: string }[]),
    listInputs(g.id).catch(() => []),
    kvGet<Deployment | null>(`deployments/${g.id}`, null).catch(() => null),
  ]);
  const record = new Set(prev?.inputs ?? []);
  const mode = prev ? (prev.inputs.length ? 'selected' : 'all') : 'all';
  const sources: FleetSource[] = inputs.map((i) => ({ id: i.id, type: i.type, evs: 0, picked: record.has(`${i.type}:${i.id}`) }));
  // Pack sources are not read here (031: pack inputs are read only when a group's sources are opened).
  return { id: g.id, workers: g.workerCount ?? 0, pulse: packs.find((p) => p.id === PACK_ID)?.version, mode, selected: false, sources, packSources: [] };
}

/** The Search lookups the app publishes (publishLookup in inventory.ts, maintenance.ts and deploy.ts). */
const APP_LOOKUPS = new Set(['pulse_assets.csv', 'pulse_maintenance.csv', 'pulse_overrides.csv']);
/** The lookups API, the same path publishLookup uses and the only lookups path declared in config/policies.yml. */
export const SEARCH_LOOKUPS_PATH = '/m/default_search/system/lookups';

async function readSearch(): Promise<FleetSearch> {
  const s = await loadSettings();
  const [saved, lookups] = await Promise.all([
    savedStatus(s).catch(() => []),
    api<{ items?: { id?: string }[] }>(SEARCH_LOOKUPS_PATH).then(items).catch(() => [] as { id?: string }[]),
  ]);
  const mine = saved.filter((x) => !x.extra && x.exists);
  return {
    dataset: s.dataset, targets: s.notify.targets, schedules: mine.some((x) => x.enabled),
    // Like `saved`, count the app's own lookups, not every lookup on the Search group.
    saved: mine.length, lookups: lookups.filter((l) => APP_LOOKUPS.has(String(l.id ?? ''))).length,
    outdated: saved.filter((x) => x.extra && x.exists).length,
  };
}

/**
 * `groups: false` (live only) skips the per-group reads and returns `groups: []` with the Search status.
 * The live Setup page reads its rows itself (loadRows), so its first paint and Refresh pass it: reading
 * every group twice per click would spend the app's 100 requests/minute proxy budget. Demo ignores it.
 */
export async function loadFleet(opts: { groups?: boolean } = {}): Promise<FleetData> {
  if (hostMode() === 'demo') return setupFleet();
  if (opts.groups === false) return { groups: [], search: await readSearch() };
  const groups = await listGroups();
  const [rows, search] = await Promise.all([Promise.all(groups.map(readGroup)), readSearch()]);
  return { groups: rows, search };
}
