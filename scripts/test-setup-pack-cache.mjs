// R5: pack-source reads must not live for the whole SPA.
// A failed read used to resolve to [] and stay in a module Map, and that promise
// closed over the first pack ids. Leaving Settings remounts Setup, but filterPicked
// then dropped any record key the cached list did not have.
// Run: node scripts/test-setup-pack-cache.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const head = code.slice(0, code.search(/export function Setup\(/));

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok(head.includes('function Setup') === false && /export function Setup\(/.test(code), 'found the Setup function');
ok(!/\bnew Map\b/.test(head), 'pack reads are not stored in a module-level Map');
ok(!/listPackInputs\([^)]*\)\.catch\(/.test(code), 'a failed pack input read is not turned into an empty list');
ok(!/listPackRoutes\([^)]*\)\.catch\(/.test(code), 'a failed pack route read is not turned into an empty list');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath || fail) {
  console.log(fail ? `test-setup-pack-cache: ${fail} failure(s)` : 'test-setup-pack-cache: all passed');
  process.exit(fail ? 1 : 0);
}

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-setup-pack-cache-'));
const entry = join(dir, 'entry.tsx');
const out = join(dir, 'app.js');
writeFileSync(entry, `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { Setup } from ${JSON.stringify(join(root, 'src/pages/Setup.tsx'))};

function App() {
  const [show, setShow] = useState(true);
  const [epoch, setEpoch] = useState(0);
  return h('div', null,
    h('button', { type: 'button', onClick: () => setShow(false) }, 'Leave settings'),
    h('button', { type: 'button', onClick: () => { setEpoch((n) => n + 1); setShow(true); } }, 'Back to settings'),
    show ? h(Setup, { key: epoch }) : h('p', null, 'Away'),
  );
}

createRoot(document.getElementById('root')).render(h(MemoryRouter, null, h(App)));
`);

const API = `
const bag = () => globalThis.__API;
export function listGroups() { bag().calls.push(['listGroups']); return Promise.resolve(bag().groups); }
export function listPacks(g) { bag().calls.push(['listPacks', g]); return Promise.resolve(bag().packs[g] || []); }
export function listInputs(g) { bag().calls.push(['listInputs', g]); return Promise.resolve(bag().inputs[g] || []); }
export function listPackInputs(g, pack) {
  bag().calls.push(['listPackInputs', g, pack]);
  const left = bag().fail && bag().fail[g];
  if (left > 0) { bag().fail[g] = left - 1; return Promise.reject(new Error('transient')); }
  return Promise.resolve((bag().packInputs[g] && bag().packInputs[g][pack]) || []);
}
export function listPackRoutes(g, pack) {
  bag().calls.push(['listPackRoutes', g, pack]);
  return Promise.resolve((bag().packRoutes[g] && bag().packRoutes[g][pack]) || []);
}
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
  globalThis.__FLEET = targets.map((t) => ({ group: t.group, mode: t.mode, inputs: [...(t.inputs || [])] }));
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

const PACK = 'cc-paloalto';
const OTHER = 'cc-other';
const KEY = 'syslog:cc-paloalto.in_pan_syslog';
const KEY_NEW = 'syslog:cc-paloalto.in_later';
const KEY2 = 'syslog:cc-other.in_other';
const DS = 'pulse_metrics_pq';
const DEST = 'pulse_lake_pq';
const yesRoutes = [{ id: 'to-group', filter: 'true', targetContext: 'group', output: '__group' }];
const rec = (group, inputs) => ({ group, inputs, filter: '', at: '2026-11-01T00:00:00Z', pack: '1.3.0', dataset: DS, destination: DEST });
const pulsePack = [{ id: 'cribl-pulse', version: '1.3.0' }, { id: PACK }];
const pan = () => [{ id: 'in_pan_syslog', type: 'syslog' }];

const fixture = {
  calls: [], version: '4.17.2', fail: { retry: 1 },
  groups: [{ id: 'retry', workerCount: 2 }, { id: 'same', workerCount: 2 }, { id: 'added', workerCount: 2 }],
  packs: { retry: pulsePack, same: pulsePack.map((p) => ({ ...p })), added: pulsePack.map((p) => ({ ...p })) },
  inputs: { retry: [{ id: 'a', type: 'syslog' }], same: [{ id: 'a', type: 'syslog' }], added: [{ id: 'a', type: 'syslog' }] },
  packInputs: {
    retry: { [PACK]: pan(), 'cribl-pulse': [{ id: 'hidden', type: 'syslog' }] },
    same: { [PACK]: pan() },
    added: { [PACK]: pan() },
  },
  packRoutes: {
    retry: { [PACK]: yesRoutes, 'cribl-pulse': yesRoutes },
    same: { [PACK]: yesRoutes },
    added: { [PACK]: yesRoutes },
  },
  kv: {
    'deployments/retry': rec('retry', [KEY]),
    'deployments/same': rec('same', [KEY, KEY_NEW]),
    'deployments/added': rec('added', [KEY, KEY2]),
  },
};

const pulse = {
  settings: {
    dataset: DS, destination: DEST, routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
};

writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__API = ${JSON.stringify(fixture)}; globalThis.__PULSE = ${JSON.stringify(pulse)};</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });

const calls = (page) => page.evaluate(() => globalThis.__API.calls.map((c) => c.slice()));
const reads = (list, group, pack) => list.filter((c) => c[0] === 'listPackInputs' && c[1] === group && c[2] === pack);
const inputsOf = (page, group) => page.evaluate((id) => {
  const t = (globalThis.__FLEET || []).find((x) => x.group === id);
  return t ? t.inputs : null;
}, group);

try {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  // Include is the Table's row selection (spec 039). The cell covers the visually hidden input, so clicks are forced.
  const inc = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) }).getByRole('checkbox');
  await inc('retry').waitFor({ timeout: 15000 });
  let seen = await calls(page);
  ok(reads(seen, 'retry', PACK).length === 0, 'first paint does not read pack inputs');

  await inc('retry').click({ force: true });
  await page.waitForFunction(() => {
    const err = document.body.innerText.includes('Could not read pack sources');
    const on = (globalThis.__FLEET || []).some((t) => t.group === 'retry');
    return err || on;
  });
  const failedOn = await page.evaluate(() => (globalThis.__FLEET || []).some((t) => t.group === 'retry'));
  ok(!failedOn, 'a failed pack read does not include the group with its pack source omitted');
  ok(await page.getByText('Could not read pack sources').count() === 1, 'a failed pack read is told to the user');
  seen = await calls(page);
  ok(reads(seen, 'retry', PACK).length === 1, 'the failed read was attempted once');

  await inc('retry').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'retry' && t.inputs.includes(key)), KEY);
  seen = await calls(page);
  ok(reads(seen, 'retry', PACK).length === 2, 'the next include reads the pack again');
  ok((await inputsOf(page, 'retry'))?.includes(KEY), 'the retried read keeps the record pack source');
  ok(await page.getByText('Could not read pack sources').count() === 0, 'the successful retry clears the pack read error');

  await inc('same').click({ force: true });
  await page.waitForFunction((key) => {
    const t = (globalThis.__FLEET || []).find((x) => x.group === 'same');
    return t && t.inputs.includes(key) && !t.inputs.includes('syslog:cc-paloalto.in_later');
  }, KEY);
  await inc('added').click({ force: true });
  await page.waitForFunction((key) => {
    const t = (globalThis.__FLEET || []).find((x) => x.group === 'added');
    return t && t.inputs.includes(key) && !t.inputs.includes('syslog:cc-other.in_other');
  }, KEY);
  seen = await calls(page);
  ok(reads(seen, 'same', PACK).length === 1, 'the first visit reads the pack once');
  ok(reads(seen, 'added', OTHER).length === 0, 'a pack that is not installed yet is not read');

  await page.evaluate((ids) => {
    const bag = globalThis.__API;
    bag.packInputs.same[ids.pack].push({ id: 'in_later', type: 'syslog' });
    bag.packs.added = [...bag.packs.added, { id: ids.other }];
    bag.packInputs.added[ids.other] = [{ id: 'in_other', type: 'syslog' }];
    bag.packRoutes.added[ids.other] = [{ id: 'to-group', filter: 'true', targetContext: 'group', output: '__group' }];
  }, { pack: PACK, other: OTHER });

  await page.getByRole('button', { name: 'Leave settings', exact: true }).click();
  await page.getByText('Away', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to settings', exact: true }).click();
  await inc('same').waitFor({ timeout: 15000 });

  await inc('same').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'same' && t.inputs.includes(key)), KEY_NEW);
  seen = await calls(page);
  ok(reads(seen, 'same', PACK).length === 2, 'coming back reads the same pack again, so a source added later is not dropped');
  ok((await inputsOf(page, 'same'))?.includes(KEY) && (await inputsOf(page, 'same'))?.includes(KEY_NEW), 'the new visit keeps both pack sources from the record');

  await inc('added').click({ force: true });
  await page.waitForFunction((key) => (globalThis.__FLEET || []).some((t) => t.group === 'added' && t.inputs.includes(key)), KEY2);
  seen = await calls(page);
  ok(reads(seen, 'added', PACK).length === 2, 'coming back reads the original pack again');
  ok(reads(seen, 'added', OTHER).length === 1, 'coming back reads a pack that was installed after the first visit');
  const added = await inputsOf(page, 'added');
  ok(added?.includes(KEY) && added?.includes(KEY2), 'the new pack source from the record is on the deploy');
  ok(!seen.some((c) => c[2] === 'cribl-pulse'), 'cribl-pulse is still not read');
  ok(!seen.some((c) => ['POST', 'PUT', 'PATCH', 'DELETE'].includes(c[0])), 'reading packs does not write');
  ok(!errors.length, `no page errors (${errors.join(' | ')})`);
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

console.log(fail ? `test-setup-pack-cache: ${fail} failure(s)` : 'test-setup-pack-cache: all passed');
process.exit(fail ? 1 : 0);
