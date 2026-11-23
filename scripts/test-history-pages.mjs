// R6 (spec 033 §5): in Economy the history queries wait for the Overview's Load charts, but Incidents (the ledger),
// Assets (the Available column) and Asset (Available and the activity sparks) have no Load charts of their own.
// Opening one of them is the ask: it starts the history once. Run: node scripts/test-history-pages.mjs
//  1. pure: pageNeedsHistory and historyShouldRun (refresh.ts);
//  2. the hook useHistoryOnOpen, bundled with a fake React (useEffect runs at once) and a fake usePulse;
//  3. wiring, read from source: the three pages call the hook, the Overview keeps its Load charts gate, and
//     loadCharts in state.tsx defers to the open effect until the settings and the scope have landed.
import { build } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-hp-'));
let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

/* ---------- 1. pure ---------- */
await build({ entryPoints: [join(root, 'src/lib/refresh.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(tmp, 'r.mjs'), logLevel: 'error' });
await build({ entryPoints: [join(root, 'src/lib/cadence.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(tmp, 'c.mjs'), logLevel: 'error' });
const R = await import(join(tmp, 'r.mjs'));
const { cadenceOf } = await import(join(tmp, 'c.mjs'));
const onTick = (load) => cadenceOf(load).historyOnTick;
t('pageNeedsHistory: daily, nothing loaded yet → yes', R.pageNeedsHistory({ historyOnTick: onTick('daily'), loaded: false }) === true);
t('pageNeedsHistory: daily, already loaded → no (no second run)', R.pageNeedsHistory({ historyOnTick: onTick('daily'), loaded: true }) === false);
for (const load of ['standard', 'hourly'])
  t(`pageNeedsHistory: ${load} → no (the provider runs it already)`, R.pageNeedsHistory({ historyOnTick: onTick(load), loaded: false }) === false);
t('historyShouldRun: daily open after a page asked → run', R.historyShouldRun({ historyOnTick: false, loaded: true, trigger: 'open' }) === true);
t('historyShouldRun: daily open, nobody asked → no', R.historyShouldRun({ historyOnTick: false, loaded: false, trigger: 'open' }) === false);
t('historyShouldRun: daily tick after a page asked → still no', R.historyShouldRun({ historyOnTick: false, loaded: true, trigger: 'tick' }) === false);

/* ---------- 2. the hook ---------- */
const fakes = {
  name: 'fakes',
  setup(b) {
    b.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'fake' }));
    b.onResolve({ filter: /\/state$/ }, () => ({ path: 'state', namespace: 'fake' }));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, (a) => ({ loader: 'js', contents: a.path === 'react'
      ? 'export const useEffect = (f) => { f(); };'
      : 'export const usePulse = () => globalThis.__pulse;' }));
  },
};
await build({ entryPoints: [join(root, 'src/components/useHistoryOnOpen.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: join(tmp, 'h.mjs'),
  logLevel: 'error', plugins: [fakes] });
// Not named use*: this file calls it outside a component, which the hooks lint rule rejects.
const { useHistoryOnOpen: historyOnOpen } = await import(join(tmp, 'h.mjs'));
const open = (settings, historyLoaded) => {
  let calls = 0;
  globalThis.__pulse = { settings, historyLoaded, loadCharts: async () => { calls++; } };
  historyOnOpen();
  return calls;
};
const daily = { searchLoad: 'daily', rollCall: { hour: 7, tz: 'Europe/Paris', allClear: false } };
t('Economy, page opened directly → the history starts once (loadCharts)', open(daily, false) === 1);
t('Economy, history already loaded (Load charts or another page) → nothing', open(daily, true) === 0);
t('Standard → nothing (no extra job)', open({ searchLoad: 'standard' }, false) === 0);
t('Hourly → nothing (no extra job)', open({ searchLoad: 'hourly' }, false) === 0);
t('settings without a load (old KV) → Standard → nothing', open({}, false) === 0);
globalThis.__pulse = { settings: daily, historyLoaded: false };
let threw = false; try { historyOnOpen(); } catch { threw = true; }
t('a fixture without loadCharts does not throw', threw === false);

/* ---------- 3. wiring ---------- */
const read = (f) => readFileSync(join(root, f), 'utf8');
for (const [page, fn] of [['Incidents', 'Incidents'], ['Assets', 'Assets'], ['Asset', 'Asset']]) {
  const src = read(`src/pages/${page}.tsx`);
  const body = src.slice(src.indexOf(`export function ${fn}()`), src.indexOf(`export function ${fn}()`) + 400);
  t(`${page}.tsx imports and calls useHistoryOnOpen() in its page component`,
    /from '\.\.\/components\/useHistoryOnOpen'/.test(src) && /useHistoryOnOpen\(\);/.test(body));
}
const ov = read('src/pages/Overview.tsx');
t('Overview keeps its Load charts gate and does not auto-load', /loadCharts\(\)/.test(ov) && !/useHistoryOnOpen/.test(ov));
const st = read('src/state.tsx');
const lc = st.slice(st.indexOf('const loadCharts = useCallback'), st.indexOf('const loadCharts = useCallback') + 400);
t('state.tsx loadCharts sets the flag first, and runs only once loaded and the scope is ready',
  /historyLoadedRef\.current = true; setHistoryLoaded\(true\);[\s\S]*if \(!loaded \|\| !sc\.ready\) return;[\s\S]*await run\(/.test(lc));

rmSync(tmp, { recursive: true, force: true });
console.log(fail ? `${fail} failed` : 'history-pages ok');
process.exit(fail ? 1 : 0);
