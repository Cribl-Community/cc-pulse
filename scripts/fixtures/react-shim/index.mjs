// A tiny hook runtime for scripts/test-heartbeat.mjs: the real React, with useState/useEffect/useMemo/useRef replaced
// by index-addressed cells, so a component can be called as a plain function, re-run and unmounted without a DOM.
import * as R from '../../../node_modules/react/index.js';
export * from '../../../node_modules/react/index.js';
export default R;
const H = (globalThis.__hooks ??= { i: 0, cells: [], cleanups: [] });
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, k) => Object.is(v, b[k]));
export function useState(init) {
  const i = H.i++;
  if (!(i in H.cells)) H.cells[i] = { v: typeof init === 'function' ? init() : init };
  const c = H.cells[i];
  return [c.v, (v) => { c.v = typeof v === 'function' ? v(c.v) : v; }];
}
export function useMemo(fn, deps) {
  const i = H.i++, c = H.cells[i];
  if (!c || !same(c.deps, deps)) H.cells[i] = { v: fn(), deps };
  return H.cells[i].v;
}
export function useRef(v) { const i = H.i++; return (H.cells[i] ??= { current: v }); }
export function useEffect(fn, deps) {
  const i = H.i++, c = H.cells[i];
  if (c && same(c.deps, deps)) return;
  if (c && typeof c.cleanup === 'function') c.cleanup();
  const cleanup = fn();
  H.cells[i] = { deps, cleanup };
  if (typeof cleanup === 'function') H.cleanups.push(cleanup);
}
// No provider in this harness: the TimeScope hooks fall back to the default scope.
export function useContext() { return null; }
