// F5: SetupSourcesDrawer. Source constraints, then a browser pass over the real Setup in demo mode
// (import.meta.env.DEV, no CRIBL_API_URL): Pick opens "Sources on <group>", Tick all / Clear, Apply, Cancel.
// Run: node scripts/test-setup-sources-drawer.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const drawerSrc = readFileSync(join(root, 'src/components/SetupSourcesDrawer.tsx'), 'utf8');
const setupSrc = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

const capra = drawerSrc.match(/import\s*\{([^}]*)\}\s*from\s*'@capra\/core'/);
const names = capra ? capra[1].split(',').map((s) => s.trim()) : [];
ok(names.includes('Drawer') && names.includes('Checkbox'), 'SetupSourcesDrawer imports Drawer and Checkbox from @capra/core');
ok(/from '\.\.\/components\/SetupSourcesDrawer'/.test(setupSrc) && /<SetupSourcesDrawer\b/.test(setupSrc), 'Setup renders SetupSourcesDrawer');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(drawerSrc), 'the Drawer has no hex color');
ok(!/<a[\s>]/.test(drawerSrc), 'the Drawer has no bare <a');

// reachText: the three packSources outcomes.
{
  const tmp = mkdtempSync(join(root, 'node_modules', '.tmp-reach-'));
  const mod = join(tmp, 'reach.mjs');
  await build({ entryPoints: [join(root, 'src/lib/sourceReach.ts')], bundle: true, format: 'esm', platform: 'node', outfile: mod, logLevel: 'error' });
  const { reachText } = await import(mod);
  const base = { id: 'in_x', type: 'syslog', evs: 1, picked: false, pack: 'p1' };
  ok(reachText({ ...base, staysInPack: true }) === 'in pack p1 · stays in the pack', 'staysInPack reads stays in the pack');
  ok(reachText({ ...base, reach: 'no' }) === 'in pack p1 · stays in the pack', "reach 'no' reads stays in the pack");
  ok(reachText({ ...base, reach: 'maybe' }) === 'in pack p1 · maybe', "reach 'maybe' reads maybe");
  ok(reachText({ ...base, reach: 'yes' }) === 'in pack p1 · yes', "reach 'yes' reads yes");
  ok(reachText({ ...base }) === 'in pack p1 · yes', 'a pack source with no flag reads yes');
  ok(reachText({ id: 'in_y', type: 's3', evs: 1, picked: false }) === '', 'an own input has no reach text');
  rmSync(tmp, { recursive: true, force: true });
}

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available');
if (!pwPath) { process.exit(fail ? 1 : 0); }

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-drawer-'));
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
      b.onResolve({ filter: /\/state$/ }, (args) => (args.importer.endsWith('Setup.tsx') ? { path: 'state', namespace: 'fake' } : undefined));
      b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ loader: 'js', resolveDir: root, contents: STATE }));
    },
  }],
});

const pulse = {
  settings: {
    dataset: 'pulse_metrics', destination: 'pulse_lake', routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
  refresh: null,
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();
window.fetch = () => Promise.reject(new Error('demo must not fetch'));</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  const rowOf = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) });
  await rowOf('prod-eu').first().waitFor({ timeout: 15000 });
  const rowText = async (id) => page.getByRole('row').filter({ hasText: id }).first().innerText();
  const pickOn = (id) => page.locator(`[aria-label="Sources to watch on ${id}"]`).getByText('Pick', { exact: true });
  const dialog = (id) => page.getByRole('dialog', { name: `Sources on ${id}` });
  const body = () => page.locator('body').innerText();

  ok((await rowText('prod-eu')).includes('3 of 5'), 'prod-eu starts at 3 of 5');
  ok(await rowOf('prod-eu').getByRole('button', { name: 'prod-eu', exact: true }).count() === 0, 'prod-eu name is plain text, not a button');
  const colors = await rowOf('prod-eu').first().evaluate((root) => {
    const find = (t) => [...root.querySelectorAll('*')].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === t));
    const c = (t) => { const e = find(t); return e ? getComputedStyle(e).color : ''; };
    return { name: c('prod-eu'), workers: c('6') };
  });
  ok(colors.name !== '' && colors.name === colors.workers, `prod-eu colour equals the Workers cell (${colors.name} vs ${colors.workers})`);
  ok(!(await body()).includes('Copy sources to'), 'with the drawer closed, the page text does not contain Copy sources to');
  const doesBefore = await rowText('prod-eu');

  // Pick on prod-eu (already Pick) opens the Drawer.
  await pickOn('prod-eu').click();
  const d = dialog('prod-eu');
  await d.waitFor({ timeout: 5000 });
  ok(await d.isVisible(), 'Pick on prod-eu opens a dialog titled Sources on prod-eu');
  const sourceBoxes = d.getByRole('checkbox', { name: /·/ });
  const n = await sourceBoxes.count();
  ok(n >= 5, `at least 5 source checkboxes (${n})`);
  ok(await d.getByRole('button', { name: 'Copy these sources to…', exact: true }).isVisible(), 'the dialog has Copy these sources to…');
  for (const id of ['prod-us', 'edge-paris', '04-2025', 'lab'])
    ok(await d.getByRole('checkbox', { name: `Copy to ${id}`, exact: true }).count() === 1, `Copy to ${id} is in the dialog`);
  ok(await d.getByRole('checkbox', { name: 'Copy to prod-eu', exact: true }).count() === 0, 'the dialog does not offer Copy to prod-eu');
  const dt = await d.innerText();
  ok(/in_pan_syslog[^\n]*stays in the pack/.test(dt), 'in_pan_syslog is labelled stays in the pack');
  ok(dt.includes('in pack cc-paloalto'), 'pack source names its pack');
  ok(dt.includes('This source stays inside the pack') && dt.includes('targetContext group'), 'STAYS and OWNER text are shown');
  const at = (s) => dt.indexOf(s);
  ok(at('in_syslog ·') >= 0 && at('in_syslog ·') < at('in_s3_cloudtrail') && at('in_s3_cloudtrail') < at('in_pan_syslog'), 'own inputs come first, the pack source last');
  ok(/in_syslog · syslog · 4,200 ev\/s/.test(dt), 'a checkbox shows id, type and ev/s');

  const panBox = d.getByRole('checkbox', { name: /in_pan_syslog/ });
  ok(await panBox.isVisible() && await panBox.isDisabled(), 'in_pan_syslog is visible and disabled');
  const checkedCount = async () => (await sourceBoxes.evaluateAll((els) => els.filter((e) => e.checked).length));
  ok(await checkedCount() === 3, 'the 3 picked sources start ticked');
  await d.getByRole('button', { name: 'Tick all', exact: true }).click();
  ok(await checkedCount() === n - 1, 'Tick all ticks every unlocked checkbox (not in_pan_syslog)');
  ok(!(await panBox.isChecked()), 'Tick all leaves in_pan_syslog unchecked');
  await d.getByRole('button', { name: 'Clear', exact: true }).click();
  ok(await checkedCount() === 0, 'Clear unticks every checkbox');

  // Cancel discards.
  await d.getByRole('button', { name: 'Cancel', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-eu')) === doesBefore, 'Cancel leaves the prod-eu row unchanged (3 of 5)');
  ok(!(await body()).includes('Copy sources to'), 'closing the drawer removes Copy sources to from the page');

  // Reopen through the n of m text, tick in_s3_cloudtrail, Apply.
  await rowOf('prod-eu').getByRole('button', { name: '3 of 5', exact: true }).click();
  await d.waitFor({ timeout: 5000 });
  ok(await checkedCount() === 3, 'reopening starts from the row picks, not the cancelled ticks');
  await d.getByRole('checkbox', { name: /in_s3_cloudtrail/ }).click({ force: true });
  await d.getByRole('button', { name: 'Apply', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  const after = await rowText('prod-eu');
  ok(after.includes('4 of 5'), `Apply changes prod-eu to 4 of 5 (${after.replace(/\s+/g, ' ')})`);

  // Tick all then Apply selects only unlocked own inputs (4 of 5, not 5 of 5).
  await rowOf('prod-eu').getByRole('button', { name: '4 of 5', exact: true }).click();
  await d.waitFor({ timeout: 5000 });
  await d.getByRole('button', { name: 'Tick all', exact: true }).click();
  ok(await checkedCount() === n - 1 && !(await panBox.isChecked()), 'Tick all again skips in_pan_syslog');
  await d.getByRole('button', { name: 'Apply', exact: true }).click();
  await d.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-eu')).includes('4 of 5'), 'Tick all then Apply leaves prod-eu at 4 of 5, not 5 of 5');

  // Pick on an All row, then Cancel: the row stays All.
  ok((await rowText('prod-us')).includes('All sources (4)'), 'prod-us starts on All sources (4)');
  const usBefore = await rowText('prod-us');
  await pickOn('prod-us').click();
  const du = dialog('prod-us');
  await du.waitFor({ timeout: 5000 });
  await du.getByRole('button', { name: 'Cancel', exact: true }).click();
  await du.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-us')) === usBefore && usBefore.includes('All sources (4)'), 'Pick then Cancel on prod-us leaves All sources (4)');

  // Pick, Clear one, Apply on prod-us: Pick with the ticked sources and the deploy actions follow.
  await pickOn('prod-us').click();
  await du.waitFor({ timeout: 5000 });
  await du.getByRole('checkbox', { name: /in_s3_us/ }).click({ force: true });
  await du.getByRole('button', { name: 'Apply', exact: true }).click();
  await du.waitFor({ state: 'detached', timeout: 5000 });
  ok((await rowText('prod-us')).includes('3 of 4'), 'Apply on prod-us sets it to Pick 3 of 4');
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

console.log(fail ? `test-setup-sources-drawer: ${fail} failure(s)` : 'test-setup-sources-drawer: all passed');
process.exit(fail ? 1 : 0);
