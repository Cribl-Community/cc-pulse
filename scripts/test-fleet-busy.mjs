// T4: one run at a time. While a Deploy everything run or a lane retry is in progress,
// FleetRunner reports busy, disables Retry and Skip on every failed lane, ignores a second
// confirm/retry/skip, and Setup disables Deploy everything.
// Run: node scripts/test-fleet-busy.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

const setupSrc = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
ok(/disabled=\{blocked \|\| upToDate \|\| busy\}/.test(setupSrc), 'Setup disables Deploy everything while the runner is busy');
const runnerSrc = readFileSync(join(root, 'src/components/FleetRunner.tsx'), 'utf8');
ok((runnerSrc.match(/disabled=\{busy\}/g) ?? []).length === 2, 'FleetRunner disables Retry and Skip while busy');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) process.exit(fail ? 1 : 0);

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-fleet-busy-'));
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);

const DEFINE = {
  'process.env.NODE_ENV': '"production"',
  'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
};
const LOADERS = { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' };

// runAll and retryLane each wait on a gate the test opens (bag().release), so the test can act
// while one is in progress.
const PLAN = `
const bag = () => globalThis.__plan;
const gate = () => new Promise((r) => { bag().release = () => { bag().release = null; r(); }; });
export async function runAll(steps, seed, onChange) {
  bag().calls.push(['runAll', steps.length]);
  await gate();
  const state = { ...seed };
  for (const st of steps) { state[st.id] = { s: 'done' }; onChange({ ...state }); }
  return { failed: [], state };
}
export async function retryLane(steps, state, lane, onChange) {
  bag().calls.push(['retryLane', lane]);
  await gate();
  const next = { ...state };
  for (const st of steps) if (st.id.startsWith(lane + '/')) next[st.id] = { s: 'done' };
  onChange({ ...next });
  return { failed: [], state: next };
}
export function skipLane(steps, state, lane, onChange) {
  bag().calls.push(['skipLane', lane]);
  const next = { ...state };
  for (const st of steps) if (st.id.startsWith(lane + '/')) next[st.id] = { s: 'skipped', msg: 'skipped by user' };
  onChange({ ...next });
  return next;
}
`;
const FAKES = {
  plan: PLAN,
  api: `
const bag = () => globalThis.__API;
export function listGroups() { return Promise.resolve(bag().groups); }
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
`,
  state: `export function usePulse() { return { ...globalThis.__PULSE, refresh() { return Promise.resolve(); } }; }`,
};
const fakes = {
  name: 'fakes',
  setup(b) {
    b.onResolve({ filter: /\/plan$/ }, (args) => (args.importer.endsWith('FleetRunner.tsx') ? { path: 'plan', namespace: 'fake' } : undefined));
    b.onResolve({ filter: /\/api$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'api', namespace: 'fake' } : undefined));
    b.onResolve({ filter: /\/state$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'state', namespace: 'fake' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({ loader: 'js', resolveDir: root, contents: FAKES[args.path] }));
  },
};
const bundle = (entry, outfile) => build({
  entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile, logLevel: 'error', jsx: 'automatic',
  loader: LOADERS, define: DEFINE, plugins: [fakes],
});

/* ── FleetRunner: two failed lanes, so a retry on one leaves the other's buttons on screen ── */
const runnerEntry = join(dir, 'runner.tsx');
writeFileSync(runnerEntry, `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FleetRunner } from ${JSON.stringify(join(root, 'src/components/FleetRunner.tsx'))};
const step = (id) => ({ id, title: id, detail: id, run: async () => 'ok' });
const ids = ['prod-us', 'dmz'];
const lanes = ids.map((g) => ({ id: g, title: g, steps: [step(g + '/deploy'), step(g + '/record')] }));
const steps = lanes.flatMap((l) => l.steps);
const failed = Object.fromEntries(ids.flatMap((g) => [
  [g + '/deploy', { s: 'failed', msg: 'deploy failed' }],
  [g + '/record', { s: 'skipped', msg: 'skipped: needs “Deploy”' }],
]));
function App() {
  const [open, setOpen] = useState(false);
  return h(FleetRunner, {
    lanes, steps, rows: [{ where: 'fleet', text: 'deploy' }], open, status: failed, onClose: () => setOpen(false),
  }, (views, actions) => { globalThis.__actions = actions; return h('div', null,
    h('div', { id: 'busy' }, 'busy:' + actions.busy),
    h('div', { id: 'phases' }, views.map((v) => v.id + '=' + v.phase).join(',')),
    h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open deploy')); });
}
createRoot(document.getElementById('root')).render(h(App));
`);
await bundle(runnerEntry, join(dir, 'runner.js'));
writeFileSync(join(dir, 'runner.html'), `<!doctype html><html><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__plan = { calls: [] };</script>
<script src="runner.js"></script></body></html>`);

/* ── Setup: one group to deploy, Search on, so the plan has steps ── */
const setupEntry = join(dir, 'setup.tsx');
writeFileSync(setupEntry, `
import { createElement as h, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Setup } from ${JSON.stringify(join(root, 'src/pages/Setup.tsx'))};
createRoot(document.getElementById('root')).render(h(MemoryRouter, null, h(Suspense, { fallback: 'loading' }, h(Setup))));
`);
await bundle(setupEntry, join(dir, 'setup.js'));
const LEARN = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const DS = 'pulse_metrics_pq';
const DEST = 'pulse_lake_pq';
const fixture = {
  groups: [{ id: 'prod-us', workerCount: 2 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }, { id: 'b', type: 'syslog' }] },
  kv: { 'deployments/prod-us': { group: 'prod-us', inputs: ['syslog:a'], filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST } },
};
const pulse = {
  settings: { dataset: DS, destination: DEST, routeFilter: 'true', rollup: 'off', refresh: '5m', notify: { targets: ['slack_noc'], email: '', routes: [] }, learning: LEARN },
  fleet: [],
};
writeFileSync(join(dir, 'setup.html'), `<!doctype html><html><body><div id="root"></div>
<script>
window.CRIBL_BASE_PATH = '/app-ui/pulse';
globalThis.__API = ${JSON.stringify(fixture)};
globalThis.__PULSE = ${JSON.stringify(pulse)};
globalThis.__plan = { calls: [] };
</script>
<script src="setup.js"></script></body></html>`);

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'runner.html')}`);
  const btn = (name) => page.getByRole('button', { name, exact: true });
  const busy = () => page.locator('#busy').innerText();
  const calls = () => page.evaluate(() => globalThis.__plan.calls);
  const confirmDeploy = async () => {
    await btn('Open deploy').click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
  };
  await btn('Open deploy').waitFor({ timeout: 15000 });
  ok((await busy()) === 'busy:false', 'the runner is not busy before anything runs');
  ok(await btn('Retry dmz').isEnabled() && await btn('Skip dmz').isEnabled(), 'Retry and Skip are enabled while nothing runs');

  // A retry on prod-us is in progress: dmz's Retry and Skip are disabled, and no second retry starts.
  await btn('Retry prod-us').click();
  await page.waitForFunction(() => typeof globalThis.__plan.release === 'function', null, { timeout: 5000 });
  ok((await busy()) === 'busy:true', 'the runner reports busy while a retry runs');
  ok(await btn('Retry dmz').isDisabled() && await btn('Skip dmz').isDisabled(), 'Retry dmz and Skip dmz are disabled while prod-us retries');
  ok(await btn('Retry prod-us').isDisabled() && await btn('Skip prod-us').isDisabled(), 'the retrying lane\'s own Retry and Skip are disabled');
  await page.evaluate(() => { void globalThis.__actions.retry('dmz'); globalThis.__actions.skip('dmz'); });
  await page.waitForTimeout(100);
  ok(JSON.stringify(await calls()) === JSON.stringify([['retryLane', 'prod-us']]), `a retry or skip called during a retry does nothing (${JSON.stringify(await calls())})`);

  // Deploy everything confirmed during a retry does not start a run.
  await confirmDeploy();
  await page.waitForTimeout(100);
  ok(!(await calls()).some((c) => c[0] === 'runAll'), 'Deploy confirmed during a retry does not call runAll');

  await page.evaluate(() => globalThis.__plan.release());
  await page.waitForFunction(() => document.getElementById('busy').innerText === 'busy:false', null, { timeout: 5000 });
  ok(await btn('Retry dmz').isEnabled() && await btn('Skip dmz').isEnabled(), 'Retry dmz and Skip dmz are enabled again once the prod-us retry settles');
  ok(await btn('Retry prod-us').count() === 0, 'prod-us is no longer offered Retry');

  // Skip is not a run: it works when nothing is in progress.
  await btn('Skip dmz').click();
  await page.waitForTimeout(50);
  ok((await calls()).some((c) => c[0] === 'skipLane' && c[1] === 'dmz'), 'Skip dmz runs when nothing is in progress');

  // A Deploy everything run is in progress: a second confirm does not start another runAll.
  await confirmDeploy();
  await page.waitForFunction(() => typeof globalThis.__plan.release === 'function', null, { timeout: 5000 });
  ok((await busy()) === 'busy:true', 'the runner reports busy while Deploy everything runs');
  await confirmDeploy();
  await page.waitForTimeout(100);
  ok((await calls()).filter((c) => c[0] === 'runAll').length === 1, `a second confirm during a run does not start another runAll (${JSON.stringify(await calls())})`);
  await page.evaluate(() => globalThis.__plan.release());
  await page.waitForFunction(() => document.getElementById('busy').innerText === 'busy:false', null, { timeout: 5000 });
  ok(true, 'busy clears once the run settles');
  await page.close();

  // Setup: Deploy everything is disabled while its run is in progress, and enabled after.
  const setup = await browser.newPage();
  setup.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await setup.goto(`file://${join(dir, 'setup.html')}`);
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so force the click.
  const include = setup.getByRole('row').filter({ has: setup.getByText('prod-us', { exact: true }) }).getByRole('checkbox');
  await include.waitFor({ timeout: 15000 });
  await include.click({ force: true });
  const deploy = setup.getByRole('button', { name: 'Deploy everything', exact: true });
  ok(await deploy.isEnabled(), 'Setup: Deploy everything is enabled before a run');
  await deploy.click();
  const sd = setup.getByRole('dialog');
  await sd.waitFor({ timeout: 5000 });
  await sd.getByRole('button', { name: 'Deploy', exact: true }).click();
  await setup.waitForFunction(() => typeof globalThis.__plan.release === 'function', null, { timeout: 5000 });
  ok(await deploy.isDisabled(), 'Setup: Deploy everything is disabled while the run is in progress');
  await setup.evaluate(() => globalThis.__plan.release());
  await setup.waitForFunction(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent === 'Deploy everything');
    return b && !b.disabled;
  }, null, { timeout: 5000 });
  ok(await deploy.isEnabled(), 'Setup: Deploy everything is enabled again once the run settles');
  const setupCalls = await setup.evaluate(() => globalThis.__plan.calls);
  ok(setupCalls.filter((c) => c[0] === 'runAll').length === 1, `Setup: one run was started (${JSON.stringify(setupCalls)})`);
  await setup.close();
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-fleet-busy: ${fail} failure(s)` : 'test-fleet-busy: all passed');
process.exit(fail ? 1 : 0);
