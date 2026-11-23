import { kvGet, kvPut, publishLookup } from './api';

/* Maintenance windows (spec 006). KV `maintenance` is the master copy; lookup pulse_maintenance.csv is what KQL reads.
   Scopes: "*" everything · "g:<group>" a worker group · "i:<group>|<input>" one source.
   A lookup returns one row per key, so each scope publishes the window that is running now, else the next one.
   Windows that end are dropped on the next publish; KQL compares times itself, so an expired row is harmless. */
export type Window = { id: string; scope: string; start: number; end: number; reason: string; created?: string };

export const loadWindows = () => kvGet<Window[]>('maintenance', []);

export const scopeLabel = (scope: string) => scope === '*' ? 'Everything'
  : scope.startsWith('g:') ? `Worker group ${scope.slice(2)}` : scope.startsWith('i:') ? `Source ${scope.slice(2).split('|')[1]} on ${scope.slice(2).split('|')[0]}` : scope;
export const scopeOf = (e: { group: string; input: string }) => ['*', `g:${e.group}`, `i:${e.group}|${e.input}`];

const nowS = () => Math.floor(Date.now() / 1000);
export const isActive = (w: Window, t = nowS()) => t >= w.start && t < w.end;
export const status = (w: Window, t = nowS()) => (isActive(w, t) ? 'active' : w.start > t ? 'scheduled' : 'ended');

/** The window covering an entity right now, most specific scope first (same order as the KQL). */
export function windowFor(list: Window[], e: { group: string; input: string }, t = nowS()) {
  const [all, grp, src] = scopeOf(e);
  return [src, grp, all].map((s) => list.find((w) => w.scope === s && isActive(w, t))).find(Boolean);
}

export async function publishWindows(list: Window[]) {
  const t = nowS();
  const best = new Map<string, Window>();
  for (const w of list.filter((x) => x.end > t).sort((a, b) => a.start - b.start)) {
    const cur = best.get(w.scope);
    if (!cur || (!isActive(cur, t) && isActive(w, t))) best.set(w.scope, w);
  }
  await publishLookup('pulse_maintenance.csv', ['mw_key', 'mw_start', 'mw_end', 'mw_reason'],
    [['__template__', 0, 0, 'template'], ...[...best.values()].map((w) => [w.scope, w.start, w.end, w.reason || 'maintenance'])],
    'Pulse maintenance windows (managed by the Pulse app)');
}

export async function saveWindows(list: Window[]) {
  const keep = list.filter((w) => w.end > nowS() - 7 * 86400); // keep a week of history for the page
  await kvPut('maintenance', keep);
  await publishWindows(keep);
  return keep;
}
