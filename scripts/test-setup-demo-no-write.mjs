// R4: spec 039 §2 "Demo never writes … No request leaves the page in demo." Setup has no saveSettings();
// opening the page in demo must not issue requests.
// Run: node scripts/test-setup-demo-no-write.mjs
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

ok(!/saveSettings\(/.test(src), 'Setup.tsx has no saveSettings() call');
ok(!/void saveSettings\(/.test(src), 'no void-ed saveSettings() left in Setup');
ok(!/function changeLoad/.test(src), 'changeLoad removed from Setup');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);

const STATE = `
import { useState } from 'react';
export function usePulse() {
  const [settings, setSettings] = useState(globalThis.__PULSE.settings);
  return { ...globalThis.__PULSE, settings, setSettings };
}`;
const API = `
const bag = () => globalThis.__API;
export function listGroups() { bag().calls.push(['listGroups']); return Promise.resolve(bag().groups); }
export function listPacks(g) { return Promise.resolve(bag().packs[g] || []); }
export function listInputs(g) { return Promise.resolve(bag().inputs[g] || []); }
export function kvGet(k, d) { return Promise.resolve(d); }
export function kvPut() { return Promise.resolve(); }
export function listPackInputs() { return Promise.resolve([]); }
export function listPackRoutes() { return Promise.resolve([]); }
export function api() { return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
`;
const FLEET = `export function loadFleet() { return Promise.resolve({ groups: [], search: null }); }`;

async function bundle(dir) {
  const entry = join(dir, 'entry.tsx');
  writeFileSync(entry, `
import { createElement as h, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Setup } from ${JSON.stringify(join(root, 'src/pages/Setup.tsx'))};
createRoot(document.getElementById('root')).render(
  h(MemoryRouter, null, h(Suspense, { fallback: 'loading' }, h(Setup))));
`);
  const fakes = { state: STATE, api: API, fleet: FLEET };
  await build({
    entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile: join(dir, 'app.js'), logLevel: 'error', jsx: 'automatic',
    loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
    define: {
      'process.env.NODE_ENV': '"production"',
      'import.meta.env': '{"DEV":true,"PROD":false,"MODE":"development","BASE_URL":"/"}',
    },
    plugins: [{
      name: 'fakes',
      setup(b) {
        const mine = (args) => args.importer.endsWith('Setup.tsx');
        const map = { state: /\/state$/, api: /\/api$/, fleet: /\/setupFleet$/ };
        for (const [k, filter] of Object.entries(map)) {
          b.onResolve({ filter }, (args) => (mine(args) ? { path: k, namespace: 'fake' } : undefined));
        }
        b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ loader: 'js', resolveDir: root, contents: fakes[args.path] }));
      },
    }],
  });
}

const pulse = {
  settings: {
    dataset: 'pulse_metrics', destination: 'pulse_lake', routeFilter: 'true', rollup: 'off', refresh: '5m', searchLoad: 'standard',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
};
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 4 }],
  packs: { 'prod-us': [] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }] },
};

async function pass() {
  const dir = mkdtempSync(join(root, 'node_modules', '.tmp-demo-no-write-demo-'));
  const browser = await chromium.launch({ headless: true });
  try {
    await bundle(dir);
    writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();
globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__FETCHES = [];
window.fetch = (u, o) => { globalThis.__FETCHES.push([String(u), (o && o.method) || 'GET']); return Promise.reject(new Error('no API in this test')); };</script>
<script src="app.js"></script></body></html>`);
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('CONSOLE', m.text()); } });
    await page.goto(`file://${join(dir, 'index.html')}`);
    await page.getByText('Cribl Search alerts', { exact: true }).waitFor({ timeout: 15000 });
    await page.getByText('Search load:', { exact: false }).waitFor({ timeout: 5000 });
    const fetches = await page.evaluate(() => globalThis.__FETCHES);
    const writes = fetches.filter(([u, m]) => m !== 'GET' || /kvstore/.test(u));
    ok(writes.length === 0, `demo: opening Setup sends no write (${JSON.stringify(writes)})`);
    ok(fetches.length === 0, `demo: no request leaves the page (${JSON.stringify(fetches)})`);
    ok(errors.length === 0, `demo: no page or console errors (${errors.length})`);
  } catch (e) {
    fail++;
    console.log('✘ demo browser pass threw', e?.message || e);
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

await pass();

console.log(fail ? `test-setup-demo-no-write: ${fail} failure(s)` : 'test-setup-demo-no-write: all passed');
process.exit(fail ? 1 : 0);