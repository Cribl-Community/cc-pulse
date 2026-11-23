// F3: a failed worker-group read shows a danger Alert and Retry, not the empty state; zero groups still empty.
// Reuses the esbuild-and-fake-API harness from test-setup-fleet.mjs. Run: node scripts/test-setup-groups-error.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available for groups-read errors');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-groups-err-'));
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
export function listGroups() {
  bag().calls.push(['listGroups']);
  if (bag().groupsFail) return Promise.reject(new Error(bag().groupsFailMsg || 'HTTP 500'));
  return Promise.resolve(bag().groups);
}
export function listPacks(g) { bag().calls.push(['listPacks', g]); return Promise.resolve(bag().packs[g] || []); }
export function listInputs(g) { bag().calls.push(['listInputs', g]); return Promise.resolve(bag().inputs[g] || []); }
export function kvGet(k, d) { bag().calls.push(['kvGet', k]); return Promise.resolve(Object.prototype.hasOwnProperty.call(bag().kv, k) ? bag().kv[k] : d); }
export function kvPut() { bag().calls.push(['kvPut']); return Promise.resolve(); }
export function commitGroup() { bag().calls.push(['commitGroup']); return Promise.resolve(); }
export function deployGroup() { bag().calls.push(['deployGroup']); return Promise.resolve(); }
export function runSearch() { bag().calls.push(['runSearch']); return Promise.resolve([]); }
export async function loadRollupContext() { bag().calls.push(['loadRollupContext']); }
export function listPackInputs() { bag().calls.push(['listPackInputs']); return Promise.resolve([]); }
export function listPackRoutes() { bag().calls.push(['listPackRoutes']); return Promise.resolve([]); }
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
        loader: 'js', resolveDir: root,
        contents: args.path === 'api' ? API : args.path === 'fleet' ? FLEET : STATE,
      }));
    },
  }],
});

const DS = 'pulse_metrics_pq';
const pulse = {
  settings: {
    dataset: DS, destination: 'pulse_lake_pq', routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
};
const baseFixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 4 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }] },
  kv: {},
  search: { dataset: DS, targets: [], schedules: true, saved: 0, lookups: 0, outdated: 0 },
  groupsFail: false,
  groupsFailMsg: 'HTTP 500',
};

const html = (fixture) => `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();</script>
<script src="app.js"></script></body></html>`;

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  const text = async () => page.locator('body').innerText();

  // Case 1: listGroups rejects — danger Alert, Retry, no empty state or table.
  writeFileSync(join(dir, 'index.html'), html({ ...baseFixture, groupsFail: true }));
  await page.goto(`file://${join(dir, 'index.html')}`);
  await page.getByText('Could not read the worker groups:', { exact: false }).waitFor({ timeout: 15000 });
  let body = await text();
  ok(body.includes('Could not read the worker groups:'), 'groups read failure shows the groups error prefix');
  ok(body.includes('HTTP 500'), 'groups read failure includes the reason');
  ok(await page.getByRole('button', { name: 'Retry', exact: true }).isVisible(), 'groups read failure shows Retry');
  ok(!body.includes('No worker group yet'), 'groups read failure does not show No worker group yet');
  ok(await page.getByRole('row').filter({ has: page.getByText('prod-us', { exact: true }) }).count() === 0, 'groups read failure hides the worker-group table');

  const before = await page.evaluate(() => globalThis.__API.calls.filter((c) => c[0] === 'listGroups').length);
  await page.getByRole('button', { name: 'Retry', exact: true }).click();
  await page.waitForFunction((n) => globalThis.__API.calls.filter((c) => c[0] === 'listGroups').length > n, before, { timeout: 5000 });
  ok(true, 'Retry triggers another listGroups read');

  // Case 2: zero groups — empty state, not the groups error.
  const emptyFixture = { ...baseFixture, groups: [], groupsFail: false };
  writeFileSync(join(dir, 'index.html'), html(emptyFixture));
  await page.goto(`file://${join(dir, 'index.html')}`);
  await page.getByText('No worker group yet', { exact: true }).waitFor({ timeout: 15000 });
  body = await text();
  ok(body.includes('No worker group yet'), 'zero groups shows No worker group yet');
  ok(!body.includes('Could not read the worker groups'), 'zero groups does not show the groups read error');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) console.log((await page.locator('body').innerText()).slice(0, 2000));
  } catch { /* already closed */ }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-groups-error: ${fail} failure(s)` : 'test-setup-groups-error: all passed');
process.exit(fail ? 1 : 0);