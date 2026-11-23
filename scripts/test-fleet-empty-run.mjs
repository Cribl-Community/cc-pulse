// T2: every Deploy everything confirm resets the runner, even when the plan has no steps
// (runAll never calls onChange then), and Setup disables Deploy everything with
// "Everything is up to date" when the flattened plan has no steps.
// Run: node scripts/test-fleet-empty-run.mjs
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
ok(/plan\.steps\.length === 0/.test(setupSrc), 'Setup checks the flattened plan for steps');
ok(/disabled=\{blocked \|\| upToDate\b/.test(setupSrc), 'Deploy everything is disabled when the plan has no steps');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) process.exit(fail ? 1 : 0);

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-fleet-empty-run-'));
const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);

const DEFINE = {
  'process.env.NODE_ENV': '"production"',
  'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
};
const LOADERS = { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' };

// runAll waits on a gate the test opens, and only calls onChange for the steps it is given
// (none for an empty plan), like plan.ts.
const PLAN = `
const bag = () => globalThis.__plan;
export async function runAll(steps, seed, onChange) {
  bag().calls.push(['runAll', steps.length]);
  await new Promise((r) => { bag().release = r; });
  const state = { ...seed };
  for (const st of steps) { state[st.id] = { s: 'done' }; onChange({ ...state }); }
  return { failed: [], state };
}
export async function retryLane(steps, state) { bag().calls.push(['retryLane']); return { failed: [], state }; }
export function skipLane(steps, state) { bag().calls.push(['skipLane']); return state; }
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

/* ── FleetRunner: a previous failed run's Retry/Skip and phases go as soon as Deploy is confirmed ── */
const runnerEntry = join(dir, 'runner.tsx');
writeFileSync(runnerEntry, `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FleetRunner } from ${JSON.stringify(join(root, 'src/components/FleetRunner.tsx'))};
const step = (id) => ({ id, title: id, detail: id, run: async () => 'ok' });
const deploy = step('prod-us/deploy');
const record = step('prod-us/record');
const lanes = [{ id: 'prod-us', title: 'prod-us', steps: [deploy, record] }];
const failed = { 'prod-us/deploy': { s: 'failed', msg: 'deploy failed' }, 'prod-us/record': { s: 'skipped', msg: 'skipped: needs “Deploy”' } };
const empty = new URLSearchParams(location.search).has('empty');
function App() {
  const [open, setOpen] = useState(false);
  return h(FleetRunner, {
    lanes, steps: empty ? [] : [deploy, record], rows: [{ where: 'prod-us', text: 'deploy' }], open,
    status: failed, onClose: () => setOpen(false),
  }, (views) => h('div', null,
    h('div', { id: 'phase' }, 'phase:' + (views[0]?.phase ?? '')),
    h('button', { type: 'button', onClick: () => setOpen(true) }, 'Open deploy')));
}
createRoot(document.getElementById('root')).render(h(App));
`);
await bundle(runnerEntry, join(dir, 'runner.js'));
writeFileSync(join(dir, 'runner.html'), `<!doctype html><html><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__plan = { calls: [] };</script>
<script src="runner.js"></script></body></html>`);

/* ── Setup: everything up to date and Search off, so the plan has no steps ── */
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
  for (const empty of [false, true]) {
    const what = empty ? 'a plan with no steps' : 'a plan with steps';
    const page = await browser.newPage();
    page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
    await page.goto(`file://${join(dir, 'runner.html')}${empty ? '?empty=1' : ''}`);
    const open = page.getByRole('button', { name: 'Open deploy', exact: true });
    const retry = page.getByRole('button', { name: 'Retry prod-us', exact: true });
    const skip = page.getByRole('button', { name: 'Skip prod-us', exact: true });
    const phase = () => page.locator('#phase').innerText();
    await open.waitFor({ timeout: 15000 });
    ok(await retry.count() === 1 && await skip.count() === 1 && (await phase()) === 'phase:failed', `${what}: the previous run's failed lane shows Retry and Skip`);
    await open.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ timeout: 5000 });
    await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
    await page.waitForFunction(() => typeof globalThis.__plan.release === 'function', null, { timeout: 5000 });
    // runAll has not called onChange yet (and never does for an empty plan): the reset is confirm's own.
    await page.waitForTimeout(100);
    ok(await retry.count() === 0 && await skip.count() === 0, `${what}: Retry and Skip go as soon as Deploy is confirmed`);
    ok((await phase()) !== 'phase:failed', `${what}: the lane drops the previous run's phase (${await phase()})`);
    const calls = await page.evaluate(() => globalThis.__plan.calls);
    ok(calls.length === 1 && calls[0][0] === 'runAll' && calls[0][1] === (empty ? 0 : 2), `${what}: confirm runs the plan once (${JSON.stringify(calls)})`);
    await page.evaluate(() => globalThis.__plan.release());
    await page.waitForTimeout(100);
    ok(await retry.count() === 0, `${what}: no Retry after the run settles`);
    await page.close();
  }

  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'setup.html')}`);
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so force the click.
  const include = page.getByRole('row').filter({ has: page.getByText('prod-us', { exact: true }) }).getByRole('checkbox');
  await include.waitFor({ timeout: 15000 });
  await include.click({ force: true });
  const deploy = page.getByRole('button', { name: 'Deploy everything', exact: true });
  const body = () => page.locator('body').innerText();
  ok(await deploy.isEnabled(), 'Deploy everything is enabled while Search is in the deploy');
  ok(!(await body()).includes('Everything is up to date'), 'no up-to-date reason while the plan has steps');
  await page.getByRole('checkbox', { name: 'include Search in this deploy', exact: true }).uncheck();
  ok(/\bup to date\b/.test(await body()), 'prod-us is up to date');
  ok(await deploy.isDisabled(), 'Deploy everything is disabled when the plan has no steps');
  ok((await body()).includes('Everything is up to date'), 'the disabled button says Everything is up to date');
  await page.locator('[aria-label="Sources to watch on prod-us"]').getByText('Pick', { exact: true }).click();
  const sources = page.getByRole('dialog', { name: 'Sources on prod-us' });
  await sources.waitFor({ timeout: 15000 });
  await sources.getByRole('checkbox', { name: /^syslog:b ·/ }).click();
  await sources.getByRole('button', { name: 'Apply', exact: true }).click();
  await sources.waitFor({ state: 'detached' });
  await page.waitForFunction(() => !document.body.innerText.includes('Everything is up to date'), null, { timeout: 5000 });
  ok(await deploy.isEnabled(), 'a source change enables Deploy everything again');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-fleet-empty-run: ${fail} failure(s)` : 'test-fleet-empty-run: all passed');
process.exit(fail ? 1 : 0);
