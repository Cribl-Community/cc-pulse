// R2: Retry after a failed deploy must send the commit that already happened.
// Setup rebuilds fleetPlan when refresh() follows the run, so the steps prop is new
// functions whose commit hash is empty. Retry has to keep using the confirmed run.
// Run: node scripts/test-fleet-retry.mjs
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

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-fleet-retry-'));
const entry = join(dir, 'entry.tsx');
const out = join(dir, 'app.js');
writeFileSync(entry, `
import { createElement as h, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { FleetRunner } from ${JSON.stringify(join(root, 'src/components/FleetRunner.tsx'))};
import { fleetPlan } from ${JSON.stringify(join(root, 'src/lib/fleetPlan.ts'))};
import { PACK_VERSION } from ${JSON.stringify(join(root, 'src/lib/deploy.ts'))};

const S = { dataset: 'pulse_metrics', destination: 'pulse_lake', routeFilter: 'true', rollup: 'off', notify: { targets: [], email: '' } };
const target = {
  group: 'prod-us', mode: 'selected', inputs: ['syslog:in_b'], installed: PACK_VERSION,
  prev: { group: 'prod-us', inputs: ['syslog:in_a'], filter: '', at: '', pack: PACK_VERSION, dataset: S.dataset, destination: S.destination },
};

function App() {
  const [gen, setGen] = useState(0);
  const [open, setOpen] = useState(true);
  const plan = fleetPlan([target], S, { alerts: false, enabled: false });
  return h('div', null,
    h('p', { id: 'which' }, String(gen)),
    h(FleetRunner, {
      lanes: plan.lanes, steps: plan.steps, rows: [{ where: 'prod-us', text: 'route pulse_observer overwritten' }],
      open, onClose: () => setOpen(false), onDone: () => setGen(1),
      children: () => null,
    }));
}

createRoot(document.getElementById('root')).render(h(App));
`);

const FAKE = `
export const API = '/api/v1';
export class ApiError extends Error {
  constructor(status, path, msg, method = 'GET', body = '') {
    super(msg); this.status = status; this.path = path; this.method = method; this.body = body;
  }
  get detail() { return this.message; }
}
export const items = (r) => (r && r.items) || [];
export async function api(path, opts = {}) {
  const m = (opts.method || 'GET').toUpperCase();
  globalThis.__cribl.calls.push(m + ' ' + path);
  if (/\\/routes\\/default$/.test(path) && m === 'GET') return { items: [{ id: 'default', routes: [] }] };
  if (m === 'GET') return { items: [] };
  return {};
}
export const listDatasets = async () => [];
export const kvGet = async (_k, d) => d;
export const kvPut = async (k, v) => { globalThis.__cribl.kv[k] = v; };
export const publishLookup = async () => undefined;
export const setPackVar = async () => undefined;
export async function commitGroup(group) {
  globalThis.__cribl.commits.push(group);
  return 'c0ffee99';
}
export async function deployGroup(group, version) {
  const s = globalThis.__cribl;
  s.deploys.push({ group, version });
  if (s.fail > 0) { s.fail -= 1; throw new Error('deploy failed'); }
}
export const runSearch = async () => [];
export const listGroups = async () => [];
`;

await build({
  entryPoints: [entry], bundle: true, format: 'iife', platform: 'browser', outfile: out, logLevel: 'error', jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty', '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty' },
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  },
  plugins: [{
    name: 'fake-api',
    setup(b) {
      b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api', namespace: 'fake' }));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ loader: 'js', resolveDir: root, contents: FAKE }));
    },
  }],
});

writeFileSync(join(dir, 'index.html'), `<!doctype html><html><body><div id="root"></div>
<script>
globalThis.__cribl = { commits: [], deploys: [], kv: {}, calls: [], fail: 1 };
window.CRIBL_BASE_PATH = '/app-ui/pulse';
window.CRIBL_API_URL = 'http://pulse.test/api/v1';
</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ timeout: 15000 });
  await dialog.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('which')?.textContent === '1');
  const mid = await page.evaluate(() => ({
    deploys: globalThis.__cribl.deploys.length,
    commits: globalThis.__cribl.commits.length,
    record: globalThis.__cribl.kv['deployments/prod-us'] ?? null,
  }));
  ok(mid.deploys === 1 && mid.commits === 1 && mid.record === null, 'the failed deploy kept its commit and wrote no record');
  await page.getByRole('button', { name: 'Retry prod-us', exact: true }).click();
  await page.waitForFunction(() => globalThis.__cribl.deploys.length >= 2 || globalThis.__cribl.kv['deployments/prod-us']);
  const after = await page.evaluate(() => globalThis.__cribl);
  ok(after.commits.length === 1 && after.commits[0] === 'prod-us', 'retry does not commit again');
  ok(after.deploys.length === 2 && after.deploys[0].version === 'c0ffee99' && after.deploys[1].version === 'c0ffee99',
    'retry deploys the commit from the confirmed plan');
  ok(after.kv['deployments/prod-us']?.group === 'prod-us', 'the deployment record is written after that deploy');
} catch (e) {
  fail++;
  console.log('✘ browser pass threw', e?.message || e);
} finally {
  await browser.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(fail ? `test-fleet-retry: ${fail} failure(s)` : 'test-fleet-retry: all passed');
process.exit(fail ? 1 : 0);
