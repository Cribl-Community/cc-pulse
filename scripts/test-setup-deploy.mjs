// F10: Deploy everything opens one FleetRunner modal, then shows each lane's phase.
// Cancel writes nothing. Confirm calls runAll. Retry and Skip call that lane only.
// Run: node scripts/test-setup-deploy.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const setupSrc = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
const setupCode = setupSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const alertsSrc = readFileSync(join(root, 'src/components/SetupAlerts.tsx'), 'utf8');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const diff = (p) => execFileSync('git', ['diff', 'HEAD', '--', p], { cwd: root, encoding: 'utf8' });

ok((setupSrc.match(/^export /gm) ?? []).length === 1 && /export function Setup\(/.test(setupSrc), 'Setup.tsx exports only Setup');
ok(/FleetRunner/.test(setupSrc) && /confirmRows\(plan\.lanes, targets, settings\.destination\)/.test(setupCode), 'rows are confirmRows of the fleet plan');
ok(/steps=\{plan\.steps\}/.test(setupSrc), 'confirm runs the fleet plan steps');
ok(/onClick=\{\(\) => setAsk\(true\)\}/.test(setupCode), 'Deploy everything only opens the modal');
ok(!/runAll|retryLane|skipLane/.test(setupCode), 'Setup does not call plan functions itself');
ok(/onClose=\{\(\) => setAsk\(false\)\}/.test(setupCode) && /onDone=\{\(\) => \{ void refresh\(\); \}\}/.test(setupCode), 'cancel does not refresh; a settled run does');
ok(!/\buseEffect\b/.test(setupCode), 'Setup.tsx has no effect');
ok(/phase=\{phase\('search'\)\}/.test(setupSrc) && /setup-alerts-title/.test(alertsSrc) && /\{phase \? <Text>\{`\s*\$\{phase\}`\}/.test(alertsSrc), 'the Search block shows the lane phase');
const deploySrc = readFileSync(join(root, 'src/pages/Deploy.tsx'), 'utf8');
ok(/PlanRunner/.test(deploySrc) && /Lake dataset \(heartbeat metrics\)/.test(deploySrc), 'Deploy still renders PlanRunner and the Lake dataset field');
ok(diff('src/components/PlanRunner.tsx') === '', 'PlanRunner is unchanged');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) process.exit(fail ? 1 : 0);

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-deploy-'));
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
export function listPackInputs() { return Promise.resolve([]); }
export function listPackRoutes() { return Promise.resolve([]); }
export function api(path) { bag().calls.push(['api', path]); return Promise.resolve({ items: [{ version: '4.19.0' }] }); }
`;
const STATE = `
export function usePulse() {
  return { ...globalThis.__PULSE, refresh() { globalThis.__REFRESH += 1; return Promise.resolve(); } };
}
`;
const PLAN = `
const bag = () => globalThis.__plan;
function laneOf(id) { return id.split('/')[0]; }
export async function runAll(steps, seed, onChange) {
  bag().calls.push({ fn: 'runAll', ids: steps.map((s) => s.id) });
  const failed = steps.map((s) => laneOf(s.id)).find((id) => id !== 'shared' && id !== 'search');
  const state = { ...seed };
  const put = (id, v) => { state[id] = v; onChange({ ...state }); };
  for (const st of steps) put(st.id, { s: laneOf(st.id) === failed ? 'failed' : 'done' });
  return { failed: [failed], state };
}
export async function retryLane(steps, state, lane, onChange) {
  bag().calls.push({ fn: 'retryLane', lane, ids: steps.map((s) => s.id) });
  return { failed: [], state };
}
export function skipLane(steps, state, lane, onChange) {
  bag().calls.push({ fn: 'skipLane', lane, ids: steps.map((s) => s.id) });
  return state;
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
const rec = (group) => ({ group, inputs: ['syslog:a'], filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST });
const fixture = {
  calls: [],
  groups: [{ id: 'prod-us', workerCount: 2 }, { id: 'dmz', workerCount: 2 }],
  packs: { 'prod-us': [], dmz: [] },
  inputs: { 'prod-us': [{ id: 'a', type: 'syslog' }], dmz: [{ id: 'a', type: 'syslog' }] },
  kv: { 'deployments/prod-us': rec('prod-us'), 'deployments/dmz': rec('dmz') },
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
globalThis.__plan = { calls: [] };
globalThis.__REFRESH = 0;
globalThis.__WRITES = [];
const orig = window.fetch.bind(window);
window.fetch = (input, init) => {
  const method = (init && init.method) || 'GET';
  if (String(method).toUpperCase() !== 'GET') globalThis.__WRITES.push(String(method).toUpperCase() + ' ' + input);
  return orig(input, init);
};
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
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so force the click.
  const row = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) });
  const tick = (id) => row(id).getByRole('checkbox').click({ force: true });
  await row('prod-us').getByRole('checkbox').waitFor({ timeout: 15000 });
  await tick('prod-us');
  await tick('dmz');
  const deploy = page.getByRole('button', { name: 'Deploy everything', exact: true });
  ok(await deploy.isEnabled(), 'Deploy everything is enabled for two valid groups and Search');

  await deploy.click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 5000 });
  const openText = await dialog.innerText();
  ok(openText.includes('prod-us') && openText.includes('dmz'), `modal names both ticked groups (${openText.slice(0, 240)})`);
  ok(openText.includes('Cribl Search'), 'modal names Cribl Search when alerts are on');
  ok(openText.includes('Overwrites are not undone automatically'), 'modal warns that overwrites are not undone automatically');
  const calls = () => page.evaluate(() => globalThis.__plan.calls.map((c) => c.fn));
  ok((await calls()).length === 0, 'opening the modal does not call runAll');

  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  ok((await calls()).length === 0, 'Cancel does not call runAll, retryLane, or skipLane');
  ok(await page.evaluate(() => globalThis.__REFRESH) === 0, 'Cancel does not call refresh');
  ok((await page.evaluate(() => globalThis.__WRITES)).length === 0, 'Cancel performs no POST, PUT, PATCH, or DELETE');
  const apiFns = await page.evaluate(() => globalThis.__API.calls.map((c) => c[0]));
  for (const banned of ['kvPut', 'commitGroup', 'deployGroup', 'runSearch'])
    ok(!apiFns.includes(banned), `Cancel does not call ${banned}`);

  await page.getByRole('checkbox', { name: 'include Search in this deploy', exact: true }).uncheck();
  await deploy.click();
  await dialog.waitFor({ timeout: 5000 });
  const noSearch = await dialog.innerText();
  ok(noSearch.includes('prod-us') && noSearch.includes('dmz') && !noSearch.includes('Cribl Search'), 'alerts off drops the Cribl Search row');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('checkbox', { name: 'include Search in this deploy', exact: true }).check();

  await deploy.click();
  await dialog.waitFor();
  await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.getByRole('button', { name: 'Retry prod-us', exact: true }).waitFor({ timeout: 5000 });
  const ran = await page.evaluate(() => globalThis.__plan.calls.filter((c) => c.fn === 'runAll'));
  ok(ran.length === 1, 'Confirm calls runAll once');
  const ids = ran[0]?.ids ?? [];
  const at = (prefix) => ids.findIndex((id) => id.startsWith(prefix));
  ok(at('prod-us/') >= 0 && at('dmz/') > at('prod-us/') && at('search/') > at('dmz/'), `fleet steps run in lane order (${ids.join(',')})`);
  ok(await page.evaluate(() => globalThis.__REFRESH) === 1, 'refresh() runs when runAll settles');
  ok((await page.evaluate(() => globalThis.__WRITES)).length === 0, 'the confirmed run is the plan, not a write outside it');

  const body = await page.locator('body').innerText();
  const prod = await row('prod-us').innerText();
  const dmz = await row('dmz').innerText();
  const search = slice(body, 'Cribl Search alerts', 'Deploy everything');
  ok(prod.includes('failed') && !/\bdone\b/.test(prod), `prod-us cell stays failed (${prod.replace(/\n/g, ' | ')})`);
  ok(/\bdone\b/.test(dmz) && !dmz.includes('failed'), `dmz cell reaches done while prod-us is failed (${dmz.replace(/\n/g, ' | ')})`);
  ok(/\bdone\b/.test(search) && !search.includes('failed'), 'the Search block shows done');
  ok(await page.getByRole('button', { name: 'Skip prod-us', exact: true }).count() === 1, 'failed prod-us shows Skip prod-us');
  ok(await page.getByRole('button', { name: 'Retry dmz', exact: true }).count() === 0, 'a done group has no Retry button');
  ok(await page.getByRole('button', { name: 'Retry search', exact: true }).count() === 0, 'a done search lane has no Retry search');

  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  await deploy.click();
  await dialog.waitFor({ timeout: 5000 });
  const again = await dialog.innerText();
  ok(again.includes('prod-us') && again.includes('dmz'), 'Deploy everything opens the modal again after a confirmed run');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await dialog.waitFor({ state: 'hidden', timeout: 5000 });
  ok((await calls()).filter((fn) => fn === 'runAll').length === 1, 'canceling the second confirm does not run the plan again');
  ok(await page.getByRole('button', { name: 'Retry prod-us', exact: true }).count() === 1, 'the failed lane stays retryable after the second confirm is canceled');

  await page.getByRole('button', { name: 'Retry prod-us', exact: true }).click();
  const retried = await page.evaluate(() => globalThis.__plan.calls.filter((c) => c.fn === 'retryLane'));
  ok(retried.length === 1 && retried[0].lane === 'prod-us', 'Retry prod-us calls retryLane for prod-us only');
  ok(await page.evaluate(() => globalThis.__REFRESH) === 2, 'refresh() runs when retryLane settles');

  await page.getByRole('button', { name: 'Skip prod-us', exact: true }).click();
  const skipped = await page.evaluate(() => globalThis.__plan.calls.filter((c) => c.fn === 'skipLane'));
  ok(skipped.length === 1 && skipped[0].lane === 'prod-us', 'Skip prod-us calls skipLane for prod-us only');
  ok((await calls()).filter((fn) => fn === 'runAll').length === 1, 'Retry and Skip do not call runAll again');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-deploy: ${fail} failure(s)` : 'test-setup-deploy: all passed');
process.exit(fail ? 1 : 0);
