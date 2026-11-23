// F8: pack sources on the Setup source list. Browser pass over the real Setup page.
// Run: node scripts/test-setup-pack-sources.mjs
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
const diff = (p) => execFileSync('git', ['diff', 'HEAD', '--', p], { cwd: root, encoding: 'utf8' });

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok(!/\buseEffect\b/.test(code), 'Setup.tsx has no effect');
ok((src.match(/^export /gm) ?? []).length === 1 && /export function Setup\(/.test(src), 'Setup.tsx exports only Setup');
ok(/listPackInputs\(/.test(code) && /listPackRoutes\(/.test(code), 'Setup reads pack inputs and routes');
ok(/packInputKey\(/.test(code) && /packReachInfo\(/.test(code) && /streamPackForward\(/.test(code), 'Setup classifies with packInputKey, packReachInfo, and streamPackForward');
ok(/PACK_ID/.test(code), 'cribl-pulse is skipped via PACK_ID');
const drawerSrc = readFileSync(join(root, 'src/components/SetupSourcesDrawer.tsx'), 'utf8');
const ui = `${src}\n${drawerSrc}`;
ok(ui.includes('stays in the pack') && ui.includes('in pack ') && ui.includes('reaches group routes'), 'yes and no tags are in the page');
ok(ui.includes('only the events its route ') && ui.includes('needs Stream 4.17+'), 'maybe warning and the version floor are in the page');
ok(src.includes('This source stays inside the pack. Pulse\'s route is on the worker group, so it only sees events the pack sends to the worker group routes.'), 'the stay sentence is the spike text');
ok(ui.includes('What the pack owner can change'), 'the pack-owner heading is shown');
ok(src.includes('Add a route with targetContext group (Send to Worker Group Routes), which needs Stream 4.17+, or move the source out of the pack.'), 'the pack-owner guidance is shown');
for (const banned of ['kvPut', 'commitGroup', 'deployGroup', "method: 'POST'", "method: 'PUT'", "method: 'PATCH'", "method: 'DELETE'"])
  ok(!code.includes(banned), `Setup.tsx does not call ${banned}`);
// deploy.ts is no longer listed: spec 033 F6 changes alertsPlan there (the pack/route code this page relies on is untouched).
for (const file of ['src/lib/routeFilter.ts', 'src/lib/api.ts'])
  ok(diff(file) === '', `${file} is unchanged`);
{
  // T6 adds the spec 016 child GETs for the pack lists. Anything else in policies.yml must stay as it is.
  const T6_CHILD_GETS = new Set([
    "  - { object: '/m/*/p/*/system/inputs/*', actions: ['GET'] }",
    "  - { object: '/m/*/p/*/routes/*', actions: ['GET'] }",
    "  - { object: '/m/default_search/search/jobs', actions: ['GET'] }", // spec 033 F10: measured cost line
  ]);
  const changes = diff('config/policies.yml').split('\n')
    .filter((l) => /^[+-](?![+-]{2})/.test(l))
    .map((l) => [l[0], l.slice(1)])
    .filter(([, body]) => !/^\s*#/.test(body) && body.trim() !== '');
  ok(changes.every(([sign, body]) => sign === '+' && T6_CHILD_GETS.has(body)),
    `config/policies.yml is unchanged apart from the pack child GETs${changes.length ? ` (${changes.map(([s, b]) => s + b.trim()).join('; ')})` : ''}`);
}

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-pack-'));
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
export function listPackInputs(g, pack) { bag().calls.push(['listPackInputs', g, pack]); return Promise.resolve((bag().packInputs[g] && bag().packInputs[g][pack]) || []); }
export function listPackRoutes(g, pack) { bag().calls.push(['listPackRoutes', g, pack]); return Promise.resolve((bag().packRoutes[g] && bag().packRoutes[g][pack]) || []); }
export function kvGet(k, d) { bag().calls.push(['kvGet', k]); return Promise.resolve(Object.prototype.hasOwnProperty.call(bag().kv, k) ? bag().kv[k] : d); }
export function api(path) { bag().calls.push(['GET', path]); return Promise.resolve(path === '/system/info' ? { items: [{ version: bag().version }] } : { items: [] }); }
export function kvPut() { bag().calls.push(['PUT', 'kv']); return Promise.resolve(); }
export function commitGroup() { bag().calls.push(['POST', 'commit']); return Promise.resolve(); }
export function deployGroup() { bag().calls.push(['PATCH', 'deploy']); return Promise.resolve(); }
`;
const STATE = `export function usePulse() { return globalThis.__PULSE; }`;
const SPY = `
import { fleetPlan as real } from ${JSON.stringify(join(root, 'src/lib/fleetPlan.ts'))};
export function fleetPlan(targets, settings, opts) {
  const result = real(targets, settings, opts);
  const snap = targets.map((t) => ({ group: t.group, mode: t.mode, inputs: [...(t.inputs || [])] }));
  globalThis.__FLEET = snap;
  (globalThis.__FLEET_LOG = globalThis.__FLEET_LOG || []).push(snap);
  globalThis.__FLEET_STEPS = (result.steps || []).map((s) => ({ id: s.id, detail: s.detail || '' }));
  return result;
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

const KEY = 'syslog:cc-paloalto.in_pan_syslog';
const PACK = 'cc-paloalto';
const DS = 'pulse_metrics_pq';
const DEST = 'pulse_lake_pq';
const pulsePack = [{ id: 'cribl-pulse', version: '1.3.0' }];
const bothPacks = [...pulsePack, { id: PACK }];
const pan = [{ id: 'in_pan_syslog', type: 'syslog' }];
const hidden = [{ id: 'hidden', type: 'syslog' }];
const yesRoutes = [{ id: 'to-group', filter: 'true', targetContext: 'group', output: '__group' }];
const noRoutes = [{ id: 'keep', filter: 'true', output: 'pan_out' }];
const maybeRoutes = [{ id: 'pan_fwd', filter: 'sourcetype==="pan"', targetContext: 'group', output: '__group' }];
const rec = (group, inputs) => ({ group, inputs, filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST });
const group = (id) => ({ id, workerCount: 2 });

function fixture(version) {
  const ids = ['stay', 'saved', 'early', 'blocked', 'reach', 'maybe', 'twin', 'plain', 'hold'];
  const routesOf = { stay: noRoutes, saved: yesRoutes, early: yesRoutes, blocked: noRoutes, reach: yesRoutes, maybe: maybeRoutes, twin: yesRoutes, hold: yesRoutes };
  const packInputs = {};
  const packRoutes = {};
  const packs = {};
  const inputs = {};
  for (const id of ids) {
    const has = id !== 'plain';
    packs[id] = has ? bothPacks : pulsePack;
    inputs[id] = [{ id: id === 'plain' ? 'b' : 'a', type: 'syslog' }];
    packInputs[id] = { [PACK]: pan, 'cribl-pulse': hidden };
    packRoutes[id] = { [PACK]: routesOf[id] || [], 'cribl-pulse': yesRoutes };
  }
  return {
    calls: [], version, groups: ids.map(group), packs, inputs, packInputs, packRoutes,
    kv: {
      'deployments/saved': rec('saved', [KEY]),
      'deployments/early': rec('early', [KEY]),
      'deployments/blocked': rec('blocked', [KEY]),
      'deployments/reach': rec('reach', ['syslog:a']),
      'deployments/hold': rec('hold', ['syslog:a']),
      'deployments/maybe': rec('maybe', [KEY]),
    },
  };
}

const pulse = {
  settings: {
    dataset: DS, destination: DEST, routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
};

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });

function html(version) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture(version))}; globalThis.__PULSE = ${JSON.stringify(pulse)};</script>
<script src="app.js"></script></body></html>`;
}

async function openPage(page, version) {
  const name = version.startsWith('4.16') ? 'old.html' : 'index.html';
  writeFileSync(join(dir, name), html(version));
  await page.goto(`file://${join(dir, name)}`);
  await page.getByRole('row').filter({ has: page.getByText('stay', { exact: true }) }).first().waitFor({ timeout: 15000 });
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const srcBox = (scope, key) => scope.getByRole('checkbox', { name: new RegExp(`^${esc(key)} ·`) });
async function openSources(page, id) {
  await page.locator(`[aria-label="Sources to watch on ${id}"]`).getByText('Pick', { exact: true }).click();
  const d = page.getByRole('dialog', { name: `Sources on ${id}` });
  await d.waitFor({ timeout: 15000 });
  return d;
}

const calls = (page) => page.evaluate(() => globalThis.__API.calls.map((c) => c.slice()));
const packGets = (list, group) => list.filter((c) => (c[0] === 'listPackInputs' || c[0] === 'listPackRoutes') && (!group || c[1] === group));

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openPage(page, '4.17.2');
  const text = () => page.locator('body').innerText();
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so clicks are forced.
  const inc = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) }).getByRole('checkbox');
  let seen = await calls(page);
  ok(packGets(seen).length === 0, `first paint does not read pack inputs or routes (${packGets(seen).map((c) => c.join(' ')).join(',')})`);
  const info = seen.filter((c) => c[0] === 'GET' && c[1] === '/system/info');
  ok(info.length === 1, `one GET /system/info (${info.length})`);
  ok(!seen.some((c) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c[0])), 'opening the page does not POST, PUT, PATCH, or DELETE');

  await inc('hold').click({ force: true });
  seen = await calls(page);
  ok(packGets(seen, 'hold').length === 0, 'including a group whose record is only group sources does not read its packs');

  await inc('early').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'early' && t.inputs.includes(key)), KEY);
  seen = await calls(page);
  ok(seen.some((c) => c[0] === 'listPackInputs' && c[1] === 'early' && c[2] === PACK), 'including a record that names a pack source reads that pack first');
  ok(!seen.some((c) => c[2] === 'cribl-pulse'), 'cribl-pulse is not a pack that contributes sources');
  ok(packGets(seen, 'stay').length === 0 && packGets(seen, 'twin').length === 0, 'collapsed groups are not read just because another group was included');
  const earlyFinal = await page.evaluate((key) => (globalThis.__FLEET || []).find((t) => t.group === 'early')?.inputs?.includes(key), KEY);
  ok(earlyFinal, 'a tickable pack id from the record is what fleetPlan receives before the row is opened');

  const earlyDlg = await openSources(page, 'early');
  const earlyBox = srcBox(earlyDlg, KEY);
  await earlyBox.waitFor();
  ok(await earlyBox.isChecked() && !(await earlyBox.isDisabled()), 'opening the group leaves the record\'s tickable pack source ticked');
  ok((await text()).includes(`in pack ${PACK} \u00b7 reaches group routes`), 'a forwarded true filter shows in pack · reaches group routes');

  await inc('blocked').click({ force: true });
  await page.waitForFunction(() => (globalThis.__FLEET || []).some((t) => t.group === 'blocked'));
  const blockedLeak = await page.evaluate((key) => (globalThis.__FLEET_LOG || []).some((ts) => ts.some((t) => t.group === 'blocked' && t.inputs.includes(key))), KEY);
  ok(!blockedLeak, 'a not-tickable id from a previous record is never included in the group inputs');

  const stayDlg = await openSources(page, 'stay');
  const stayBox = srcBox(stayDlg, KEY);
  await stayBox.waitFor();
  ok(!(await stayBox.isChecked()) && await stayBox.isDisabled(), 'a final route to the pack destination is visible and not tickable');
  const stayText = await text();
  ok(stayText.includes('stays in the pack'), 'the source shows stays in the pack');
  ok(stayText.includes('This source stays inside the pack. Pulse\'s route is on the worker group, so it only sees events the pack sends to the worker group routes.'), 'the stay sentence is on the page');
  ok(stayText.includes('What the pack owner can change'), 'What the pack owner can change is on the page');
  ok(stayText.includes('Add a route with targetContext group (Send to Worker Group Routes), which needs Stream 4.17+, or move the source out of the pack.'), 'the owner guidance is on the page');
  seen = await calls(page);
  ok(seen.some((c) => c[0] === 'listPackInputs' && c[1] === 'stay' && c[2] === PACK), 'opening a group reads its pack inputs');
  ok(seen.some((c) => c[0] === 'listPackRoutes' && c[1] === 'stay' && c[2] === PACK), 'opening a group reads its pack routes');
  ok(!seen.some((c) => c[2] === 'cribl-pulse'), 'opening a group still does not read cribl-pulse');

  const savedDlg = await openSources(page, 'saved');
  const savedBox = srcBox(savedDlg, KEY);
  await savedBox.waitFor();
  ok(await savedBox.isChecked(), 'a saved tickable pack source stays checked after its routes load');
  await inc('saved').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'saved' && t.inputs.includes(key)), KEY);

  const reachDlg = await openSources(page, 'reach');
  const reachBox = srcBox(reachDlg, KEY);
  await reachBox.waitFor();
  ok(!(await reachBox.isChecked()) && !(await reachBox.isDisabled()), 'the same source with targetContext group is tickable');
  await reachBox.check();
  await reachDlg.getByRole('button', { name: 'Apply', exact: true }).click();
  await reachDlg.waitFor({ state: 'detached' });
  await inc('reach').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET_STEPS || []).some((s) => s.id === 'reach/route' && s.detail.includes(key)), KEY);
  ok(true, 'a ticked pack key is in the route filter fleetPlan builds');

  const maybeDlg = await openSources(page, 'maybe');
  const maybeBox = srcBox(maybeDlg, KEY);
  await maybeBox.waitFor();
  ok(!(await maybeBox.isDisabled()), 'a sourcetype filter forwarded to the group is tickable');
  ok((await text()).includes('only the events its route pan_fwd sends on'), 'the warning names the route id');
  await maybeBox.check();
  await inc('maybe').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'maybe' && t.inputs.includes(key)), KEY);

  const beforeCopy = await calls(page);
  ok(packGets(beforeCopy, 'twin').length === 0, 'the copy target\'s packs are not read before Copy sources');
  const reachAgain = await openSources(page, 'reach');
  await reachAgain.getByRole('checkbox', { name: 'Copy to twin', exact: true }).check();
  await reachAgain.getByRole('checkbox', { name: 'Copy to plain', exact: true }).check();
  await reachAgain.getByRole('button', { name: 'Copy these sources to…', exact: true }).click();
  await page.getByText('Dropped 2').waitFor();
  const afterCopy = await calls(page);
  ok(afterCopy.some((c) => c[0] === 'listPackInputs' && c[1] === 'twin' && c[2] === PACK), 'copy fetches the target pack list before comparing');
  const twinDlg = await openSources(page, 'twin');
  ok(await srcBox(twinDlg, KEY).isChecked(), 'a pack key the target has, and that is tickable there, is not dropped');
  ok(await srcBox(twinDlg, 'syslog:a').isChecked(), 'the target keeps the group source it lists');
  const plainDlg = await openSources(page, 'plain');
  ok(await srcBox(plainDlg, KEY).count() === 0, 'a pack key the target does not have is dropped');

  seen = await calls(page);
  ok(seen.filter((c) => c[0] === 'GET' && c[1] === '/system/info').length === 1, 'the page still requested /system/info once');
  ok(!seen.some((c) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c[0])), 'the session still has no write calls');
  ok(!errors.length, `no page errors (${errors.join(' | ')})`);

  await openPage(page, '4.16.0');
  const oldDlg = await openSources(page, 'maybe');
  const oldBox = srcBox(oldDlg, KEY);
  await oldBox.waitFor();
  ok(await oldBox.isDisabled() && !(await oldBox.isChecked()), 'below Stream 4.17 the same source is not tickable');
  const oldText = await text();
  ok(oldText.includes('needs Stream 4.17+'), 'the text says needs Stream 4.17+');
  ok(!oldText.includes('only the events its route pan_fwd sends on'), 'the version floor replaces the maybe warning');
  ok(!oldText.includes('reaches group routes'), 'the version floor does not mark the source as reaching the group');
  await inc('maybe').click({ force: true });
  await page.waitForFunction(() => (globalThis.__API.calls || []).some((c) => c[0] === 'listPackInputs' && c[1] === 'maybe'));
  await page.waitForFunction(() => (globalThis.__FLEET || []).some((t) => t.group === 'maybe'));
  const oldLeak = await page.evaluate((key) => (globalThis.__FLEET_LOG || []).some((ts) => ts.some((t) => t.group === 'maybe' && t.inputs.includes(key))), KEY);
  ok(!oldLeak, 'below 4.17 the pack id is omitted from fleetPlan even if the record had it');
  const oldCalls = await calls(page);
  ok(!oldCalls.some((c) => c[2] === 'cribl-pulse'), 'cribl-pulse is still not read on 4.16');
  ok(!oldCalls.some((c) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c[0])), 'the 4.16 page does not write');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
  try {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) console.log((await page.locator('body').innerText()).slice(0, 2500));
  } catch { /* already closed */ }
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-setup-pack-sources: ${fail} failure(s)` : 'test-setup-pack-sources: all passed');
process.exit(fail ? 1 : 0);
