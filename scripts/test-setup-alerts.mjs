// F9: Cribl Search alerts row on Setup. Source checks plus browser pass with a fleetPlan spy.
// Run: node scripts/test-setup-alerts.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const setupSrc = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
const alertsSrc = readFileSync(join(root, 'src/components/SetupAlerts.tsx'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const setupCode = strip(setupSrc);

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok((alertsSrc.match(/^export /gm) ?? []).length === 1 && /export function SetupAlerts\(/.test(alertsSrc), 'SetupAlerts.tsx exports only SetupAlerts');
ok(/include Search in this deploy/.test(alertsSrc) && /Schedules enabled/.test(alertsSrc), 'checkbox and switch labels are in SetupAlerts');
ok(/to="\/settings\/alerts"/.test(alertsSrc), 'link target is /settings/alerts');
ok(/Switch/.test(alertsSrc) && /Checkbox/.test(alertsSrc), 'SetupAlerts uses Capra Checkbox and Switch');
ok((setupSrc.match(/^export /gm) ?? []).length === 1 && /export function Setup\(/.test(setupSrc), 'Setup.tsx still exports only Setup');
ok(/SetupAlerts/.test(setupSrc) && /hostOrigin\(/.test(setupCode), 'Setup wires SetupAlerts and hostOrigin for fleetPlan');
ok(/alerts:\s*alertsOn/.test(setupCode) && /enabled:\s*schedulesOn/.test(setupCode), 'fleetPlan gets alerts and enabled from state');
ok(/CRIBL_BASE_PATH/.test(setupCode), 'fleetPlan passes window.CRIBL_BASE_PATH in link');
for (const banned of ['loadRollupContext', 'savedStatus', 'alertsStatus'])
  ok(!setupCode.includes(banned), `Setup.tsx does not call ${banned}`);
ok(!/up to date/.test(alertsSrc), 'the alerts block does not label up to date');
ok(/!alertsOn && targets\.length === 0/.test(setupCode), 'Deploy stays disabled only with alerts off and no groups');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-alerts-'));
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
export function listPackInputs() { return Promise.resolve([]); }
export function listPackRoutes() { return Promise.resolve([]); }
export function api(path) { bag().calls.push(['api', path]); return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
`;
const STATE = `export function usePulse() { return globalThis.__PULSE; }`;
const SPY = `
import { fleetPlan as real } from ${JSON.stringify(join(root, 'src/lib/fleetPlan.ts'))};
export function fleetPlan(targets, settings, opts) {
  globalThis.__OPTS = opts;
  (globalThis.__LANES = real(targets, settings, opts).lanes.map((l) => l.id));
  return real(targets, settings, opts);
}
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
      b.onResolve({ filter: /\/fleetPlan$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'fleetPlan', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => ({
        loader: 'js', resolveDir: root, contents: args.path === 'api' ? API : args.path === 'state' ? STATE : SPY,
      }));
    },
  }],
});

const LEARN = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const DS = 'pulse_metrics_pq';
const pulse = {
  settings: {
    dataset: DS, destination: 'pulse_lake_pq', routeFilter: 'true', learning: LEARN, rollup: 'off',
    notify: { targets: ['slack_noc'], email: 'ops@acme.io', routes: [] }, refresh: '5m',
  },
  fleet: [],
};
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 2 }, { id: 'bad-pick', workerCount: 1 }],
  packs: { 'prod-us': [{ id: 'cribl-pulse', version: '1.3.0' }], 'bad-pick': [] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }], 'bad-pick': [{ id: 'a', type: 'syslog' }] },
  kv: { 'deployments/prod-us': { group: 'prod-us', inputs: ['syslog:a'], filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: 'pulse_lake_pq' } },
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__PULSE = ${JSON.stringify(pulse)};</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  await page.getByText('Cribl Search alerts').waitFor({ timeout: 15000 });

  const searchBox = page.getByRole('checkbox', { name: 'include Search in this deploy', exact: true });
  ok(await searchBox.isChecked(), 'Search checkbox starts checked');
  const sw = page.getByRole('switch', { name: 'Schedules enabled', exact: true });
  ok(await sw.isChecked(), 'Schedules switch starts on');
  ok((await page.getByRole('link', { name: 'change in Alerts' }).getAttribute('href')) === '/settings/alerts', 'alerts settings link');

  const body = await page.locator('body').innerText();
  ok(body.includes(DS) && body.includes('ops@acme.io') && body.includes('slack_noc'), 'dataset and notify targets are read-only on the block');

  const deploy = page.getByRole('button', { name: 'Deploy everything', exact: true });
  ok(await deploy.isEnabled(), 'Deploy everything is enabled with Search on and no groups ticked');

  let opts = await page.evaluate(() => globalThis.__OPTS);
  let lanes = await page.evaluate(() => globalThis.__LANES);
  ok(opts?.alerts === true && opts?.enabled === true, 'fleetPlan starts with alerts true and schedules on');
  ok(lanes?.includes('search'), 'search lane is present when alerts are on');
  ok(opts?.link?.base === '/app-ui/pulse', 'fleetPlan passes CRIBL_BASE_PATH in link');

  await sw.uncheck();
  opts = await page.evaluate(() => globalThis.__OPTS);
  ok(opts?.enabled === false, 'fleetPlan enabled follows the schedules switch');
  await sw.check();

  await searchBox.uncheck();
  lanes = await page.evaluate(() => globalThis.__LANES);
  opts = await page.evaluate(() => globalThis.__OPTS);
  ok(opts?.alerts === false, 'fleetPlan alerts is false when the checkbox is off');
  ok(!lanes?.includes('search'), 'no search lane when alerts are off');
  ok(await deploy.isDisabled(), 'Deploy is disabled with alerts off and no groups');

  await searchBox.check();
  ok(await deploy.isEnabled(), 'Deploy is enabled again when Search is back on');

  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so force the click.
  await page.getByRole('button', { name: 'New groups: All', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Pick', exact: true }).click();
  await page.getByRole('row').filter({ has: page.getByText('bad-pick', { exact: true }) }).getByRole('checkbox').click({ force: true });
  ok(await deploy.isDisabled(), 'an invalid ticked group disables Deploy everything');
  ok((await page.locator('body').innerText()).includes('bad-pick') && (await page.locator('body').innerText()).includes('pick at least one source'), 'invalid group is named');

  const calls = await page.evaluate(() => globalThis.__API.calls.map((c) => c[0]));
  ok(!calls.includes('loadRollupContext') && !calls.includes('runSearch'), 'open does not run search jobs');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-alerts: ${fail} failure(s)` : 'test-setup-alerts: all passed');
process.exit(fail ? 1 : 0);