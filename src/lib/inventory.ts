import { kvGet, kvPut, publishLookup } from './api';

/* Asset inventory — slow-changing facts a person enters once (owner, criticality, runbook, HA cluster…).
   Keyed by asset name, not by source: a host sending to syslog AND windows events is one asset with one owner.
   KV `inventory` is the master copy; lookup pulse_assets.csv is what the searches join on.
   Classification rules (spec 008) fill the gaps for assets nobody described: explicit values always win. */
export type Criticality = 1 | 2 | 3 | 4;
export type AssetInfo = {
  criticality?: Criticality; team?: string; contact?: string; environment?: string;
  location?: string; description?: string; runbook?: string; tags?: string; cluster?: string; updatedAt?: string;
};
export type Inventory = Record<string, AssetInfo>;
export type Cluster = { min_pct: number; description?: string };
export type Clusters = Record<string, Cluster>;
export type ClassRule = { id: string; match: string; input?: string; set: Pick<AssetInfo, 'criticality' | 'team' | 'environment' | 'tags' | 'cluster'> };

export const CRIT: Record<Criticality, { label: string; long: string; color: 'danger' | 'warning' | 'info' | 'default' }> = {
  1: { label: 'P1', long: 'P1 · Critical', color: 'danger' },
  2: { label: 'P2', long: 'P2 · High', color: 'warning' },
  3: { label: 'P3', long: 'P3 · Medium', color: 'info' },
  4: { label: 'P4', long: 'P4 · Low', color: 'default' },
};
/** Unclassified assets sort as P3 so a missing P1 always ranks first, but an unknown asset isn't ignored. */
export const critOf = (i?: AssetInfo): Criticality => i?.criticality ?? 3;

export const loadInventory = () => kvGet<Inventory>('inventory', {});
export const loadClusters = () => kvGet<Clusters>('clusters', {});
export const saveClusters = (c: Clusters) => kvPut('clusters', c);
export const loadRules = () => kvGet<ClassRule[]>('policies/classify', []);
export const saveRules = (r: ClassRule[]) => kvPut('policies/classify', r);

const safeRe = (p: string) => { try { return new RegExp(p, 'i'); } catch { return null; } };
export const ruleMatches = (r: ClassRule, asset: string, input?: string) =>
  !!safeRe(r.match)?.test(asset) && (!r.input || (input !== undefined && !!safeRe(r.input)?.test(input)));

/** Explicit inventory over the first matching rule, field by field. `fromRule` names the rule that filled a gap. */
export function effectiveInfo(inv: Inventory, rules: ClassRule[], asset: string, input?: string): AssetInfo & { fromRule?: string } {
  const own = inv[asset];
  const rule = rules.find((r) => ruleMatches(r, asset, input));
  if (!rule) return own ?? {};
  const mine = Object.fromEntries(Object.entries(own ?? {}).filter(([, v]) => v !== undefined && v !== '')) as AssetInfo;
  const filled = (Object.keys(rule.set) as (keyof AssetInfo)[]).filter((k) => rule.set[k as keyof ClassRule['set']] !== undefined && mine[k] === undefined);
  return { ...rule.set, ...mine, ...(filled.length ? { fromRule: rule.id } : {}) };
}

/** Resolves the whole fleet once, so pages read one map. */
export function resolveInventory(inv: Inventory, rules: ClassRule[], seen: { asset: string; input: string }[]): Inventory {
  if (!rules.length) return inv;
  const out: Inventory = { ...inv };
  for (const a of seen) if (!out[a.asset] || !('fromRule' in out[a.asset])) out[a.asset] = effectiveInfo(inv, rules, a.asset, a.input);
  return out;
}

export async function publishInventory(inv: Inventory, clusters: Clusters = {}, rules: ClassRule[] = [], seen: { asset: string; input: string }[] = []) {
  const all = resolveInventory(inv, rules, seen);
  const rows = Object.entries(all).filter(([, i]) => i.criticality || i.team || i.contact || i.environment || i.cluster)
    .map(([a, i]) => [a, i.criticality ?? '', i.team, i.contact, i.environment, i.cluster, i.cluster ? (clusters[i.cluster]?.min_pct ?? 50) : '']);
  await publishLookup('pulse_assets.csv', ['asset', 'criticality', 'team', 'contact', 'environment', 'cluster', 'cluster_min'],
    [['__example__', 4, 'template', '', '', '', ''], ...rows], 'Pulse asset inventory (managed by the Pulse app)');
}

export type InvCtx = { clusters: Clusters; rules: ClassRule[]; seen: { asset: string; input: string }[] };
/** Saves one asset's info to KV, then republishes the lookup. The KV write is what the app reads,
 *  so a lookup failure is reported but does not lose the edit. */
export async function saveAssetInfo(inv: Inventory, asset: string, info: AssetInfo, ctx?: InvCtx): Promise<{ inv: Inventory; lookupError?: string }> {
  const next = { ...inv, [asset]: { ...info, updatedAt: new Date().toISOString() } };
  await kvPut('inventory', next);
  try { await publishInventory(next, ctx?.clusters, ctx?.rules, ctx?.seen); return { inv: next }; }
  catch (e) { return { inv: next, lookupError: e instanceof Error ? e.message : String(e) }; }
}
