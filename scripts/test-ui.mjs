#!/usr/bin/env node
// Tests for the spec 013 layout primitives: Page, Metric and Section in src/components/ui.tsx, and their state
// helpers in src/lib/layout.ts. Bundles them with esbuild (no DOM library in the repo), renders with
// react-dom/server, and calls event handlers straight from the rendered element tree.
// Run: node scripts/test-ui.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://pulse.test/api/v1';
const entry = join(root, 'node_modules/.tmp-ui-entry.mjs');
const out = join(root, 'node_modules/.tmp-ui-bundle.mjs');
writeFileSync(entry, [
  "export * as ui from '../src/components/ui.tsx';",
  "export * as charts from '../src/components/charts.tsx';",
  "export * as layout from '../src/lib/layout.ts';",
  "export * as tsc from '../src/components/TimeScope.tsx';",
  "export { TimeScopePicker, TzFooter } from '../src/components/TimeScope.tsx';",
  "export * as quickrange from '../src/lib/quickrange.ts';",
  "export { TimeScopeCtx } from '../src/scopeContext.ts';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h, Fragment } from 'react';",
  "export { MemoryRouter } from 'react-router-dom';",
  "export { Alert, Button, Tag } from '@capra/core';",
  "export { ArrowTrendUp, ArrowTrendDown } from '@capra/icons';",
  "export * as timescope from '../src/lib/timescope.ts';",
  "export { ErrorBoundary, ErrorFallback } from '../src/components/ErrorBoundary.tsx';",
  "export * as app from '../src/App.tsx';",
].join('\n'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
  '--loader:.css=empty', '--loader:.svg=empty', '--loader:.png=empty', '--log-level=error', `--define:window.CRIBL_API_URL="${API}"`,
  '--define:window.CRIBL_BASE_PATH="/"', '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env={"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  `--outfile=${out}`, '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'], { stdio: 'inherit' });
let mod;
try { mod = await import(`${out}?t=${Date.now()}`); } finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }
const { TimeScopePicker } = mod;
const { charts, ui, tsc, quickrange, TimeScopeCtx, layout,renderToStaticMarkup, h, MemoryRouter, Alert, Button } = mod;

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const html = (el, url = '/') => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [url] }, el));
/** Every React element in a tree (children and element-valued props), without rendering components. */
function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  yield node;
  for (const v of Object.values(node.props ?? {})) yield* walk(v);
}
const find = (tree, pred) => [...walk(tree)].filter(pred);
const textOf = (node) => (typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(textOf).join('') : node?.props ? textOf(node.props.children) : '');

/* ── fake KV behind fetch (kvGet / kvPut in src/lib/api.ts) ── */
const kv = new Map();
const calls = [];
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  calls.push({ url: String(url), method, body: init.body });
  const key = String(url).replace(`${API}/kvstore/`, '').split('?')[0];
  if (method === 'PUT') { kv.set(key, init.body); return { ok: true, status: 200, text: async () => '' }; }
  return kv.has(key) ? { ok: true, status: 200, text: async () => kv.get(key) } : { ok: false, status: 404, text: async () => 'not found' };
};

/* ── exports ── */
for (const c of ['Page', 'Metric', 'Section', 'SectionView']) ok(typeof ui[c] === 'function', `ui.tsx exports ${c}`);
for (const c of ['K'+'pi', 'Li'+'ft']) ok(ui[c] === undefined, `ui.tsx no longer exports ${c} (removed in F9)`);

/* ── Section collapse persists in KV at ui/collapsed/<sectionId> ── */
ok(layout.collapsedKey('heartbeat') === 'ui/collapsed/heartbeat', 'collapse key is ui/collapsed/<sectionId>');
ok(await layout.loadCollapsed('heartbeat') === false, 'nothing stored → expanded');
ok(calls.at(-1)?.url === `${API}/kvstore/ui/collapsed/heartbeat` && calls.at(-1)?.method === 'GET', 'load reads KV ui/collapsed/heartbeat');
await layout.saveCollapsed('heartbeat', true);
ok(calls.at(-1)?.url === `${API}/kvstore/ui/collapsed/heartbeat` && calls.at(-1)?.method === 'PUT' && calls.at(-1)?.body === 'true',
  'collapsing writes true to KV ui/collapsed/heartbeat');
ok(await layout.loadCollapsed('heartbeat') === true, 'after a reload the stored collapsed state comes back from KV');
await layout.saveCollapsed('heartbeat', false);
ok(await layout.loadCollapsed('heartbeat') === false, 'expanding again is stored too');
ok(await layout.loadCollapsed('other') === false && !kv.has('ui/collapsed/other'), 'each section has its own key');
kv.set('ui/collapsed/junk', '"yes"');
ok(await layout.loadCollapsed('junk', true) === true, 'a non-boolean KV value falls back to the default');

// Section's Hide/Show button drives the same state: the toggle reports the next value, and the body hides.
const toggles = [];
const open = ui.SectionView({ title: 'Fleet heartbeat', collapsible: true, collapsed: false, onToggle: (v) => toggles.push(v), children: 'TRACE' });
const hideBtn = find(open, (n) => n.type === Button)[0];
ok(textOf(hideBtn) === 'Hide' && hideBtn.props['aria-expanded'] === true, 'expanded section shows "Hide" (aria-expanded)');
hideBtn.props.onClick();
ok(toggles.join() === 'true', 'clicking Hide asks to collapse');
const shut = ui.SectionView({ title: 'Fleet heartbeat', collapsible: true, collapsed: true, onToggle: (v) => toggles.push(v), children: 'TRACE' });
const showBtn = find(shut, (n) => n.type === Button)[0];
ok(textOf(showBtn) === 'Show', 'collapsed section shows "Show"');
showBtn.props.onClick();
ok(toggles.join() === 'true,false', 'clicking Show asks to expand');
ok(html(open).includes('TRACE') && !html(shut).includes('TRACE'), 'collapsed section hides its body, keeps its header');
ok(!find(ui.SectionView({ title: 'x', children: 'y' }), (n) => n.type === Button).length, 'a non-collapsible section has no Hide/Show');
ok(html(h(ui.Section, { id: 'heartbeat', title: 'T', collapsible: true, children: 'BODY' })).includes('BODY'), 'Section (with the KV hook) renders expanded by default');

const src = ['src/components/ui.tsx', 'src/lib/layout.ts'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
ok(!/\b(localStorage|sessionStorage)\b/.test(src), 'no localStorage / sessionStorage in ui.tsx or layout.ts');

/* ── Section loading / empty / error states, Retry re-runs only that section ── */
let retriesA = 0, retriesB = 0;
const a = ui.SectionView({ title: 'Needs attention', error: new Error('search timed out'), onRetry: () => retriesA++, children: 'ROWS' });
const b = ui.SectionView({ title: 'Fleet', error: new Error('403'), onRetry: () => retriesB++, children: 'WALL' });
const alertA = find(a, (n) => n.type === Alert)[0];
ok(!!alertA && alertA.props.appearance === 'danger', 'an error renders an inline danger Alert');
ok(alertA?.props.action?.label === 'Retry', 'the Alert carries a Retry button');
alertA.props.action.onClick();
ok(retriesA === 1 && retriesB === 0, 'clicking Retry calls only that section’s retry handler');
find(b, (n) => n.type === Alert)[0].props.action.onClick();
ok(retriesA === 1 && retriesB === 1, 'the other section retries on its own');
const errHtml = html(a);
ok(/Retry/.test(errHtml) && errHtml.includes('search timed out') && !errHtml.includes('ROWS'), 'error markup: Retry and the message, not the body');
ok(!find(ui.SectionView({ title: 't', error: 'x' }), (n) => n.type === Alert)[0].props.action, 'no Retry without a handler');
const loadingHtml = html(h(ui.SectionView, { span: 7, title: 'Loading', loading: true, children: 'ROWS' }));
ok(/skeleton/i.test(loadingHtml) && loadingHtml.includes('span-7') && !loadingHtml.includes('ROWS'), 'loading renders a Skeleton inside the span');
const emptyHtml = html(h(ui.SectionView, { title: 'Empty', empty: true, children: 'ROWS' }));
ok(emptyHtml.includes('No data') && emptyHtml.includes('section-empty') && !emptyHtml.includes('ROWS'), 'empty renders centred "No data"');
const emptyState = html(h(ui.SectionView, { title: 'Empty', empty: { title: 'No incidents', description: 'Quiet day', cta: h('button', null, 'Deploy') } }));
ok(emptyState.includes('No incidents') && emptyState.includes('Deploy'), 'empty can render an EmptyState with a CTA');
const statsHtml = html(h(ui.SectionView, { title: 'Heartbeat', stats: [{ label: 'Reporting', value: 101 }, { label: 'Missing', value: 2 }], children: 'TRACE' }));
ok(statsHtml.indexOf('section-stats') > -1 && statsHtml.indexOf('section-stats') < statsHtml.indexOf('TRACE') && statsHtml.includes('Missing'), 'stats row is drawn before the children');

/* ── Metric ── */
const linkHtml = html(h(ui.Metric, { label: 'Without owner', value: 12, to: '/assets?owner=none' }));
ok(/^<a\b/.test(linkHtml) && linkHtml.includes('href="/assets?owner=none"') && /class="[^"]*metric-link/.test(linkHtml), 'Metric with `to` renders as a link (<a href>)');
const css = readFileSync(join(root, 'src/App.css'), 'utf8');
ok(/\.metric-link:focus-visible\s*\{[^}]*outline:\s*2px solid/.test(css), 'the Metric link has a visible focus ring');
ok(/\.metric-link:hover\s*\{[^}]*color\.border\.accent\.hover[^}]*color\.background\.accent\.subtle/.test(css), 'the Metric link hover uses the accent border and background');
const plain = html(h(ui.Metric, { label: 'Missing', value: 2, hint: 'of 106', tag: { label: '2 missing', color: 'danger' } }));
ok(/^<div\b/.test(plain) && !plain.includes('<a'), 'Metric without `to` is not a link');
const val = (plain.match(/<span class="([^"]*metric-val[^"]*)"[^>]*>/) ?? [])[1];
ok(val === 'metric-val' && !/style=/.test(plain.match(/<span class="metric-val"[^>]*>/)?.[0] ?? 'style='), 'the value has only the neutral metric-val class');
ok(plain.includes('2 missing') && plain.includes('of 106'), 'the severity shows as a Tag; the hint renders');
ok(!/(danger|warning|success|tone)/.test(plain.slice(plain.indexOf('metric-val'), plain.indexOf('of 106'))), 'no status colour on the value');
const metricCss = css.match(/\.metric-val\s*\{([^}]*)\}/)?.[1] ?? '';
ok(/color\.foreground\.default/.test(metricCss) && /24px/.test(metricCss) && /600/.test(metricCss) && /tabular-nums/.test(metricCss), '.metric-val is 24px/600 tabular, default foreground');
const uiSrc = readFileSync(join(root, 'src/components/ui.tsx'), 'utf8');
ok(!/\btone\b/.test(uiSrc.match(/export type MetricProps = \{[\s\S]*?\n\};/)?.[0] ?? 'tone'), 'MetricProps has no tone');

/* ── Page: header band, read-only range display, tabs bound to ?tab= ── */
const top = html(h(ui.Page, { crumbs: [{ label: 'Overview' }], children: h('p', null, 'BODY') }));
ok(top.includes('page-band') && top.includes('Overview') && /<h1[^>]*>Overview<\/h1>/.test(top), 'top-level page: the title is the heading');
ok(!/<nav[^>]*aria-label="[^"]*[Bb]readcrumb/.test(top) && !/breadcrumb/i.test(top), 'top-level page: no breadcrumb');
ok(/class="page-body grid"/.test(top) && top.includes('BODY'), 'body sits in the 12-column grid');
ok(!top.includes('range-display') && !top.includes('time-scope'), 'a Page without `timed` renders no range');
/* TimeScope header control (spec 014 §2) */
const NOW = Math.floor(Date.now() / 1000);
let setCalls = [];
const withScope = (scope, el) => h(TimeScopeCtx.Provider, { value: { scope, setScope: (s) => setCalls.push(s), ready: true } }, el);
const timedHtml = (scope) => html(withScope(scope, h(ui.Page, { crumbs: [{ label: 'Overview' }], timed: true, actions: h('button', null, 'Export'), children: 'B' })));
const t6 = timedHtml({ earliest: '-6h', latest: 'now', tz: 'local' });
const rangeEl = t6.slice(t6.indexOf('range-display'), t6.indexOf('quick-ranges'));
ok(rangeEl.includes('Last 6 hours') && rangeEl.includes('Local') && !/<button/.test(rangeEl), 'timed Page: read-only range display with a Local Tag');
ok(t6.indexOf('Export') < t6.indexOf('range-display') && t6.indexOf('range-display') < t6.indexOf('quick-ranges'), 'range display follows the actions, then the quick ranges');
ok(timedHtml({ earliest: '-6h', latest: 'now', tz: 'utc' }).includes('>UTC<'), 'tz Tag reads UTC for tz utc');
const qbtns = (s) => [...s.matchAll(/<button[^>]*>/g)].map((m) => m[0]);
const quick = qbtns(t6.slice(t6.indexOf('quick-ranges')));
ok(quick.length === 4 && ['1h', '6h', '24h', '48h'].every((q) => t6.includes('>' + q + '<')), 'four quick range buttons 1h 6h 24h 48h');
ok(quick.filter((b) => /aria-pressed="true"/.test(b)).length === 1 && /aria-pressed="true"/.test(quick[1]), '6h is the one selected quick range');
const custom = timedHtml({ earliest: '-90m', latest: 'now', tz: 'local' });
ok(!/aria-pressed="true"/.test(custom), 'a custom range selects no quick range');
ok(!/aria-pressed="true"/.test(timedHtml({ earliest: '-6h', latest: '-1h', tz: 'local' })), 'a past range ending before now selects none');
ok(quickrange.activeQuick({ earliest: '-48h', latest: 'now', tz: 'utc' }) === '48h', 'activeQuick finds 48h');
{ // click 6h: calls setScope immediately with the tz kept
  setCalls = [];
  quickrange.applyQuick('6h', { earliest: '-24h', latest: 'now', tz: 'utc' }, (s) => setCalls.push(s));
  ok(setCalls.length === 1 && JSON.stringify(setCalls[0]) === JSON.stringify({ earliest: '-6h', latest: 'now', tz: 'utc' }), 'clicking 6h calls setScope at once with {-6h, now} and the tz kept');
  const afterClick = timedHtml(setCalls[0]);
  ok(/aria-pressed="true"/.test(qbtns(afterClick.slice(afterClick.indexOf('quick-ranges')))[1]), 'after the click 6h renders selected');
}
{ // range picker (F6)
  const NOW = 1762600000;
  const pick = (scope) => html(h(TimeScopePicker, { scope, nowS: NOW, onApply: () => {} }));
  const p = pick({ earliest: '-6h', latest: 'now', tz: 'local' });
  const rows = [...p.matchAll(/ts-rail-row[^>]*>.*?ts-token[^>]*>([^<]*)</g)].map((m) => m[1]);
  ok(JSON.stringify(rows) === JSON.stringify(['-5m', '-15m', '-30m', '-1h', '-3h', '-6h', '-12h', '-24h', '-2d']), 'rail has exactly the 9 tokens');
  ok(['Minutes', 'Hours', 'Days'].every((g) => p.includes('>' + g + '<')) && !/Seconds|All time/i.test(p), 'rail groups Minutes/Hours/Days, no seconds or All time');
  ok(/Relative.*Date Range.*Around/.test(p) && /Earliest/.test(p) && /Latest/.test(p), 'tab strip and Relative fields');
  const applyDisabled = (s) => /<button[^>]*disabled[^>]*>\s*(<[^>]*>)*Apply/.test(s) || /<button[^>]*>(?:(?!<\/button>).)*Apply<\/button>/.exec(s)?.[0].includes('disabled');
  ok(!applyDisabled(p), 'valid current value: Apply enabled');
  const bad = pick({ earliest: '-49h', latest: 'now', tz: 'local' });
  ok(applyDisabled(bad) && bad.includes('Ranges are limited to 48 hours'), '-49h: Apply disabled with the 48 hours helperText');
  ok(!applyDisabled(pick({ earliest: '-90m', latest: 'now', tz: 'local' })), '-90m to now: Apply enabled');
  ok(quickrange.relativeErrors('-49h', 'now', 'local', NOW).earliest === 'Ranges are limited to 48 hours' && !quickrange.relativeErrors('-90m', 'now', 'local', NOW).earliest, 'relativeErrors');
  ok(JSON.stringify(quickrange.railScope('-3h', 'utc')) === JSON.stringify({ earliest: '-3h', latest: 'now', tz: 'utc' }), 'rail row scope keeps tz');
  ok(quickrange.pickerTab({ earliest: '1762500000', latest: 'now', tz: 'local' }) === 'range' && quickrange.pickerTab({ earliest: '-1h', latest: 'now', tz: 'local' }) === 'relative', 'picker opens on the matching tab');
  // F7: Date Range / Around
  const abs = (h0) => pick({ earliest: String(NOW - h0 * 3600), latest: String(NOW - 600), tz: 'utc' });
  const selTab = (s) => /role="tab" aria-selected="true"[^>]*>([^<]*)</.exec(s)?.[1];
  ok(selTab(abs(2)) === 'Date Range' && selTab(p) === 'Relative', 'absolute scope opens on Date Range, relative on Relative');
  ok(!applyDisabled(abs(2)), 'valid absolute span: Apply enabled');
  const long = abs(49);
  ok(applyDisabled(long) && long.includes('Ranges are limited to 48 hours'), '49h span: Apply disabled with the 48h reason');
  const w = quickrange.aroundWindow(NOW - 10000, 3600, NOW);
  ok(w.from === NOW - 13600 && w.to === NOW - 6400, 'around window [t-d, t+d]');
  const c = quickrange.aroundWindow(NOW - 100, 3600, NOW);
  ok(c.from === NOW - 3700 && c.to === NOW, 'around end clamped to now');
  ok(JSON.stringify(quickrange.absoluteScope(5, 9, 'utc')) === JSON.stringify({ earliest: '5', latest: '9', tz: 'utc' }), 'absolute scope is epoch-second strings');
  const wl = { year: 2025, month: 11, day: 8, hour: 12, minute: 30 };
  ok(quickrange.wallToEpoch(wl, 'utc') === Date.UTC(2025, 10, 8, 12, 30) / 1000 && JSON.stringify(quickrange.epochToWall(quickrange.wallToEpoch(wl, 'local'), 'local')) === JSON.stringify(wl), 'wall <-> epoch');
}
const cssSrc = readFileSync(join(root, 'src/App.css'), 'utf8');
const lbl = cssSrc.match(/\.range-label\s*\{([^}]*)\}/)?.[1] ?? '';
ok(/text-overflow:\s*ellipsis/.test(lbl) && /overflow:\s*hidden/.test(lbl) && /white-space:\s*nowrap/.test(lbl), 'the range label has ellipsis overflow styling');
ok(/\.quick-ranges\s*\{[^}]*gap:\s*4px/.test(cssSrc), 'quick ranges are 4px apart');
const detail = html(withScope({ earliest: '-24h', latest: 'now', tz: 'local' }, h(ui.Page, { crumbs: [{ label: 'Worker groups', to: '/groups' }, { label: 'default' }], description: 'Sources sending heartbeats',
  updatedAt: new Date(2026, 10, 9, 7, 5), onRefresh: () => {}, actions: h('button', null, 'Export'), timed: true, children: 'B' })));
ok(/breadcrumb/i.test(detail) && detail.includes('Worker groups') && /<h1[^>]*>default<\/h1>/.test(detail), 'detail page: breadcrumb plus the title');
ok(detail.includes('Sources sending heartbeats'), 'detail page: one-line description');
const iUpd = detail.search(/Updated 0?7\D05/), iRef = detail.indexOf('aria-label="Refresh"'), iExp = detail.indexOf('Export'), iRange = detail.indexOf('range-display');
ok(iUpd > -1 && iRef > iUpd && iExp > iRef && iRange > iExp, 'actions order: Updated hh:mm + refresh, page actions, range display');

ok(layout.tabFrom('?tab=flapping', ['timeline', 'least', 'flapping']) === 'flapping', 'tabFrom reads ?tab=');
ok(layout.tabFrom('?tab=bogus', ['timeline', 'flapping']) === 'timeline' && layout.tabFrom('', ['timeline', 'flapping']) === 'timeline', 'unknown or missing ?tab= → first tab');
ok(layout.tabHref('/incidents', '?state=missing', 'least') === '/incidents?state=missing&tab=least', 'tabHref writes ?tab= and keeps other params');
ok(layout.tabHref('/incidents', '?tab=timeline', 'flapping') === '/incidents?tab=flapping', 'tabHref replaces the current tab');
const tabs = [{ key: 'timeline', name: 'Timeline' }, { key: 'least', name: 'Least available' }, { key: 'flapping', name: 'Flapping' }];
const tabbed = html(h(ui.Page, { crumbs: [{ label: 'Incidents' }], tabs, children: 'B' }), '/incidents?tab=flapping&x=1');
ok(tabbed.includes('href="/incidents?tab=timeline&amp;x=1"') || tabbed.includes('href="/incidents?tab=timeline&x=1"'), 'tab links write ?tab= (other params kept)');
const activeTab = tabbed.match(/<a[^>]*aria-current="page"[^>]*>[\s\S]*?<\/a>/)?.[0] ?? tabbed.match(/<a[^>]*(aria-selected="true"|data-active="true"|data-selected="true")[^>]*>[\s\S]*?<\/a>/)?.[0] ?? '';
ok(/Flapping/.test(activeTab) && !/Timeline/.test(activeTab), 'the active tab comes from ?tab= in the URL');
if (process.argv.includes('--debug')) console.log(activeTab, '\n', range);
function TabProbe() { const [t] = layout.useTab(['timeline', 'least', 'flapping']); return h('i', null, `tab=${t}`); }
ok(html(h(TabProbe), '/incidents?tab=least').includes('tab=least'), 'useTab reads ?tab= for the page');
ok(html(h(TabProbe), '/incidents').includes('tab=timeline'), 'useTab falls back to the first tab');

/* ── Question card (§5) ── */
for (const c of ['Question', 'QuestionView', 'Ranked', 'RankedView', 'Drill']) ok(typeof ui[c] === 'function', `ui.tsx exports ${c}`);
const views = [];
const qProps = { question: 'Who stopped sending?', value: 2, unit: 'assets', spark: [0, 1, 3, 2, 0, 4], top: 'dc1-fw-01', to: '/assets?state=missing' };
const qTree = ui.QuestionView({ ...qProps, onView: (to) => views.push(to) });
const qHtml = html(h(ui.QuestionView, { ...qProps, onView: () => {} }));
ok(qHtml.includes('Who stopped sending?') && qHtml.indexOf('Who stopped sending?') < qHtml.indexOf('metric-val'), 'Question: the question is the title, above the value');
ok(/class="metric-val">2<\/span>/.test(qHtml) && qHtml.includes('assets'), 'Question: headline value with its unit word');
ok(find(qTree, (n) => n.type === ui.Spark).length === 1 && qHtml.includes('spark-svg'), 'Question: draws the 24 h sparkline with Pulse Spark');
ok(/class="[^"]*tag[^"]*"[^>]*>[\s\S]*dc1-fw-01/i.test(qHtml) || qHtml.includes('dc1-fw-01'), 'Question: the top item renders');
const qTag = find(qTree, (n) => typeof n.type !== 'string' && textOf(n) === 'dc1-fw-01' && n.props.size === 'sm');
ok(qTag.length === 1, 'Question: the top item is a Tag');
const viewBtn = find(qTree, (n) => n.type === Button)[0];
ok(textOf(viewBtn) === 'View' && viewBtn.props.variant === 'secondary', 'Question: a secondary View button');
viewBtn.props.onClick();
ok(views.join() === '/assets?state=missing', 'Question: View navigates to the `to` URL');
const qLive = html(h(ui.Question, qProps));
ok(qLive.includes('View') && /class="question span-4"/.test(qLive), 'Question (with the router hook) renders as a span-4 card');
ok(/export function Question\([^)]*\)\s*\{[\s\S]*?useNavigate\(\)[\s\S]*?navigate\(to\)/.test(uiSrc), 'Question wires View to react-router navigate(to)');
const qCss = css.match(/\.question\s*\{([^}]*)\}/)?.[1] ?? '';
// Spec 017 supersedes spec 013 §2 ("no resting shadow"): the Question card keeps its 1 px border and rests on shadow.low.down.
ok(/border:\s*1px solid token\('color\.border\.neutral\.subtle'\)/.test(qCss) && /box-shadow:\s*token\('shadow\.low\.down'\)/.test(qCss),
  'Question is a bordered card (subtle border) resting on shadow.low.down (spec 017)');

/* ── Card depth (spec 017): the four card surfaces rest on shadow.low.down with a subtle border ── */
const ruleBody = (sel) => css.match(new RegExp(`(?:^|\\n)${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
for (const sel of ['.section-card', '.metric', '.question', '.ask']) {
  const b = ruleBody(sel);
  ok(/box-shadow:\s*token\('shadow\.low\.down'\)/.test(b), `${sel} rests on box-shadow: token('shadow.low.down')`);
  ok(/border:\s*1px solid token\('color\.border\.neutral\.subtle'\)/.test(b), `${sel} keeps a 1 px border in color.border.neutral.subtle`);
  ok(/border-radius:\s*token\('radius\.lg'\)/.test(b) && /background:\s*token\('color\.background\.panel\.solid'\)/.test(b), `${sel} keeps radius.lg and the panel.solid background`);
}
ok(/className=\{`metric metric-link\b/.test(uiSrc), '.metric-link is always also a .metric (inherits the resting shadow)');
const shadowValues = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/box-shadow\s*:\s*([^;}]+)/g)].map((m) => m[1].trim());
ok(shadowValues.every((v) => /^token\('shadow\.[\w.]+'\)$/.test(v)), `every box-shadow is a token('shadow.…') call (${shadowValues.join(' | ')})`);
ok(!/\.dark[^{]*\{[^}]*box-shadow/.test(css), 'no .dark box-shadow override');

/* ── Ranked (§6): bars proportional to the max, ↑/↓/Enter, accent active row ── */
const rows = [{ key: 'a', name: 'alpha', sub: 'syslog', value: 40 }, { key: 'b', name: 'bravo', sub: 'otel', value: 10 }, { key: 'c', name: 'charlie', value: 0 }];
const rHtml = html(h(ui.RankedView, { rows }));
const widths = [...rHtml.matchAll(/class="ranked-bar" style="width:\s*([\d.]+)%"/g)].map((m) => Number(m[1]));
ok(widths.join() === '100,25,0', `magnitude bars are value / max (got ${widths.join()})`);
const wMax = [...html(h(ui.RankedView, { rows, max: 80 })).matchAll(/class="ranked-bar" style="width:\s*([\d.]+)%"/g)].map((m) => Number(m[1]));
ok(wMax.join() === '50,12.5,0', 'an explicit max rescales the bars');
ok(layout.barPct(3, 4) === 75 && layout.barPct(5, 0) === 0 && layout.barPct(9, 4) === 100, 'barPct: share of max, clamped, safe at max 0');
ok(rHtml.includes('alpha') && rHtml.includes('syslog') && /class="ranked-val">40</.test(rHtml), 'row: name, sub-line and value');
ok((rHtml.match(/<button type="button"/g) ?? []).length === 3, 'rows are buttons');
const rCss = (sel) => css.match(new RegExp(`${sel.replace(/\./g, '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
ok(/height:\s*5px/.test(rCss('.ranked-track')) && /color\.background\.neutral\.subtle/.test(rCss('.ranked-track')), 'bar track: 5px on neutral.subtle');
ok(/color\.background\.info\.track/.test(rCss('.ranked-bar')), 'bar fill: info.track');
ok(/tabular-nums/.test(rCss('.ranked-val')) && /line-clamp:\s*2/.test(rCss('.ranked-name')), 'tabular value, two-line clamped name');

const moves = [], picks = [];
const rTree = ui.RankedView({ rows, focus: 0, onFocusRow: (i) => moves.push(i), onSelect: (r) => picks.push(r.key) });
const btns = find(rTree, (n) => n.type === 'button');
const key = (b, k) => { let prevented = false; b.props.onKeyDown({ key: k, preventDefault: () => { prevented = true; } }); return prevented; };
ok(btns.map((b) => b.props.tabIndex).join() === '0,-1,-1', 'roving tabindex: only the focused row is tabbable');
ok(key(btns[0], 'ArrowDown') && moves.at(-1) === 1, 'ArrowDown moves to the next row');
key(btns[1], 'ArrowDown'); ok(moves.at(-1) === 2, 'ArrowDown again moves on');
key(btns[2], 'ArrowDown'); ok(moves.at(-1) === 2, 'ArrowDown on the last row stays put');
key(btns[2], 'ArrowUp'); ok(moves.at(-1) === 1, 'ArrowUp moves to the previous row');
key(btns[0], 'ArrowUp'); ok(moves.at(-1) === 0, 'ArrowUp on the first row stays put');
ok(key(btns[1], 'Enter') && picks.join() === 'b', 'Enter calls onSelect with that row (and prevents the duplicate click)');
const picked = [];
ui.RankedView({ rows, onSelect: (r) => picked.push(r) }).props.children[0].props.children.props.onKeyDown({ key: 'Enter', preventDefault() {} });
ok(picked[0] === rows[0], 'onSelect receives the row object itself');
key(btns[0], 'x'); ok(moves.length === 5 && picks.length === 1, 'other keys do nothing');
btns[2].props.onClick(); ok(picks.at(-1) === 'c', 'clicking a row selects it');

const act = html(h(ui.RankedView, { rows, activeKey: 'b' }));
ok((act.match(/ranked-active/g) ?? []).length === 1 && /class="ranked-row ranked-active"[^>]*aria-current="true"[^>]*>[\s\S]*?bravo/.test(act), 'the active row gets ranked-active (aria-current)');
ok(/color\.background\.accent\.default/.test(rCss('.ranked-row.ranked-active')), '.ranked-active uses color.background.accent.default');
ok(html(h(ui.Ranked, { rows, activeKey: 'b' })).includes('ranked-active'), 'Ranked (stateful) renders');

/* ── Drill (§6): span 4 + span 8, 140 ms fade behind reduced-motion, stacks below 1100 px ── */
const dHtml = html(h(ui.Drill, { rows, activeKey: 'a', detail: h('p', null, 'DETAIL') }));
ok(dHtml.indexOf('drill-list') > -1 && dHtml.indexOf('drill-list') < dHtml.indexOf('DETAIL') && dHtml.includes('drill-detail'), 'Drill: ranked list beside the detail');
ok(/grid-column:\s*span 4/.test(rCss('.drill-list')) && /grid-column:\s*span 8/.test(rCss('.drill-detail')), 'Drill: list span 4, detail span 8');
const cssNC = css.replace(/\/\*[\s\S]*?\*\//g, '');
const guard = cssNC.match(/@media\s*\(prefers-reduced-motion:\s*no-preference\)\s*\{([\s\S]*?\})\s*\}/g)?.find((b) => b.includes('.drill-detail')) ?? '';
ok(/\.drill-detail\s*\{[^}]*animation:[^;}]*140ms/.test(guard), 'the 140ms detail fade sits inside a prefers-reduced-motion guard');
ok(!/140ms/.test(cssNC.replace(guard, '')), 'no 140ms fade outside the guard (none under reduced motion)');
const stack = cssNC.match(/@media\s*\(max-width:\s*1100px\)\s*\{\s*\.drill-list[^}]*\}\s*\}/)?.[0] ?? '';
ok(/\.drill-detail/.test(stack) && /span 12/.test(stack), 'Drill stacks below 1100px');

/* ── tz-aware timestamps (F8) ── */
process.env.TZ = 'Asia/Kolkata';
const acts = (tz) => html(withScope({ earliest: '-24h', latest: 'now', tz }, h(charts.ActivityChart, { values: Array(48).fill(1), span: 1800, end: 1762698034, tolerance: 600 })));
const aLocal = acts('local'), aUtc = acts('utc');
ok(aLocal !== aUtc, 'switching tz to utc changes the rendered chart axis times');
ok(/>(13|0?1):\d\d/.test(aUtc) || /(13|14|0?1|0?2):\d\d/.test(aUtc), 'utc axis shows clock times');
ok(!/>0?(13|1):30/.test(aLocal) || aLocal !== aUtc, 'local axis differs from utc');
const wall = (tz) => html(withScope({ earliest: '-24h', latest: 'now', tz }, h(charts.GapReplay, { gaps: [], end: 1762698034, tol: 600, liveTol: 600 })));
ok(wall('local') !== wall('utc'), 'gap replay axis follows tz');

{ // time-zone footer (F7b)
  const { TzFooter } = mod; const { zoneInfo } = quickrange;
  const PS = { earliest: '-6h', latest: 'now', tz: 'local' };
  const zl = zoneInfo('local', 1762600000000), zu = zoneInfo('utc');
  const fl = html(h(TimeScopePicker, { scope: PS, nowS: 1762600000, onApply: () => {} }));
  ok(zl.iana === Intl.DateTimeFormat().resolvedOptions().timeZone && zl.short && fl.includes(zl.label), 'footer shows IANA zone and short name for the browser zone');
  ok(zu.label === 'UTC' && html(h(TzFooter, { tz: 'utc' })).includes('UTC (UTC)') === false && html(h(TzFooter, { tz: 'utc' })).includes('UTC'), 'footer shows UTC');
  const got = [];
  const rg = find(TzFooter({ tz: 'local', onTz: (z) => got.push(z) }), (n) => n.props?.name === 'ts-tz')[0];
  rg.props.onChange({ target: { value: 'utc' } }); rg.props.onChange({ target: { value: 'local' } });
  ok(JSON.stringify(got) === '["utc","local"]', 'Local/UTC switch calls onTz with utc then local');
  ok(html(withScope({ ...PS, tz: 'utc' }, h(tsc.TimeScope))).includes('>UTC<'), 'UTC scope: tz Tag shows UTC');
  ok(html(withScope(PS, h(tsc.TimeScope))).includes('>Local<'), 'local scope: tz Tag shows Local');
}

{ // F9b: past-range Alert, no-events text, incomplete history
  const past = { earliest: '-48h', latest: '-24h', tz: 'utc' }, live = { earliest: '-6h', latest: 'now', tz: 'utc' };
  const pg = (scope, timed = true) => html(withScope(scope, h(ui.Page, { crumbs: [{ label: 'X' }], timed }, 'BODY')));
  const hp = pg(past);
  ok(hp.includes('Viewing ') && hp.includes('. Asset status is live, as of now.') && hp.split('Asset status is live').length === 2, 'past range: exactly one info Alert');
  ok(!pg(live).includes('Asset status is live'), 'latest = now: no Alert');
  ok(!pg(past, false).includes('Asset status is live'), 'untimed page: no Alert');
  const ne = html(h(ui.ActivitySpark, { values: [0, 0, 0], silentS: 7200 }));
  ok(ne.includes('No events in this range · last seen 2.0 h ago') && !/never seen/i.test(ne), 'zero activity rows: no-events text, never "never seen"');
  ok(!html(h(ui.ActivitySpark, { values: [0, 2, 0], silentS: 5 })).includes('No events'), 'activity present: sparkline');
  ok(html(h(ui.SectionView, { title: 't', incomplete: true, children: 'c' })).includes('History incomplete for this range — narrow it'), 'truncated flag: History incomplete notice');
  ok(!html(h(ui.SectionView, { title: 't', incomplete: undefined, children: 'c' })).includes('History incomplete'), 'no flag (history missing): no notice, renders');
}

/* ── F10: delta Tags on the Incidents and Availability Metrics (spec 014 §5) ── */
{
  const { Tag, ArrowTrendUp, ArrowTrendDown, timescope: ts } = mod;
  const metric = (p) => ui.Metric({ label: 'Incidents, last 6 h', value: 3, ...p });
  const tags = (tree) => find(tree, (n) => n.type === Tag);
  const deltaTag = (tree, text) => tags(tree).find((t) => textOf(t) === text);

  const worse = ts.delta(3, 2, 'count'), better = ts.delta(1, 2, 'count'), flat = ts.delta(2, 2, 'count');
  const tw = deltaTag(metric({ delta: worse }), '+50%');
  ok(!!tw && tw.props.color === 'danger' && tw.props.icon === ArrowTrendUp, 'more incidents: +50%, danger, trend-up icon');
  const tb = deltaTag(metric({ delta: better }), '-50%');
  ok(!!tb && tb.props.color === 'success' && tb.props.icon === ArrowTrendDown, 'fewer incidents: -50%, success, trend-down icon');
  const tf = deltaTag(metric({ delta: flat }), '0%');
  ok(!!tf && tf.props.color === 'default' && tf.props.icon === undefined, 'flat: default colour, no trend icon');
  const au = deltaTag(metric({ delta: ts.delta(0.995, 0.99, 'ratio') }), '+0.5 pp');
  ok(!!au && au.props.color === 'success' && au.props.icon === ArrowTrendUp, 'availability up: +0.5 pp, success, trend-up');
  const ad = deltaTag(metric({ delta: ts.delta(0.98, 0.99, 'ratio') }), '-1.0 pp');
  ok(!!ad && ad.props.color === 'danger' && ad.props.icon === ArrowTrendDown, 'availability down: -1.0 pp, danger, trend-down');

  // The hint names the comparison.
  ok(ts.deltaHint({ from: 0, to: 6 * 3600 }) === 'vs previous 6 h', "6 h window: 'vs previous 6 h'");
  ok(ts.deltaHint({ from: 0, to: 48 * 3600 }) === 'vs previous 48 h', "48 h window: 'vs previous 48 h'");
  ok(ts.deltaHint({ from: 0, to: 1800 }) === 'vs previous 30 min', "30 min window: 'vs previous 30 min'");
  const withHint = html(h(ui.Metric, { label: 'I', value: 3, hint: '1 still open', delta: worse, deltaHint: 'vs previous 6 h' }));
  ok(withHint.includes('1 still open · vs previous 6 h') && withHint.includes('+50%'), "Metric hint reads '… · vs previous 6 h' with the Tag");
  ok(html(h(ui.Metric, { label: 'A', value: '99%', delta: au && ts.delta(0.995, 0.99, 'ratio'), deltaHint: 'vs previous 6 h' })).includes('vs previous 6 h'), 'hint-less Metric: the hint is the comparison');

  // No Tag: previous incidents 0, loading, truncated gaps, no ledger.
  const none = (tree) => tags(tree).length === 0;
  ok(ts.delta(3, 0, 'count') === undefined, 'delta() is undefined when the previous period had 0 incidents');
  const zeroPrev = metric({ delta: ts.delta(3, 0, 'count'), deltaHint: 'vs previous 6 h', hint: '1 still open' });
  ok(none(zeroPrev) && !html(h(ui.Metric, { label: 'I', value: 3, hint: '1 still open', delta: ts.delta(3, 0, 'count'), deltaHint: 'vs previous 6 h' })).includes('vs previous'),
    'previous incidents 0: no Tag and no comparison hint (never 0%)');
  ok(none(metric({ delta: worse, loading: true })), 'Metric loading: no delta Tag');
  ok(!ts.deltaHidden({ ledger: {}, histLoading: false, truncated: { gaps: false } }), 'ledger loaded, not truncated: deltas show');
  ok(ts.deltaHidden({ ledger: {}, histLoading: true, truncated: { gaps: false } }), 'history loading (range changed, gaps job pending): hidden');
  ok(ts.deltaHidden({ ledger: undefined, histLoading: false, truncated: { gaps: false } }), 'no ledger: hidden');
  ok(ts.deltaHidden({ ledger: {}, histLoading: false, truncated: { gaps: true } }), 'gaps series truncated: hidden');
  ok(!ts.deltaHidden({ ledger: {}, histLoading: false, truncated: { gaps: false, activity: true } }), 'only activity truncated: deltas still show');
  // The page wiring: `deltaHidden(pulse) ? undefined : delta(...)`.
  const pageDelta = (p) => (ts.deltaHidden(p) ? undefined : ts.delta(p.cur, p.prev, 'count'));
  for (const [why, p] of [['loading', { histLoading: true }], ['truncated', { truncated: { gaps: true } }], ['no ledger', { ledger: undefined }]]) {
    const st = { ledger: {}, histLoading: false, truncated: { gaps: false }, cur: 3, prev: 2, ...p };
    ok(none(metric({ delta: pageDelta(st) })), `Incidents Metric, ${why}: no Tag`);
  }
  ok(tags(metric({ delta: pageDelta({ ledger: {}, histLoading: false, truncated: { gaps: false }, cur: 3, prev: 2 }) })).length === 1, 'both periods known: one delta Tag');
  for (const f of ['src/pages/Incidents.tsx', 'src/pages/Overview.tsx']) {
    const s = readFileSync(join(root, f), 'utf8');
    ok(/deltaHidden\(pulse\)/.test(s) && /\bdelta\(/.test(s) && /deltaHint=\{/.test(s), `${f}: deltas gated by deltaHidden(pulse) and hinted`);
  }
  const st = readFileSync(join(root, 'src/state.tsx'), 'utf8');
  ok(/setHistLoading\(true\)/.test(st) && /setHistLoading\(false\)/.test(st) && /histLoading,/.test(st), 'state.tsx tracks and exposes histLoading');
}

/* ── ErrorBoundary fallback (spec 018) ── */
{
  const { ErrorBoundary, ErrorFallback, app } = mod;
  const boom = new Error('boom planted');
  const fb = html(h(ErrorBoundary, { error: boom }, h('p', null, 'CHILD')));
  ok(fb.includes('This page hit an error'), 'fallback shows the title');
  ok(fb.includes('boom planted'), 'fallback shows the error message');
  ok(fb.includes('Reload page'), 'fallback has a Reload page button');
  ok(/<a\b[^>]*href="\/"[^>]*>Go to Overview<\/a>/.test(fb), 'fallback links to / with "Go to Overview"');
  ok(!fb.includes('CHILD'), 'fallback replaces the children');
  ok(html(h(ErrorFallback, { error: boom })).includes('This page hit an error'), 'ErrorFallback renders on its own');
  ok(html(h(ErrorBoundary, null, h('p', null, 'CHILD'))) === html(h('p', null, 'CHILD')), 'a boundary with no error renders its children unchanged');
  const shellHtml = html(h(app.Shell));
  ok(['Overview', 'Settings', 'Documentation'].every((t) => shellHtml.includes(t)) && !shellHtml.includes('This page hit an error'),
    'the app shell (navigation) renders with the boundary in place');
}

console.log(fail ? `\nui tests: ${fail} failure(s)` : '\nui tests OK');
process.exit(fail ? 1 : 0);
