import type { Inventory } from './inventory';
import type { AssetState, Entity } from './model';

/* Assets page filters (spec 013 §9), bound to the URL query string so links such as /assets?state=missing,
   /assets?team=<t> and /assets?owner=none reproduce the filtered view. Pure functions only: no React, no I/O. */

/** One row per asset name (an asset can send to several sources): the worst state wins. */
export type AssetRow = { id: string; asset: string; worst: Entity; entities: Entity[] };

export type AssetFilters = {
  /** Free text: asset, team, owner, tags, cluster or source. */
  q: string;
  state: string[];
  /** '1'…'4', or NONE for "not classified". */
  crit: string[];
  /** Owning team, or NONE / UNASSIGNED for "no team". */
  team: string[];
  /** Owner contact, or NONE for "nobody owns it" (no team and no contact). */
  owner: string[];
  /** HA cluster, or NONE for "not in a cluster". */
  cluster: string[];
  /** Source id (the middle part of the input, e.g. in_syslog). */
  source: string[];
  /** Identification rule (key_src, e.g. host, ip, field:hostname). */
  identity: string[];
};
export type ListKey = Exclude<keyof AssetFilters, 'q'>;
/** URL param names, in the order they are written. */
export const LIST_KEYS: ListKey[] = ['state', 'crit', 'team', 'owner', 'cluster', 'source', 'identity'];
/** The filters that live in the Filters drawer. */
export const DRAWER_KEYS: ListKey[] = ['owner', 'cluster', 'source', 'identity'];
export const NONE = 'none';
/** The team name the Overview "Who owns the gaps?" card uses for assets without a team. */
export const UNASSIGNED = 'unassigned';

const STATE_RANK: AssetState[] = ['missing', 'late', 'delayed', 'covered', 'acked', 'ok', 'learning', 'maintenance', 'muted'];
const rank = (s: AssetState) => STATE_RANK.indexOf(s);
const critNum = (inv: Inventory, a: string) => inv[a]?.criticality ?? 3;
/** "syslog:in_syslog:tcp" → "in_syslog". */
export const sourceOf = (input: string) => input.split(':')[1] ?? input;

export const emptyFilters = (): AssetFilters => ({ q: '', state: [], crit: [], team: [], owner: [], cluster: [], source: [], identity: [] });

/** URL → filter state. Repeated params (`state=missing&state=late`) select several values; blanks and duplicates are dropped. */
export function parseFilters(params: URLSearchParams | string): AssetFilters {
  const p = typeof params === 'string' ? new URLSearchParams(params) : params;
  const f = emptyFilters();
  f.q = p.get('q') ?? '';
  for (const k of LIST_KEYS) f[k] = [...new Set(p.getAll(k).map((v) => v.trim()).filter(Boolean))];
  return f;
}

/** Filter state → URL. Params that are not filters (e.g. `tab`) are kept; empty filters are removed. */
export function filtersToParams(f: AssetFilters, base?: URLSearchParams | string): URLSearchParams {
  const p = new URLSearchParams(base ?? '');
  p.delete('q');
  for (const k of LIST_KEYS) p.delete(k);
  if (f.q.trim()) p.set('q', f.q);
  for (const k of LIST_KEYS) for (const v of f[k]) p.append(k, v);
  return p;
}

/** Returns a copy with one filter replaced. */
export function withFilter(f: AssetFilters, key: keyof AssetFilters, value: string | string[]): AssetFilters {
  if (key === 'q') return { ...f, q: Array.isArray(value) ? value.join(' ') : value };
  return { ...f, [key]: (Array.isArray(value) ? value : [value]).filter(Boolean) };
}

/** How many filters are set (the Filters button count). `keys` defaults to every list filter. */
export const activeCount = (f: AssetFilters, keys: ListKey[] = LIST_KEYS) => keys.reduce((n, k) => n + (f[k].length ? 1 : 0), 0);

/** Group fleet entities into one row per asset, sorted worst state first, then criticality, then name. */
export function assetRows(fleet: Entity[], inventory: Inventory): AssetRow[] {
  const by = new Map<string, Entity[]>();
  for (const e of fleet) { const l = by.get(e.asset); if (l) l.push(e); else by.set(e.asset, [e]); }
  return [...by].map(([asset, entities]) => ({ id: asset, asset, entities, worst: [...entities].sort((x, y) => rank(x.state) - rank(y.state))[0] }))
    .sort((x, y) => rank(x.worst.state) - rank(y.worst.state) || critNum(inventory, x.asset) - critNum(inventory, y.asset) || x.asset.localeCompare(y.asset));
}

/** The values of one row for each filter (NONE when the row has none). Shared by the predicate and the option lists. */
export function rowValues(r: AssetRow, inventory: Inventory): Record<ListKey, string[]> {
  const i = inventory[r.asset];
  const team = i?.team?.trim() ?? '', contact = i?.contact?.trim() ?? '';
  const cluster = i?.cluster || r.entities.find((e) => e.cluster)?.cluster || '';
  return {
    state: [r.worst.state],
    crit: [i?.criticality ? String(i.criticality) : NONE],
    team: team ? [team] : [NONE, UNASSIGNED],
    owner: contact ? [contact] : team ? [] : [NONE],
    cluster: [cluster || NONE],
    source: [...new Set(r.entities.map((e) => sourceOf(e.input)))],
    identity: [...new Set(r.entities.map((e) => e.key_src || NONE))],
  };
}

/** The filtering predicate. Values within one filter are OR'd; different filters are AND'd. */
export function matchesFilters(r: AssetRow, f: AssetFilters, inventory: Inventory): boolean {
  const v = rowValues(r, inventory);
  if (f.q.trim()) {
    const i = inventory[r.asset];
    const hay = [r.asset, i?.team ?? '', i?.contact ?? '', i?.tags ?? '', v.cluster[0] === NONE ? '' : v.cluster[0], ...r.entities.map((e) => e.input)].join(' ').toLowerCase();
    if (!f.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  return LIST_KEYS.every((k) => !f[k].length || f[k].some((want) => v[k].includes(want)));
}

export const filterAssets = (rows: AssetRow[], f: AssetFilters, inventory: Inventory) => rows.filter((r) => matchesFilters(r, f, inventory));

/** Distinct values of one filter across the rows, sorted, with NONE / UNASSIGNED pulled out into `none`. */
export function optionValues(rows: AssetRow[], inventory: Inventory, key: ListKey): { values: string[]; none: boolean } {
  const s = new Set<string>(); let none = false;
  for (const r of rows) for (const x of rowValues(r, inventory)[key]) { if (x === NONE) none = true; else if (!(key === 'team' && x === UNASSIGNED)) s.add(x); }
  return { values: [...s].sort((a, b) => a.localeCompare(b)), none };
}
