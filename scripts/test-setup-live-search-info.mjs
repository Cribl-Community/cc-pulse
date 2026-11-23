// R2: on live data the first paint goes through loadFleet() as well (spec 039 §2), so the Cribl Search
// section shows `<n> saved searches · <m> lookups` and `<k> searches outdated` on open, before any Refresh.
// A browser pass over the real Setup with the API and loadFleet() faked (import.meta.env.DEV false, so
// hostMode() is live). Run: node scripts/test-setup-live-search-info.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

// Source: the live branch of the mount load (after the demo early return) calls loadFleet() and sets searchInfo.
const mount = src.match(/useMountedLoad\(\(alive\) => \{([\s\S]*?)\n {2}\}\);/)?.[1] ?? '';
const live = mount.split(/\n\s*return;\n\s*\}/)[1] ?? '';
ok(/loadRows\(\)/.test(live), 'the live mount branch still reads the rows');
ok(/loadFleet\(\{ groups: false \}\)\.then\([^\n]*alive\(\)[^\n]*setSearchInfo\(f\.search\)/.test(live), 'the live mount branch calls loadFleet({ groups: false }) and sets searchInfo (guarded by alive())');
// R5: Refresh asks loadFleet() for groups only in demo; live rows come from loadRows() alone.
const reload = src.match(/function reloadAll\(\) \{([\s\S]*?)\n {2}\}/)?.[1] ?? '';
ok(/loadFleet\(\{ groups: demo \}\)/.test(reload) && !/loadFleet\(\)/.test(reload), 'Refresh calls loadFleet({ groups: demo }), not loadFleet()');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-live-search-info-'));
const entry = join(dir, 'entry.tsx');
const out = join(dir, 'app.js');
writeFileSync(entry, `
import { createElement as h, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Setup } from ${JSON.stringify(join(root, 'src/pages/Setup.tsx'))};
createRoot(document.getElementById('root')).render(
  h(MemoryRouter, null, h(Suspense, { fallback: 'loading' }, h(Setup))));
`);

const API = `
const bag = () => globalThis.__API;
export function listGroups() { bag().calls.push(['listGroups']); return Promise.resolve(bag().groups); }
export function listPacks(g) { bag().calls.push(['listPacks', g]); return Promise.resolve(bag().packs[g] || []); }
export function listInputs(g) { bag().calls.push(['listInputs', g]); return Promise.resolve(bag().inputs[g] || []); }
export function kvGet(k, d) { bag().calls.push(['kvGet', k]); return Promise.resolve(Object.prototype.hasOwnProperty.call(bag().kv, k) ? bag().kv[k] : d); }
export function kvPut() { bag().calls.push(['kvPut']); return Promise.resolve(); }
export function listPackInputs(g, p) { bag().calls.push(['listPackInputs', g, p]); return Promise.resolve([]); }
export function listPackRoutes(g, p) { bag().calls.push(['listPackRoutes', g, p]); return Promise.resolve([]); }
export function api(path) { bag().calls.push(['api', path]); return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
`;
const FLEET = `
export function loadFleet(opts) {
  globalThis.__API.calls.push(['loadFleet', opts ?? null]);
  return Promise.resolve({ groups: [], search: globalThis.__API.search });
}
`;
const STATE = `export function usePulse() { return globalThis.__PULSE; }`;

await build({
  entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile: out, logLevel: 'error', jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  },
  plugins: [{
    name: 'fakes',
    setup(b) {
      const mine = (args) => args.importer.endsWith('Setup.tsx');
      b.onResolve({ filter: /\/api$/ }, (args) => (mine(args) ? { path: 'api', namespace: 'fake' } : undefined));
      b.onResolve({ filter: /\/state$/ }, (args) => (mine(args) ? { path: 'state', namespace: 'fake' } : undefined));
      b.onResolve({ filter: /\/setupFleet$/ }, (args) => (mine(args) ? { path: 'fleet', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
        loader: 'js', resolveDir: root, contents: args.path === 'api' ? API : args.path === 'fleet' ? FLEET : STATE,
      }));
    },
  }],
});

const DS = 'pulse_metrics_pq';
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 4 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }] },
  kv: {},
  search: { dataset: DS, targets: [], schedules: true, saved: 7, lookups: 2, outdated: 3 },
};
const pulse = {
  settings: {
    dataset: DS, destination: 'pulse_lake_pq', routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  await page.getByRole('row').filter({ has: page.getByText('prod-us', { exact: true }) }).first().waitFor({ timeout: 15000 });
  // No Refresh is pressed: this is the first paint.
  const counts = page.getByText('7 saved searches · 2 lookups', { exact: true });
  await counts.waitFor({ timeout: 5000 });
  ok(await counts.isVisible(), 'live first paint shows the saved searches · lookups line');
  ok(await page.getByText('3 searches outdated', { exact: true }).isVisible(), 'live first paint shows the searches outdated tag');
  const calls = await page.evaluate(() => globalThis.__API.calls);
  const n = calls.filter((c) => c[0] === 'loadFleet').length;
  ok(n === 1, `live first paint calls loadFleet() once (${n})`);
  ok(calls.some((c) => c[0] === 'listGroups'), 'live first paint still reads the group rows');
  const groupsOff = (c) => c[0] === 'loadFleet' && c[1] && c[1].groups === false;
  ok(calls.filter((c) => c[0] === 'loadFleet').every(groupsOff), 'live first paint asks loadFleet() for no groups');
  // R5: one Refresh reads each group once (via loadRows) and never reads pack inputs eagerly.
  await page.evaluate(() => { globalThis.__API.calls = []; });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.waitForFunction(() => globalThis.__API.calls.filter((c) => c[0] === 'loadFleet').length >= 1 && globalThis.__API.calls.some((c) => c[0] === 'kvGet'), null, { timeout: 5000 });
  await page.waitForTimeout(300);
  const after = await page.evaluate(() => globalThis.__API.calls);
  const fleets = after.filter((c) => c[0] === 'loadFleet');
  ok(fleets.length === 1 && fleets.every(groupsOff), `Refresh calls loadFleet({ groups: false }) once in live (${JSON.stringify(fleets)})`);
  const count = (name) => after.filter((c) => c[0] === name).length;
  ok(count('listGroups') === 1 && count('listPacks') === 1 && count('listInputs') === 1, `Refresh reads each group once (groups ${count('listGroups')}, packs ${count('listPacks')}, inputs ${count('listInputs')})`);
  ok(count('listPackInputs') === 0, `Refresh reads no pack inputs (${count('listPackInputs')})`);
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-live-search-info: ${fail} failure(s)` : 'test-setup-live-search-info: all passed');
process.exit(fail ? 1 : 0);
