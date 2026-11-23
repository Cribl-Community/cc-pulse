// Spec 014 §6 — the one app-wide TimeScope. The provider lives in state.tsx; this file holds the context and hooks
// (kept apart so state.tsx exports only components and stays fast-refresh friendly).
import { createContext, useContext, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { scopeSearch } from './lib/scopeLoad';
import { DEFAULT_SCOPE, type TimeScope } from './lib/timescope';

export interface ScopeCtx {
  scope: TimeScope;
  /** Applies a new scope: state, KV `ui/timescope` (fire-and-forget) and a pushed URL entry. */
  setScope: (s: TimeScope) => void;
  /** False until the initial URL → KV → default resolution has finished. */
  ready: boolean;
  /** The unsupported-link notice, if any. */
  notice?: string;
}

/** Writes the scope params into the URL: a pushed entry (so Back restores the previous range) or a replace. */
export function putUrl(scope: TimeScope, push: boolean): void {
  const q = scopeSearch(location.search, scope);
  if (q !== location.search) history[push ? 'pushState' : 'replaceState'](history.state, '', location.pathname + q + location.hash);
}

export const TimeScopeCtx = createContext<ScopeCtx | null>(null);
const NO_PROVIDER = { scope: DEFAULT_SCOPE, setScope: () => {} };

/** The active TimeScope and its setter (the default scope and a no-op setter when rendered without the provider, as in tests). */
export function useTimeScope(): { scope: TimeScope; setScope: (s: TimeScope) => void } {
  const ctx = useContext(TimeScopeCtx);
  return ctx ? { scope: ctx.scope, setScope: ctx.setScope } : NO_PROVIDER;
}

/** Time-bound pages call this on mount: writes the scope params into the URL with replace, once the scope is resolved. */
export function useScopeUrlOnMount(): void {
  const ctx = useContext(TimeScopeCtx); // null when rendered without the provider (tests): nothing to write
  const { pathname } = useLocation();
  // Waits for the URL → KV → default resolution, so a deep link is never overwritten by a not-yet-loaded scope.
  useEffect(() => { if (ctx?.ready) putUrl(ctx.scope, false); }, [ctx?.ready, ctx?.scope, pathname]);
}

/** The unsupported-link notice for the shell to show (none when rendered without the provider, as in tests). */
export const useScopeNotice = (): string | undefined => useContext(TimeScopeCtx)?.notice;
