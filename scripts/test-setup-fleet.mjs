// F7: Setup fleet table. Source constraints, then a browser pass over the real Setup component
// (Capra Table, Checkbox, RadioGroup, TextField) with the API and pulse state faked.
// Run: node scripts/test-setup-fleet.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const diff = (p) => execFileSync('git', ['diff', 'HEAD', '--', p], { cwd: root, encoding: 'utf8' });

for (const bad of ['kvPut', 'commitGroup', 'deployGroup', 'loadRollupContext', 'runSearch'])
  ok(!code.includes(bad), `Setup.tsx does not call ${bad}`);
ok(/fleetPlan\(/.test(code), 'Setup.tsx calls fleetPlan');
ok(!/\buseEffect\b/.test(code), 'Setup.tsx has no effect');
ok(/useChanged\(/.test(code), 'selection reset uses useChanged during render');
ok(/density="compact"/.test(src) && /appearance="flat"/.test(src), 'Table is compact and flat');
ok(/One plan for the whole fleet/.test(src) && /Deploy everything/.test(src), 'subtitle and Deploy everything stay');
ok((src.match(/^export /gm) ?? []).length === 1 && /export function Setup\(/.test(src), 'Setup.tsx exports only Setup');
ok(/More actions for/.test(src) && /Dataset and full re-deploy/.test(src), 'Setup row menu opens per-group dataset and re-deploy');
ok(diff('src/lib/api.ts') === '', 'api.ts (listGroups) is unchanged');
ok(diff('public/cribl-pulse.crbl') === '', 'pack archive is unchanged');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available for the fleet table');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-'));
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
export function commitGroup() { bag().calls.push(['commitGroup']); return Promise.resolve(); }
export function deployGroup() { bag().calls.push(['deployGroup']); return Promise.resolve(); }
export function runSearch() { bag().calls.push(['runSearch']); return Promise.resolve([]); }
export async function loadRollupContext() { bag().calls.push(['loadRollupContext']); }
export function listPackInputs() { bag().calls.push(['listPackInputs']); return Promise.resolve([]); }
export function listPackRoutes() { bag().calls.push(['listPackRoutes']); return Promise.resolve([]); }
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
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
        loader: 'js', resolveDir: root, contents: args.path === 'api' ? API : STATE,
      }));
    },
  }],
});

const DS = 'pulse_metrics_pq';
const DEST = 'pulse_lake_pq';
const rec = (group, inputs) => ({ group, inputs, filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST });
const fixture = {
  calls: [],
  groups: [
    { id: 'prod-us', workerCount: 4 },
    { id: 'fresh', workerCount: 2 },
    { id: 'empty', workerCount: 0 },
    { id: 'other', workerCount: 3 },
    { id: 'allg', workerCount: 1 },
  ],
  packs: {
    'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }],
    fresh: [],
    empty: [],
    other: [{ id: 'cribl-pulse', version: '1.2.0' }],
    allg: [{ id: 'cribl-pulse', version: '1.3.0' }],
  },
  inputs: {
    'prod-us': [{ id: 'a', type: 'syslog' }, { id: 'b', type: 'tcp' }],
    fresh: [{ id: 'a', type: 'syslog' }],
    empty: [{ id: 'z', type: 'syslog' }],
    other: [{ id: 'a', type: 'syslog' }],
    allg: [{ id: 'a', type: 'syslog' }],
  },
  kv: { 'deployments/prod-us': rec('prod-us', ['syslog:a']), 'deployments/allg': rec('allg', []) },
};
const pulse = {
  settings: {
    dataset: DS, destination: DEST, routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [
    { group: 'prod-us', input: 'syslog:a', events_1h: 3600 * 1000 },
    { group: 'prod-us', input: 'syslog:a:tcp', events_1h: 3600 * 500 },
    { group: 'prod-us', input: 'syslog:ab', events_1h: 3600 * 99999 },
    { group: 'prod-us', input: 'tcp:b', events_1h: 3600 * 10 },
  ],
};
const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__PULSE = ${JSON.stringify(pulse)};</script>
<script src="app.js"></script></body></html>`;
writeFileSync(join(dir, 'index.html'), html);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  const rowOf = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) });
  await rowOf('prod-us').first().waitFor({ timeout: 15000 });
  const text = async () => page.locator('body').innerText();
  const body = await text();
  ok(body.includes(DS), `shows the dataset (${DS})`);
  ok(body.includes('1.3.0') && body.includes('1.2.0') && body.includes('not installed'), 'Pulse version or not installed');
  ok(body.includes('Workers') && body.includes('All') && body.includes('Pick'), 'workers and All/Pick are on the page');
  // Include is the Table's row selection (spec 039): the row's selection checkbox.
  const rowBox = (id) => rowOf(id).getByRole('checkbox');
  const openSources = async (id) => {
    await page.locator(`[aria-label="Sources to watch on ${id}"]`).getByText('Pick', { exact: true }).click();
    const d = page.getByRole('dialog', { name: `Sources on ${id}` });
    await d.waitFor({ timeout: 15000 });
    return d;
  };
  const srcBox = (scope, key) => scope.getByRole('checkbox', { name: new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ·`) });
  const tick = (id) => rowBox(id).click({ force: true }); // the cell covers the visually hidden input
  const emptyBox = rowBox('empty');
  ok(await emptyBox.isDisabled(), 'a group with no workers has a disabled checkbox');
  ok((await text()).includes('no workers'), 'the disabled row says it has no workers');

  const calls = await page.evaluate(() => globalThis.__API.calls.map((c) => c[0]));
  const kinds = new Set(calls);
  ok(kinds.has('listGroups') && kinds.has('listPacks') && kinds.has('listInputs') && kinds.has('kvGet'), `open reads groups, packs, inputs, deployments (${[...kinds].join(',')})`);
  for (const banned of ['kvPut', 'commitGroup', 'deployGroup', 'loadRollupContext', 'runSearch'])
    ok(!kinds.has(banned), `open does not ${banned}`);
  const kvKeys = await page.evaluate(() => globalThis.__API.calls.filter((c) => c[0] === 'kvGet').map((c) => c[1]));
  ok(kvKeys.every((k) => k.startsWith('deployments/')), `kv reads are deployment records (${kvKeys.join(',')})`);

  const deploy = page.getByRole('button', { name: 'Deploy everything', exact: true });
  ok(await deploy.isEnabled(), 'Deploy everything is enabled when Search is in the deploy and no group is ticked');
  ok((await text()).includes('\u2014'), 'an unticked group shows an em dash');

  // A row's All / Pick is a ToggleButtonGroup (spec 039): the selected button's text.
  const rowMode = async (id) => (await page.locator(`[aria-label="Sources to watch on ${id}"]`).locator('[aria-checked="true"], [aria-pressed="true"]').innerText()).trim();
  const chooseNewGroups = async (label) => {
    await page.getByRole('button', { name: /^New groups: / }).click();
    await page.getByRole('menuitem', { name: label, exact: true }).click();
  };
  ok(await page.getByRole('button', { name: 'New groups: All', exact: true }).count() === 1, 'New groups defaults to All');
  ok(await rowMode('prod-us') === 'Pick', 'a recorded group starts on Pick (defaultSourceMode)');
  ok(await rowMode('fresh') === 'All', 'a group with no record starts on All');
  ok(await rowMode('allg') === 'All', 'a record with no inputs starts on All');

  const prod = await openSources('prod-us');
  const a = srcBox(prod, 'syslog:a');
  const b = srcBox(prod, 'tcp:b');
  ok(await a.isChecked() && !(await b.isChecked()), 'the recorded inputs start ticked and the others do not');
  ok(await srcBox(prod, 'syslog:z').count() === 0, 'sources for the open group only');

  await tick('prod-us');
  let now = await text();
  ok(now.includes('up to date'), 'an unchanged group shows up to date');
  ok(now.includes('1.5k ev/s'), `volume is events_1h / 3600 for the ticked key (got ${(now.match(/[\d.,]+k ev\/s|\d+ ev\/s/g) || []).join(' ')})`);
  ok(now.includes('< 0.01 core'), 'CPU is ev/s times CPU_PER_EVS, formatted');
  ok(!now.includes('99999'), 'a neighbouring input id is not counted');
  ok(!(await deploy.isDisabled()), 'Deploy everything enables when a valid group is selected');

  await tick('fresh');
  now = await text();
  ok(!now.includes('pick at least one source'), 'a ticked All group does not ask to pick sources');
  ok(now.includes('All sources (1)'), 'a ticked fresh group shows All sources (1)');
  ok(!(await deploy.isDisabled()), 'Deploy everything stays enabled when fresh is ticked on All');

  await tick('fresh');
  now = await text();
  ok(now.includes('not in this deploy'), 'unticking fresh shows not in this deploy');
  ok(!(await deploy.isDisabled()), 'Deploy everything stays enabled after unticking fresh');

  await chooseNewGroups('Pick');
  ok(await rowMode('fresh') === 'Pick' && (await rowMode('prod-us')) === 'Pick' && (await rowMode('allg')) === 'All', 'Pick menu moves only groups with no record to Pick');
  await chooseNewGroups('All');
  ok(await rowMode('fresh') === 'All' && (await rowMode('prod-us')) === 'Pick' && (await rowMode('allg')) === 'All', 'All menu moves only groups with no record to All');

  await b.check();
  await prod.getByRole('checkbox', { name: 'Copy to other', exact: true }).check();
  await prod.getByRole('button', { name: 'Copy these sources to…', exact: true }).click();
  await page.getByText('Dropped 1').waitFor();
  ok((await text()).includes('Dropped 1'), 'copy drops source ids the target does not list and says how many');
  const other = await openSources('other');
  ok(await srcBox(other, 'syslog:a').isChecked(), 'the target keeps the source id it lists');
  ok(await srcBox(other, 'tcp:b').count() === 0, 'the dropped id is not on the target');

  await page.getByLabel('Filter groups').fill('EMPTY');
  ok(await rowOf('empty').count() === 1, 'the filter keeps a group whose id matches');
  ok(await rowOf('prod-us').count() === 0, 'the filter hides other groups');
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

console.log(fail ? `test-setup-fleet: ${fail} failure(s)` : 'test-setup-fleet: all passed');
process.exit(fail ? 1 : 0);
