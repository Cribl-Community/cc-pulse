// Spec 014 §6 — where the app-wide TimeScope comes from and where it goes. Pure apart from persistScope's injected writer.
import { DEFAULT_SCOPE, fromParams, rangeLabel, type TimeScope } from './timescope';

export const SCOPE_KEY = 'ui/timescope';
export type ScopeSource = 'url' | 'kv' | 'default';
export interface InitialScope { scope: TimeScope; source: ScopeSource; toast?: string }

/**
 * Load order: URL params → KV `ui/timescope` → DEFAULT_SCOPE.
 * An unusable URL range (invalid or over 48 h) is ignored and flagged with the toast text naming what is shown instead.
 */
export function resolveInitialScope(search: string, kv: unknown, nowS: number): InitialScope {
  const url = fromParams(new URLSearchParams(search), nowS);
  if (url) return { scope: url, source: 'url' };
  // A KV value is used only when it is a well-formed, currently valid scope (tz defaults to local).
  const k = kv && typeof kv === 'object' ? fromParams(new URLSearchParams(kv as Record<string, string>), nowS) : undefined;
  const r: InitialScope = k ? { scope: k, source: 'kv' } : { scope: DEFAULT_SCOPE, source: 'default' };
  if (/\b(earliest|latest|tz)=/.test(search)) r.toast = `The link's time range isn't supported (max 48 h) — showing ${rangeLabel(r.scope, nowS)}`;
  return r;
}

/** `search` with the scope params set (other params kept), as `?…`. */
export function scopeSearch(search: string, scope: TimeScope): string {
  const p = new URLSearchParams(search);
  // Absolute bounds are already epoch seconds in the model (resolveBound), so a shared link is zone-independent.
  for (const k of ['earliest', 'latest', 'tz'] as const) p.set(k, scope[k]);
  return `?${p}`;
}

/** Fire-and-forget KV write: never awaited by callers; a rejected write is swallowed. */
export function persistScope(scope: TimeScope, put: (key: string, value: unknown) => Promise<unknown>): void {
  put(SCOPE_KEY, scope).catch(() => undefined);
}
