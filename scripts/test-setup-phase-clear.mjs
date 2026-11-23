// T1: once a fleet run ends (nothing left to Retry) and the plan is rebuilt, the lane phases clear,
// so the "What the deploy does" cell shows what fleetPlan says now (up to date) instead of done.
// A failed lane keeps its phase and its Retry until that lane is retried or skipped.
// Run: node scripts/test-setup-phase-clear.mjs
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

/* ── runEnded, the rule FleetRunner clears on ── */
const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-phase-clear-'));
try {
  const lib = join(dir, 'fleetRun.mjs');
  await build({ entryPoints: [join(root, 'src/lib/fleetRun.ts')], bundle: true, format: 'esm', platform: 'node', outfile: lib, logLevel: 'error' });
  const { runEnded } = await import(pathToFileURL(lib).href);
  const lanes = [{ id: 'a', title: 'a', steps: [] }, { id: 'b', title: 'b', steps: [] }, { id: 'same', title: 'same', steps: [], unchanged: 'up to date' }];
  const steps = [{ id: 'a/route' }, { id: 'a/commit' }, { id: 'b/route' }];
  ok(runEnded(lanes, steps, { 'a/route': { s: 'done' }, 'a/commit': { s: 'done' }, 'b/route': { s: 'done' } }), 'every lane done: the run ended');
  ok(runEnded(lanes, steps, { 'a/route': { s: 'done' }, 'a/commit': { s: 'done' }, 'b/route': { s: 'skipped', msg: 'skipped: b' } }), 'a lane the user skipped: the run ended');
  ok(!runEnded(lanes, steps, { 'a/route': { s: 'done' }, 'a/commit': { s: 'failed' }, 'b/route': { s: 'done' } }), 'a failed lane: not ended, Retry stays');
  ok(!runEnded(lanes, steps, { 'a/route': { s: 'done' }, 'a/commit': { s: 'skipped', msg: 'skipped: needs “x”' }, 'b/route': { s: 'done' } }), 'a lane held by a failed step: not ended');
  ok(!runEnded(lanes, steps, { 'a/route': { s: 'running' } }), 'a running lane: not ended');
} catch (e) {
  fail++;
  console.log('✘ runEnded pass threw', e?.message || e);
}

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { rmSync(dir, { recursive: true, force: true }); process.exit(fail ? 1 : 0); }

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
export function listPacks(g) { return Promise.resolve(bag().packs[g] || []); }
export function listInputs(g) { return Promise.resolve(bag().inputs[g] || []); }
export function kvGet(k, d) { return Promise.resolve(Object.prototype.hasOwnProperty.call(bag().kv, k) ? bag().kv[k] : d); }
export function kvPut() { return Promise.resolve(); }
export function commitGroup() { return Promise.resolve(); }
export function deployGroup() { return Promise.resolve(); }
export function runSearch() { return Promise.resolve([]); }
export function listPackInputs() { return Promise.resolve([]); }
export function listPackRoutes() { return Promise.resolve([]); }
export function api() { return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
`;
const STATE = `
export function usePulse() {
  return { ...globalThis.__PULSE, refresh() { globalThis.__REFRESH += 1; return Promise.resolve(); } };
}
`;
// Stands in for plan.ts. A lane that finishes writes its deployment record, as the real record step does.
const PLAN = `
const bag = () => globalThis.__plan;
const laneOf = (id) => id.split('/')[0];
function record(lane) {
  if (lane === 'shared' || lane === 'search') return;
  globalThis.__API.kv['deployments/' + lane] = {
    group: lane, inputs: [...bag().inputs], filter: '', at: new Date(Date.now() + bag().calls.length * 1000).toISOString(),
    pack: '1.3.0', dataset: 'pulse_metrics_pq', destination: 'pulse_lake_pq',
  };
}
export async function runAll(steps, seed, onChange) {
  bag().calls.push('runAll');
  const state = { ...seed };
  const failed = [];
  for (const st of steps) {
    const bad = laneOf(st.id) === bag().failLane;
    state[st.id] = { s: bad ? 'failed' : 'done' };
    if (bad) failed.push(st.id);
    onChange({ ...state });
  }
  for (const lane of new Set(steps.map((s) => laneOf(s.id)))) if (lane !== bag().failLane) record(lane);
  bag().failLane = '';
  return { failed, state };
}
export async function retryLane(steps, state, lane, onChange) {
  bag().calls.push('retryLane');
  const next = { ...state };
  for (const st of steps) if (laneOf(st.id) === lane) next[st.id] = { s: 'done' };
  record(lane);
  onChange({ ...next });
  return { failed: [], state: next };
}
export function skipLane(steps, state) { bag().calls.push('skipLane'); return state; }
`;

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
      b.onResolve({ filter: /\/plan$/ }, (args) => (args.importer.endsWith('FleetRunner.tsx') ? { path: 'plan', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
        loader: 'js', resolveDir: root,
        contents: args.path === 'api' ? API : args.path === 'state' ? STATE : PLAN,
      }));
    },
  }],
});

const LEARN = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const DS = 'pulse_metrics_pq';
const DEST = 'pulse_lake_pq';
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 2 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }, { id: 'b', type: 'syslog' }] },
  kv: { 'deployments/prod-us': { group: 'prod-us', inputs: ['syslog:a'], filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST } },
};
const pulse = {
  settings: {
    dataset: DS, destination: DEST, routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: ['slack_noc'], email: '', routes: [] }, learning: LEARN,
  },
  fleet: [],
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body><div id="root"></div>
<script>
window.CRIBL_BASE_PATH = '/app-ui/pulse';
globalThis.__API = ${JSON.stringify(fixture)};
globalThis.__PULSE = ${JSON.stringify(pulse)};
globalThis.__plan = { calls: [], failLane: 'prod-us', inputs: ['syslog:a', 'syslog:b'] };
globalThis.__REFRESH = 0;
</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
const slice = (body, start, end) => {
  const i = body.indexOf(start);
  const j = end ? body.indexOf(end, i + start.length) : body.length;
  return i < 0 ? '' : body.slice(i, j < 0 ? body.length : j);
};
const flat = (s) => s.replace(/\n/g, ' | ');
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so force the click.
  const prodRow = page.getByRole('row').filter({ has: page.getByText('prod-us', { exact: true }) });
  const include = prodRow.getByRole('checkbox');
  await include.waitFor({ timeout: 15000 });
  await include.click({ force: true });
  const openSources = async () => {
    await page.locator('[aria-label="Sources to watch on prod-us"]').getByText('Pick', { exact: true }).click();
    const sources = page.getByRole('dialog', { name: 'Sources on prod-us' });
    await sources.waitFor({ timeout: 15000 });
    return sources;
  };
  let sources = await openSources();
  await sources.getByRole('checkbox', { name: /^syslog:b ·/ }).click();
  await sources.getByRole('button', { name: 'Apply', exact: true }).click();
  await sources.waitFor({ state: 'detached' });
  const body = () => page.locator('body').innerText();
  const prodCell = async () => prodRow.innerText();
  const searchBlock = async () => slice(await body(), 'Cribl Search alerts', 'Deploy everything');
  const listReads = () => page.evaluate(() => globalThis.__API.calls.filter((c) => c[0] === 'listGroups').length);
  ok(/\broute\b/.test(await prodCell()) && !(await prodCell()).includes('up to date'), `before the run the cell is the plan (${flat(await prodCell())})`);

  // Run 1: prod-us fails. Its phase and Retry stay; Search shows done until nothing is left to retry.
  const deploy = page.getByRole('button', { name: 'Deploy everything', exact: true });
  const dialog = page.getByRole('dialog');
  await deploy.click();
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
  const retry = page.getByRole('button', { name: 'Retry prod-us', exact: true });
  await retry.waitFor({ timeout: 5000 });
  await page.waitForFunction(() => globalThis.__REFRESH === 1);
  await page.waitForTimeout(200);
  ok((await prodCell()).includes('failed'), `a failed lane keeps its phase (${flat(await prodCell())})`);
  ok(/\bdone\b/.test(await searchBlock()), 'Search shows done while prod-us still has a Retry');
  ok(await listReads() === 1, 'a run with a failed lane does not reload the groups yet');

  // Retry succeeds: the run has ended, the rows are read again, and the phases clear.
  await retry.click();
  await page.waitForFunction(() => globalThis.__API.calls.filter((c) => c[0] === 'listGroups').length === 2, null, { timeout: 5000 });
  await page.waitForFunction(() => document.body.innerText.includes('up to date'), null, { timeout: 5000 });
  const after = await prodCell();
  ok(after.includes('up to date') && !/\bdone\b/.test(after) && !after.includes('failed'),
    `after Retry the cell is the rebuilt plan, not the phase (${flat(after)})`);
  ok(!/\bdone\b/.test(await searchBlock()), `the Search block drops its done phase (${flat(await searchBlock())})`);
  ok(await retry.count() === 0, 'nothing is left to retry');
  ok(await include.isChecked(), 'prod-us stays included after the reload');

  // Run 2: a change that deploys cleanly goes straight from the run to the rebuilt plan.
  await page.evaluate(() => { globalThis.__plan.inputs = ['syslog:a']; });
  sources = await openSources();
  await sources.getByRole('checkbox', { name: /^syslog:b ·/ }).click();
  await sources.getByRole('button', { name: 'Apply', exact: true }).click();
  await sources.waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.body.innerText.includes('up to date'), null, { timeout: 5000 });
  ok(/\broute\b/.test(await prodCell()), `a new change shows its plan (${flat(await prodCell())})`);
  await deploy.click();
  await dialog.waitFor({ timeout: 5000 });
  await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.waitForFunction(() => globalThis.__API.calls.filter((c) => c[0] === 'listGroups').length === 3, null, { timeout: 5000 });
  await page.waitForFunction(() => document.body.innerText.includes('up to date'), null, { timeout: 5000 });
  const clean = await prodCell();
  ok(clean.includes('up to date') && !/\bdone\b/.test(clean), `a clean run ends on the rebuilt plan (${flat(clean)})`);
  ok(await page.evaluate(() => globalThis.__REFRESH) === 3, 'refresh() still runs after every settled run');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-phase-clear: ${fail} failure(s)` : 'test-setup-phase-clear: all passed');
process.exit(fail ? 1 : 0);
