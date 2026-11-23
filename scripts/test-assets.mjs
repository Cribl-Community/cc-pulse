#!/usr/bin/env node
// Tests for the Assets page filters (spec 013 §9, feature F8).
//  1. src/lib/assetFilters.ts (pure): URL params ⇄ filter state round-trip, and the filtering predicate.
//  2. src/pages/Assets.tsx rendered with react-dom/server inside a MemoryRouter at /assets?…, with `usePulse`
//     swapped for a fixture (esbuild plugin), so the URL alone decides which rows show and what the controls say.
// Run: node scripts/test-assets.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0, n = 0;
const ok = (cond, msg) => { n++; console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/* ---------- fixture ---------- */
const ent = (asset, input, state, extra = {}) => ({ key: `g|${input}|${asset}`, group: 'g', input, asset, state, raw: state, signal: '', silent_s: 60, tolerance_s: 900,
  gap_s: 60, active_min: 0, events: 1, events_1h: 1, vol_ratio: 1, max_lag_s: 0, lag_now_s: 0, min_lag_s: 0, key_src: 'host', maintenance: '', cluster: '',
  last_seen: 0, last_seen_utc: '', overridden: false, ...extra });
const fleet = [
  ent('fw-01', 'syslog:in_syslog:tcp', 'missing'),
  ent('fw-01', 'tcp:in_tcp', 'ok'),
  ent('db-02', 'syslog:in_syslog:tcp', 'ok', { key_src: 'ip' }),
  ent('web-03', 'http:in_http', 'late', { cluster: 'web-ha' }),
  ent('app-04', 'http:in_http', 'missing', { key_src: 'field:hostname' }),
  ent('lonely-05', 'tcp:in_tcp', 'ok'),
];
const inventory = {
  'fw-01': { team: 'netops', contact: 'alice@example.com', criticality: 1, tags: 'edge' },
  'db-02': { team: 'dba', criticality: 2, cluster: 'db-ha' },
  'web-03': { contact: 'bob' },
  'app-04': { team: 'netops' },
};

/* ---------- 1. pure functions ---------- */
const libOut = join(root, 'node_modules/.tmp-assets-lib.mjs');
await build({ entryPoints: [join(root, 'src/lib/assetFilters.ts')], bundle: true, platform: 'node', format: 'esm', logLevel: 'error', outfile: libOut });
const L = await import(`${libOut}?t=${Date.now()}`);
rmSync(libOut, { force: true });

{ // parse
  const f = L.parseFilters('state=missing&state=late&state=missing&crit=1&team=netops&owner=none&cluster=web-ha&source=in_http&identity=ip&q=fw&tab=x');
  ok(eq(f.state, ['missing', 'late']), 'parse: repeated state params select several values, duplicates dropped');
  ok(eq(f.crit, ['1']) && eq(f.team, ['netops']) && eq(f.owner, ['none']) && eq(f.cluster, ['web-ha']) && eq(f.source, ['in_http']) && eq(f.identity, ['ip']),
    'parse: crit, team, owner, cluster, source and identity are read');
  ok(f.q === 'fw', 'parse: q is read');
  ok(eq(L.parseFilters(''), L.emptyFilters()), 'parse: empty query → empty filters');
  ok(eq(L.parseFilters('state=&team=%20').state, []) && eq(L.parseFilters('team=%20').team, []), 'parse: blank values are ignored');
  ok(eq(L.parseFilters(new URLSearchParams('team=Net%20Ops')).team, ['Net Ops']), 'parse: accepts URLSearchParams and decodes values');
}
{ // serialise + round-trip
  const f = { ...L.emptyFilters(), q: 'edge box', state: ['missing'], team: ['a&b', 'c'], owner: ['none'], identity: ['field:hostname'] };
  const p = L.filtersToParams(f, 'tab=sources&state=ok');
  ok(p.get('tab') === 'sources', 'serialise: non-filter params are kept');
  ok(eq(p.getAll('state'), ['missing']), 'serialise: an existing filter param is replaced, not appended');
  ok(eq(L.parseFilters(p), f), 'round-trip: filters → URL → filters is identity (special characters included)');
  ok(eq(L.parseFilters(L.filtersToParams(L.emptyFilters())), L.emptyFilters()) && L.filtersToParams(L.emptyFilters()).toString() === '', 'round-trip: empty filters write an empty query');
  for (const qs of ['state=missing', 'team=netops', 'owner=none', 'crit=1&crit=none', 'cluster=web-ha&source=in_tcp&identity=ip', 'q=fw']) {
    ok(L.filtersToParams(L.parseFilters(qs)).toString() === new URLSearchParams(qs).toString(), `round-trip: ?${qs} → filters → ?${qs}`);
  }
  ok(L.filtersToParams(L.withFilter(L.emptyFilters(), 'state', [])).toString() === '', 'serialise: cleared filter disappears from the URL');
  ok(L.filtersToParams(L.withFilter(L.parseFilters('team=x'), 'q', 'ab ')).get('q') === 'ab ', 'serialise: q is kept as typed (trailing space while typing)');
  ok(L.activeCount(L.parseFilters('state=missing&owner=none&source=a&source=b')) === 3 && L.activeCount(L.parseFilters('state=missing&owner=none'), L.DRAWER_KEYS) === 1,
    'activeCount counts set filters (drawer only: Owner, HA cluster, Source, Identity)');
}
{ // predicate
  const rows = L.assetRows(fleet, inventory);
  const names = (qs) => L.filterAssets(rows, L.parseFilters(qs), inventory).map((r) => r.asset).sort();
  ok(rows.length === 5 && rows.find((r) => r.asset === 'fw-01').worst.state === 'missing', 'assetRows: one row per asset, worst state wins');
  ok(rows[0].asset === 'fw-01' && rows[1].asset === 'app-04', 'assetRows: missing first, then by criticality (P1 before unset)');
  ok(eq(names(''), ['app-04', 'db-02', 'fw-01', 'lonely-05', 'web-03']), 'no filter → every asset');
  ok(eq(names('state=missing'), ['app-04', 'fw-01']), 'state=missing → only missing assets');
  ok(eq(names('state=missing&state=late'), ['app-04', 'fw-01', 'web-03']), 'values within one filter are OR\'d');
  ok(eq(names('team=netops'), ['app-04', 'fw-01']), 'team=<t> → that team only');
  ok(eq(names('team=unassigned'), ['lonely-05', 'web-03']) && eq(names('team=none'), ['lonely-05', 'web-03']), 'team=unassigned (Overview card) / team=none → assets without a team');
  ok(eq(names('owner=none'), ['lonely-05']), 'owner=none → assets with neither team nor contact');
  ok(eq(names('owner=bob'), ['web-03']), 'owner=<contact> → that owner');
  ok(eq(names('crit=1'), ['fw-01']) && eq(names('crit=none'), ['app-04', 'lonely-05', 'web-03']), 'crit=1 and crit=none (not classified)');
  ok(eq(names('cluster=web-ha'), ['web-03']) && eq(names('cluster=db-ha'), ['db-02']), 'cluster: from the inventory or the heartbeat');
  ok(eq(names('source=in_tcp'), ['fw-01', 'lonely-05']), 'source matches any of the asset\'s sources');
  ok(eq(names('identity=ip'), ['db-02']) && eq(names('identity=field:hostname'), ['app-04']), 'identity matches the key_src rule');
  ok(eq(names('state=missing&team=netops&crit=1'), ['fw-01']), 'different filters are AND\'d');
  ok(eq(names('q=EDGE'), ['fw-01']) && eq(names('q=in_http'), ['app-04', 'web-03']) && eq(names('q=alice'), ['fw-01']), 'q: case-insensitive over name, tags, sources, owner');
  ok(eq(names('q=fw%20edge'), ['fw-01']) && eq(names('q=fw%20nothing'), []), 'q: every word must match');
  ok(eq(names('q=%20%20'), names('')), 'q: whitespace only matches everything');
  const team = L.optionValues(rows, inventory, 'team'), owner = L.optionValues(rows, inventory, 'owner');
  ok(eq(team, { values: ['dba', 'netops'], none: true }), 'optionValues(team): distinct sorted teams, plus "unassigned"');
  ok(eq(owner, { values: ['alice@example.com', 'bob'], none: true }), 'optionValues(owner): contacts, plus "none"');
}

/* ---------- 2. the page, driven by the URL ---------- */
const entry = join(root, 'node_modules/.tmp-assets-entry.mjs');
const out = join(root, 'node_modules/.tmp-assets-bundle.mjs');
writeFileSync(entry, [
  "export { Assets } from '../src/pages/Assets.tsx';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
  "export { MemoryRouter } from 'react-router-dom';",
].join('\n'));
const fakeState = {
  name: 'fake-state',
  setup(b) {
    b.onResolve({ filter: /\/state$/ }, (a) => (a.importer.includes('/src/') ? { path: 'fake-state', namespace: 'fake' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, () => ({ loader: 'js', contents: [
      "export const STATE_COLOR = { missing: 'danger', late: 'warning', delayed: 'warning', covered: 'info', acked: 'info', ok: 'success', learning: 'info', maintenance: 'default', muted: 'default' };",
      'export const usePulse = () => globalThis.__pulse;'].join('\n') }));
  },
};
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'error', outfile: out, plugins: [fakeState],
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  define: { 'window.CRIBL_API_URL': '"http://pulse.test/api/v1"', 'window.CRIBL_BASE_PATH': '"/"', 'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
let P;
try { P = await import(`${out}?t=${Date.now()}`); } finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }
globalThis.__pulse = { fleet, inventory, loading: false, updatedAt: new Date(), ledger: undefined, settings: { learning: { LOOKBACK: '-24h' } }, demo: true,
  error: undefined, refresh: async () => {}, rawInventory: inventory, setInventory: () => {}, clusters: {}, rules: [], entities: [] };
const at = (url) => P.renderToStaticMarkup(P.h(P.MemoryRouter, { initialEntries: [url] }, P.h(P.Assets)));
const ASSETS = ['fw-01', 'db-02', 'web-03', 'app-04', 'lonely-05'];
const rowsIn = (html) => ASSETS.filter((a) => html.includes(`href="/assets/${a}"`));
const tableOf = (html) => html.slice(html.indexOf('aria-label="Assets"'));
const toolbarOf = (html) => html.slice(html.indexOf('Filter assets'), html.indexOf('aria-label="Assets"'));
const drawerOf = (html) => html.slice(html.indexOf('data-placement="right"'));
const plain = at('/assets');

{
  const html = at('/assets');
  ok(eq(rowsIn(html).sort(), [...ASSETS].sort()), 'page /assets: every asset is listed');
  ok(/placeholder="Filter assets"/.test(html), 'page: FilterToolbar has a "Filter assets" input');
  for (const l of ['State', 'Criticality', 'Team', 'Filters']) ok(html.includes(`>${l}<`) || html.includes(`>${l} `) || html.includes(`${l}</`), `page: ${l} control is in the toolbar`);
  ok(html.includes('Actions for fw-01') && !/>Edit<\/button>/.test(tableOf(html)), 'page: Edit sits in a row overflow menu (no inline Edit button)');
  ok(html.includes('>--<'), 'page: empty cells render EMPTY_CELL_PLACEHOLDER (--)');
  ok(html.includes('class="cell-trunc"'), 'page: owner and source cells are truncating single-line spans');
  const links = [...tableOf(html).matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);
  ok(links.length === 5 && links.every((h) => h.startsWith('/assets/')), 'page: the only links in the table are the first column (asset)');
}
{
  const html = at('/assets?state=missing');
  ok(eq(rowsIn(html).sort(), ['app-04', 'fw-01']), 'page /assets?state=missing: only missing assets');
  ok(toolbarOf(html).includes('Missing') && !toolbarOf(plain).includes('Missing'), 'page ?state=missing: the State control shows "Missing" (absent without the filter)');
  ok(html.includes('2 of 5 assets match'), 'page ?state=missing: match count shown');
}
{
  const html = at('/assets?team=netops');
  ok(eq(rowsIn(html).sort(), ['app-04', 'fw-01']), 'page /assets?team=netops: only that team');
  ok(toolbarOf(html).includes('netops') && !toolbarOf(plain).includes('netops'), 'page ?team=netops: the Team control shows netops (absent without the filter)');
}
{
  const html = at('/assets?owner=none');
  ok(eq(rowsIn(html), ['lonely-05']), 'page /assets?owner=none: only assets nobody owns');
  ok(/Filters \(1\)/.test(html), 'page ?owner=none: the Filters button counts the drawer filter');
  ok(html.includes('data-inline="true"') && html.includes('data-placement="right"') && html.includes('data-open="true"'),
    'page ?owner=none: the Filters drawer is inline (pushes the table), on the right, and open');
  const drawer = html.slice(html.indexOf('data-placement="right"'));
  for (const l of ['Owner', 'HA cluster', 'Source', 'Identity']) ok(drawer.includes(l), `drawer holds the ${l} filter`);
  ok(drawer.includes('Nobody') && !drawerOf(at('/assets?source=in_tcp')).includes('Nobody'), 'drawer: the Owner control reflects owner=none ("Nobody")');
}
{
  const html = at('/assets?q=edge');
  ok(eq(rowsIn(html), ['fw-01']) && /value="edge"/.test(html), 'page /assets?q=edge: filtered, and the text input shows "edge"');
}

{ // every control writes the URL: the page keeps no filter state of its own
  const src = (await import('node:fs')).readFileSync(join(root, 'src/pages/Assets.tsx'), 'utf8');
  ok(/setParams\(filtersToParams\(/.test(src) && /useSearchParams\(\)/.test(src), 'page: filter changes are written with setParams(filtersToParams(…))');
  ok(!/useState(<[^>]*>)?\(\s*['"]\*?['"]\s*\)/.test(src) && (src.match(/onChange=\{\(v[^)]*\) => set\(/g) ?? []).length >= 1 && /onChange: \(v: string\) => set\('q', v\)/.test(src),
    'page: the text input and every pillter call set(), which updates the URL');
}

console.log(fail ? `assets: ${fail} of ${n} check(s) failed` : `assets: ${n} checks OK`);
process.exit(fail ? 1 : 0);
