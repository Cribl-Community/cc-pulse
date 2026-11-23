// F6: fleet table cells match mockup B. One render path for demo and live.
// Pulse now, Sources to watch, and What the deploy does. Volume and CPU stay on the F3 formatters.
// Run: node scripts/test-setup-cells.mjs
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { findPlaywright } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
const css = readFileSync(join(root, 'src/App.css'), 'utf8');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok((src.match(/^export /gm) ?? []).length === 1 && /export function Setup\(/.test(src), 'Setup.tsx exports only Setup');
ok(!/\buseEffect\b/.test(code), 'Setup.tsx adds no useEffect');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(src) && !/#[0-9a-fA-F]{3,8}\b/.test(css), 'no hex colour in Setup.tsx or App.css cells');
ok(/formatVolume\(/.test(code) && /formatCpu\(/.test(code), 'Volume and CPU still go through the F3 formatters');

const subtle = code.match(/const SUBTLE_DEPLOY = new Set\(\[([^\]]*)\]\)/);
ok(!!subtle && /'not in this deploy'/.test(subtle[1]) && /NO_WORKERS/.test(subtle[1]), 'subtle deploy text is not in this deploy and no workers');
ok(!!subtle && !/up to date/.test(subtle[1]) && !/pick at least one source/.test(subtle[1]), 'up to date and pick at least one source are not subtle text');

const pulseCol = code.match(/id: 'pulse'[\s\S]*?id: 'sources'/);
ok(!!pulseCol && /r\.pulse === 'not installed' \? <Text>\{r\.pulse\}<\/Text>/.test(pulseCol[0]) && /<Tag color=\{r\.tone\}>\{r\.pulse\}<\/Tag>/.test(pulseCol[0]) && !/size="sm"/.test(pulseCol[0]),
  'not installed is plain text; a version is a default-size Tag');

const does = code.match(/id: 'does', label: 'What the deploy does', render:[\s\S]*?setup-deploy-tags[\s\S]*?<\/div>\)\s*\}/);
ok(!!does && /SUBTLE_DEPLOY\.has\(a\)/.test(does[0]) && /<Tag key=\{a\}>\{a\}<\/Tag>/.test(does[0]) && !/size="sm"/.test(does[0]),
  'each deploy action is a default-size Tag');
ok(/setup-sources-cell \{[^}]*flex-wrap:\s*nowrap[^}]*white-space:\s*nowrap/.test(css), 'sources cell keeps All/Pick and the count on one line');

const pwPath = findPlaywright();
ok(!!pwPath, 'Playwright is available for the cell measurements');
if (!pwPath) process.exit(fail ? 1 : 0);

const dir = mkdtempSync(join(root, 'node_modules', '.tmp-cells-'));
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

const sheet = [
  readFileSync(join(root, 'node_modules/@capra/theme/dist/base.css'), 'utf8'),
  readFileSync(join(root, 'node_modules/@capra/core/dist/style.css'), 'utf8'),
  css,
].join('\n').replace(/<\/style/gi, '<\\/style');
const pulse = {
  settings: {
    dataset: 'pulse_metrics', destination: 'pulse_lake', routeFilter: 'true', rollup: 'off', refresh: '5m',
    notify: { targets: [], email: '', routes: [] },
    learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  },
  fleet: [],
  refresh: null,
};
writeFileSync(join(dir, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><style>${sheet}</style></head><body><div id="root"></div>
<script>window.CRIBL_BASE_PATH = '/app-ui/pulse'; globalThis.__PULSE = ${JSON.stringify(pulse)}; globalThis.__PULSE.refresh = () => Promise.resolve();
window.fetch = () => Promise.reject(new Error('demo must not fetch'));</script>
<script src="app.js"></script></body></html>`);

const require = createRequire(import.meta.url);
const { chromium } = require(pwPath);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (e) => console.log('PAGEERROR', e.message));
  await page.goto(`file://${join(dir, 'index.html')}`);
  const rowOf = (id) => page.getByRole('row').filter({ has: page.getByText(id, { exact: true }) }).first();
  await rowOf('prod-eu').waitFor({ timeout: 15000 });
  const box = (loc) => loc.boundingBox();
  const centreY = (b) => b.y + b.height / 2;
  const textNode = (id, t) => rowOf(id).evaluate((root, t) => {
    const el = [...root.querySelectorAll('*')].find((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() === t));
    if (!el) return null;
    const tag = el.closest('[data-size][data-color]');
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      fontSize: parseFloat(cs.fontSize),
      height: r.height,
      tag: !!tag,
      tagColor: tag ? tag.getAttribute('data-color') : '',
      tagSize: tag ? tag.getAttribute('data-size') : '',
      subtle: (el.getAttribute('style') || '').includes('foreground-subtle'),
    };
  }, t);

  const dest = await textNode('prod-eu', 'destination');
  ok(!!dest && dest.tag && dest.tagSize !== 'sm' && dest.fontSize >= 12, `prod-eu destination tag is at least 12px (${dest ? dest.fontSize : 'missing'}px, size ${dest?.tagSize})`);

  const allSrc = await box(rowOf('prod-us').getByText(/^All sources \(\d+\)$/).first());
  ok(!!allSrc && allSrc.height <= 24, `prod-us All sources (4) is one line (${allSrc ? Math.round(allSrc.height) : '?'}px)`);

  const [pickB, nOfM] = [await box(rowOf('prod-eu').getByText('Pick', { exact: true }).first()), await box(rowOf('prod-eu').getByText(/^\d+ of \d+$/).first())];
  const dy = pickB && nOfM ? Math.abs(centreY(pickB) - centreY(nOfM)) : NaN;
  ok(!!pickB && !!nOfM && dy <= 6, `prod-eu n of m sits on Pick's line (${Number.isFinite(dy) ? Math.round(dy) : '?'}px)`);

  const update = await textNode('prod-eu', 'Pulse 1.2.0 · update');
  const current = await textNode('04-2025', 'Pulse 1.3.0');
  const missing = await textNode('prod-us', 'not installed');
  ok(!!update && update.tag && update.tagColor === 'warning', `an update version is a warning Tag (${update?.tagColor})`);
  ok(!!current && current.tag && current.tagColor === 'success', `the current version is a success Tag (${current?.tagColor})`);
  ok(!!missing && !missing.tag, 'not installed is plain text, not a Tag');

  const aside = await textNode('04-2025', 'not in this deploy');
  const none = await textNode('lab', 'no workers — nothing to deploy to');
  ok(!!aside && !aside.tag && aside.subtle, 'an unticked row shows not in this deploy as subtle text, not a Tag');
  ok(!!none && !none.tag && none.subtle, 'a 0-worker row shows no workers — nothing to deploy to as subtle text, not a Tag');

  const eu = await rowOf('prod-eu').innerText();
  ok(/\b\d+(?:\.\d)?k ev\/s/.test(eu) && /~0\.\d\d core|< 0\.01 core/.test(eu), `Volume and CPU keep the compact formatters (${eu.slice(0, 180)})`);

  const labBox = rowOf('lab').getByRole('checkbox');
  ok(await labBox.isDisabled() && !(await labBox.isChecked()), 'a 0-worker checkbox starts disabled and unchecked');
  await page.getByRole('row').first().getByRole('checkbox').click({ force: true });
  ok(await labBox.isDisabled() && !(await labBox.isChecked()), 'the header checkbox still cannot select a 0-worker row');

  const edge = rowOf('edge-paris');
  await edge.getByRole('button', { name: /^\d+ of \d+$/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Sources on edge-paris' });
  await drawer.waitFor({ timeout: 5000 });
  await drawer.getByRole('button', { name: 'Clear', exact: true }).click();
  await drawer.getByRole('button', { name: 'Apply', exact: true }).click();
  await drawer.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
  const pickOne = await textNode('edge-paris', 'pick at least one source');
  ok(!!pickOne && pickOne.tag && pickOne.tagSize !== 'sm' && pickOne.fontSize >= 12, `pick at least one source is a default-size Tag (${pickOne ? pickOne.fontSize : 'missing'}px)`);
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

console.log(fail ? `test-setup-cells: ${fail} failure(s)` : 'test-setup-cells: all passed');
process.exit(fail ? 1 : 0);
