// R1: the Sources Drawer works on live data too (not only in demo). A browser pass over the real Setup
// with the API faked (import.meta.env.DEV false, so hostMode() is live): Pick opens "Sources on <group>",
// the `n of m` text reopens it, Apply / Cancel, pack sources with their reach, a locked source.
// Run: node scripts/test-setup-live-drawer.mjs
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

// The review finding: every Drawer path was gated on demo.
ok(!/if \(demo\) \{\s*\/\/ Pick opens the Drawer/.test(src), 'onMode does not open the Drawer only in demo');
ok(!/const drawerGroup = demo && drawer/.test(src), 'drawerGroup is not demo-only');
ok(!/\{demo && r\.mode === 'selected'/.test(src), 'the n of m button is not demo-only');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-live-drawer-'));
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
export function listPackInputs(g, p) { bag().calls.push(['listPackInputs', g, p]); return Promise.resolve(bag().packInputs[g + '/' + p] || []); }
export function listPackRoutes(g, p) { bag().calls.push(['listPackRoutes', g, p]); return Promise.resolve([]); }
export function api(path) { bag().calls.push(['api', path]); return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
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
      b.onResolve({ filter: /\/api$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'api', namespace: 'fake' } : undefined));
      b.onResolve({ filter: /\/state$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'state', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ loader: 'js', resolveDir: root, contents: args.path === 'api' ? API : STATE }));
    },
  }],
});

const DS = 'pulse_metrics_pq';
const rec = (group, inputs) => ({ group, inputs, filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: 'pulse_lake_pq' });
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 4 }, { id: 'allg', workerCount: 1 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }, { id: 'pp', version: '1.0.0' }], allg: [{ id: 'cribl-pulse', version: '1.3.0' }] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }, { id: 'b', type: 'tcp' }], allg: [{ id: 'a', type: 'syslog' }] },
  packInputs: { 'prod-us/pp': [{ id: 'in1', type: 'syslog' }] },
  kv: { 'deployments/prod-us': rec('prod-us', ['syslog:a']), 'deployments/allg': rec('allg', []) },
};
const pulse = {
  settings: {
    dataset: DS, destination: 'pulse_lake_pq', routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [{ group: 'prod-us', input: 'syslog:a', events_1h: 3600 * 1500 }],
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
  const rowOf = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) });
  await rowOf('prod-us').first().waitFor({ timeout: 15000 });
  const rowText = async (id) => (await rowOf(id).first().innerText()).replace(/\s+/g, ' ');
  const group = (id) => page.locator(`[aria-label="Sources to watch on ${id}"]`);
  const rowMode = async (id) => (await group(id).locator('[aria-checked="true"], [aria-pressed="true"]').innerText()).trim();
  const dialog = (id) => page.getByRole('dialog', { name: `Sources on ${id}` });
  const copyBtn = page.getByRole('button', { name: 'Copy sources to…', exact: true });

  ok(await rowMode('prod-us') === 'Pick' && (await rowText('prod-us')).includes('1 of 2'), 'live prod-us starts on Pick, 1 of 2');

  // Pick (already selected) on a live group opens the Drawer, not 031's inline panel.
  await group('prod-us').getByText('Pick', { exact: true }).click();
  const d = dialog('prod-us');
  await d.waitFor({ timeout: 5000 });
  ok(await d.isVisible(), 'live: Pick opens a dialog titled Sources on prod-us');
  ok(await copyBtn.count() === 0, 'live: Pick does not open the inline panel');
  const calls = await page.evaluate(() => globalThis.__API.calls);
  ok(calls.some((c) => c[0] === 'listPackInputs' && c[1] === 'prod-us' && c[2] === 'pp'), 'live: opening the Drawer reads the group pack sources');
  const sourceBoxes = d.getByRole('checkbox', { name: /·/ });
  ok(await sourceBoxes.count() === 3, `live: own inputs and the pack source are listed (${await sourceBoxes.count()})`);
  ok(await d.getByRole('button', { name: 'Copy these sources to…', exact: true }).isVisible(), 'live: the drawer has Copy these sources to…');
  ok(await d.getByRole('checkbox', { name: 'Copy to allg', exact: true }).count() === 1, 'live: Copy to the other group');
  const dt = await d.innerText();
  ok(/syslog:a · syslog · 1,500 ev\/s/.test(dt), 'live: a source shows its key, type and ev/s');
  ok(dt.includes('in pack pp · stays in the pack') && dt.includes('This source stays inside the pack'), 'live: the pack source shows its reach and the STAYS text');
  ok(await d.getByRole('checkbox', { name: /^syslog:a ·/ }).isChecked(), 'live: the recorded pick starts ticked');
  ok(!(await d.getByRole('checkbox', { name: /^tcp:b ·/ }).isChecked()), 'live: an unpicked source starts unticked');
  ok(await d.getByRole('checkbox', { name: /^syslog:pp\.in1 ·/ }).isDisabled(), 'live: a source that stays in its pack cannot be ticked');
  await d.getByRole('button', { name: 'Tick all', exact: true }).click();
  ok(!(await d.getByRole('checkbox', { name: /^syslog:pp\.in1 ·/ }).isChecked()), 'live: Tick all skips the locked source');
  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-us')).includes('1 of 3'), `live: Cancel keeps the picks (1 of 3 once the pack source is known): ${await rowText('prod-us')}`);

  // The n of m text reopens it; tick tcp:b, Apply.
  await rowOf('prod-us').getByRole('button', { name: '1 of 3', exact: true }).click();
  await d.waitFor({ timeout: 5000 });
  ok(await d.getByRole('checkbox', { name: /^syslog:a ·/ }).isChecked() && !(await d.getByRole('checkbox', { name: /^tcp:b ·/ }).isChecked()), 'live: reopening starts from the row picks');
  await d.getByRole('checkbox', { name: /^tcp:b ·/ }).click({ force: true });
  await d.getByRole('button', { name: 'Apply', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-us')).includes('2 of 3'), `live: Apply sets prod-us to 2 of 3 (${await rowText('prod-us')})`);

  // Pick on a live All group, Cancel: stays All. Pick, Apply: Pick with the ticked sources.
  ok(await rowMode('allg') === 'All', 'live allg starts on All');
  await group('allg').getByText('Pick', { exact: true }).click();
  const da = dialog('allg');
  await da.waitFor({ timeout: 5000 });
  ok(await da.getByRole('checkbox', { name: /^syslog:a ·/ }).isChecked(), 'live: an All group opens with every source ticked');
  await da.getByRole('button', { name: 'Cancel', exact: true }).click();
  await da.waitFor({ state: 'detached', timeout: 5000 });
  ok(await rowMode('allg') === 'All' && (await rowText('allg')).includes('All sources (1)'), 'live: Pick then Cancel leaves allg on All');
  await group('allg').getByText('Pick', { exact: true }).click();
  await da.waitFor({ timeout: 5000 });
  await da.getByRole('button', { name: 'Apply', exact: true }).click();
  await da.waitFor({ state: 'detached', timeout: 5000 });
  ok(await rowMode('allg') === 'Pick' && (await rowText('allg')).includes('1 of 1'), 'live: Apply sets allg to Pick 1 of 1');

  // All switches straight back, with no Drawer.
  await group('prod-us').getByText('All', { exact: true }).click();
  ok(await rowMode('prod-us') === 'All' && await dialog('prod-us').count() === 0, 'live: All sets the mode without opening the Drawer');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-live-drawer: ${fail} failure(s)` : 'test-setup-live-drawer: all passed');
process.exit(fail ? 1 : 0);
