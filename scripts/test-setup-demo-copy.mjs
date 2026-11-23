// Demo fleet: Copy these sources to… writes demoChoices (Pick + the ids the target lists) and shows Dropped N.
// A locked id on the target is not listed for copy, same as a live source that is not tickable.
// Run: node scripts/test-setup-demo-copy.mjs
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
ok(!!pwPath, 'Playwright is available');
if (!pwPath) process.exit(fail ? 1 : 0);

const src = (id, type, evs, picked, extra) => ({ id, type, evs, picked, ...extra });
const fleet = {
  groups: [
    { id: 'g-src', workers: 2, mode: 'selected', selected: true, packSources: [],
      sources: [src('shared', 'syslog', 10, true), src('only-src', 's3', 5, true), src('stuck', 'syslog', 1, false, { locked: true })] },
    { id: 'g-dst', workers: 3, mode: 'all', selected: true, packSources: [],
      sources: [src('shared', 'syslog', 8, false), src('only-dst', 'http', 4, false), src('only-src', 's3', 2, false, { locked: true })] },
    { id: 'g-other', workers: 1, mode: 'all', selected: false, packSources: [],
      sources: [src('shared', 'syslog', 1, false)] },
  ],
  search: { dataset: 'pulse_metrics', targets: [], schedules: true, saved: 1, lookups: 0, outdated: 0 },
};

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-demo-copy-'));
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
const STATE = `export function usePulse() { return globalThis.__PULSE; }`;
const FLEET = `export function loadFleet() { return Promise.resolve(globalThis.__FLEET); }`;
await build({
  entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile: out, logLevel: 'error', jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":true,"PROD":false,"MODE":"development","BASE_URL":"/"}',
  },
  plugins: [{
    name: 'fakes',
    setup(b) {
      const mine = (args) => args.importer.endsWith('Setup.tsx');
      b.onResolve({ filter: /\/state$/ }, (args) => (mine(args) ? { path: 'state', namespace: 'fake' } : undefined));
      b.onResolve({ filter: /\/setupFleet$/ }, (args) => (mine(args) ? { path: 'fleet', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
        loader: 'js', resolveDir: root, contents: args.path === 'state' ? STATE : FLEET,
      }));
    },
  }],
});

const pulse = {
  settings: {
    dataset: 'pulse_metrics', destination: 'pulse_lake', routeFilter: 'true', rollup: 'off', refresh: '5m', searchLoad: 'standard',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
  refresh: null,
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();
globalThis.__FLEET = ${JSON.stringify(fleet)}; globalThis.__FETCHES = [];
window.fetch = (u) => { globalThis.__FETCHES.push(String(u)); return Promise.reject(new Error('demo must not fetch')); };</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR', e.message); });
  await page.goto(`file://${join(dir, 'index.html')}`);
  const rowOf = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) });
  const rowText = async (id) => rowOf(id).first().innerText();
  const pickOn = (id) => page.locator(`[aria-label="Sources to watch on ${id}"]`).getByText('Pick', { exact: true });
  const dialog = (id) => page.getByRole('dialog', { name: `Sources on ${id}` });

  await rowOf('g-src').first().waitFor({ timeout: 15000 });
  ok((await rowText('g-src')).includes('2 of 3'), 'g-src starts at 2 of 3');
  ok((await rowText('g-dst')).includes('All sources (3)'), 'g-dst starts on All sources (3)');
  ok((await rowText('g-other')).includes('All sources (1)'), 'g-other starts on All sources (1)');

  await pickOn('g-src').click();
  const d = dialog('g-src');
  await d.waitFor({ timeout: 5000 });
  const box = (name) => d.getByRole('checkbox', { name });
  ok(await box(/shared ·/).isChecked(), 'shared starts ticked');
  ok(await box(/only-src ·/).isChecked(), 'only-src starts ticked');
  ok(await box(/stuck ·/).isDisabled(), 'the locked source is not a copy candidate');

  // Drawer ticks, not the saved picks: untick shared, then copy. only-src is locked on g-dst, so nothing is kept.
  await box(/shared ·/).click({ force: true });
  await box('Copy to g-dst').check();
  await d.getByRole('button', { name: 'Copy these sources to…', exact: true }).click();
  await d.getByText('Dropped 1', { exact: true }).waitFor({ timeout: 5000 });
  ok((await d.innerText()).includes('Dropped 1'), 'demo copy says how many ids the target does not take');
  ok((await rowText('g-dst')).includes('0 of 3'), 'a target with no taken id switches to Pick 0 of 3');
  ok((await rowText('g-src')).includes('2 of 3'), 'copy does not change the source group');
  ok((await rowText('g-other')).includes('All sources (1)'), 'an unchecked group is left on All');

  await box(/shared ·/).click({ force: true });
  await box('Copy to g-other').check();
  await d.getByRole('button', { name: 'Copy these sources to…', exact: true }).click();
  await d.getByText('Dropped 2', { exact: true }).waitFor({ timeout: 5000 });
  ok((await rowText('g-dst')).includes('1 of 3'), 'g-dst keeps shared and drops the locked only-src');
  ok((await rowText('g-other')).includes('1 of 1'), 'g-other keeps the id it lists');
  ok((await rowText('g-src')).includes('2 of 3'), 'the source group stays 2 of 3 after the second copy');

  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('g-src')).includes('2 of 3'), 'Cancel leaves the source picks unchanged');
  await rowOf('g-dst').getByRole('button', { name: '1 of 3', exact: true }).click();
  const dst = dialog('g-dst');
  await dst.waitFor({ timeout: 5000 });
  ok(await dst.getByRole('checkbox', { name: /shared ·/ }).isChecked(), 'the kept id is ticked on the target');
  ok(!(await dst.getByRole('checkbox', { name: /only-dst ·/ }).isChecked()), 'an id that was not copied is unticked');
  ok(await dst.getByRole('checkbox', { name: /only-src ·/ }).isDisabled() && !(await dst.getByRole('checkbox', { name: /only-src ·/ }).isChecked()), 'the locked id was not copied onto the target');

  const fetches = await page.evaluate(() => globalThis.__FETCHES);
  ok(fetches.length === 0, `demo copy does not fetch (${JSON.stringify(fetches)})`);
  ok(errors.length === 0, `no page errors (${errors.join('; ')})`);
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

console.log(fail ? `test-setup-demo-copy: ${fail} failure(s)` : 'test-setup-demo-copy: all passed');
process.exit(fail ? 1 : 0);
