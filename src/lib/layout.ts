/* State helpers for the spec 013 layout primitives in components/ui.tsx: header tabs bound to `?tab=`
   and Section collapse persisted in the app KV store (never browser storage). Kept out of ui.tsx so that
   file only exports components. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { kvGet, kvPut } from './api';

/* ---------- Header tabs: the selected tab lives in the URL as ?tab=<key> ---------- */
export const TAB_PARAM = 'tab';

/** The active tab for a query string: `?tab=` when it names a known tab, else the fallback (first tab). */
export function tabFrom(search: string | URLSearchParams, keys: readonly string[], fallback: string | undefined = keys[0]): string {
  const v = (typeof search === 'string' ? new URLSearchParams(search) : search).get(TAB_PARAM);
  return v && keys.includes(v) ? v : (fallback ?? '');
}

/** Link to the same page with `?tab=<key>`, keeping every other query param. */
export function tabHref(pathname: string, search: string | URLSearchParams, key: string): string {
  const p = new URLSearchParams(search);
  p.set(TAB_PARAM, key);
  return `${pathname}?${p.toString()}`;
}

/** Read and write `?tab=`. Pages use this to know which sub-view to render; Page renders the TabNav. */
export function useTab(keys: readonly string[], fallback: string | undefined = keys[0]): [string, (key: string) => void] {
  const [params, setParams] = useSearchParams();
  const tab = tabFrom(params, keys, fallback);
  const setTab = useCallback((key: string) => setParams((prev) => { const p = new URLSearchParams(prev); p.set(TAB_PARAM, key); return p; }), [setParams]);
  return [tab, setTab];
}

/* ---------- Section collapse: KV key ui/collapsed/<sectionId> ---------- */
type KvGet = <T>(key: string, fallback: T) => Promise<T>;
type KvPut = (key: string, value: unknown) => Promise<void>;

export const collapsedKey = (sectionId: string) => `ui/collapsed/${sectionId}`;
export async function loadCollapsed(sectionId: string, fallback = false, get: KvGet = kvGet): Promise<boolean> {
  const v = await get<unknown>(collapsedKey(sectionId), fallback);
  return typeof v === 'boolean' ? v : fallback;
}
export const saveCollapsed = (sectionId: string, collapsed: boolean, put: KvPut = kvPut) => put(collapsedKey(sectionId), collapsed);

/** Collapsed state for one section. With an id it loads from and saves to KV; without one it is in-memory only. */
export function useCollapsed(sectionId: string | undefined, initial = false): [boolean, (collapsed: boolean) => void] {
  const [collapsed, setCollapsed] = useState(initial);
  const touched = useRef(false);   // a click before the KV read lands wins over the stored value
  useEffect(() => {
    if (!sectionId) return;
    let live = true;
    void loadCollapsed(sectionId, initial).then((v) => { if (live && !touched.current) setCollapsed(v); });
    return () => { live = false; };
  }, [sectionId, initial]);
  const set = useCallback((v: boolean) => {
    touched.current = true;
    setCollapsed(v);
    if (sectionId) saveCollapsed(sectionId, v).catch(() => { /* the toggle still works for this session */ });
  }, [sectionId]);
  return [collapsed, set];
}

/* ---------- Ranked list (spec 013 §6): magnitude bars and ↑/↓/Enter keyboard model ---------- */

/** Width of a ranked row's magnitude bar, as a percentage of the largest value (0–100). */
export function barPct(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0 || value <= 0) return 0;
  return Math.min(100, (value / max) * 100);
}

/** The next focused row for a key press: ↑/↓ move (clamped), Home/End jump; null for any other key. */
export function rankedMove(key: string, index: number, count: number): number | null {
  if (count <= 0) return null;
  const last = count - 1, at = Math.min(Math.max(index, 0), last);
  switch (key) {
    case 'ArrowDown': return Math.min(at + 1, last);
    case 'ArrowUp': return Math.max(at - 1, 0);
    case 'Home': return 0;
    case 'End': return last;
    default: return null;
  }
}
