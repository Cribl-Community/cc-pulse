// T2: a rejected snapshot never leaves old rows on screen labelled Live.
// (1) rejectedRows (src/lib/snapshot.ts) as a table: dataset change / no rows → clear; same dataset → 'stale' with the
//     rows' own as-of. (2) state.tsx's rejected branch uses it, clears entities + updatedAt, and runs no entity search.
// (3) The Overview, rendered for real with a fixture usePulse: 'stale' says "From the last snapshot … old", not Live.
// Run: node scripts/test-rejected-stale.mjs   (also run by `npm test`)
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, msg) => { if (c) console.log(`✔ ${msg}`); else { fail++; console.log(`✖ ${msg}`); } };

const entry = join(root, 'node_modules/.tmp-rejected-stale-entry.mjs');
const out = join(root, 'node_modules/.tmp-rejected-stale-bundle.mjs');
writeFileSync(entry, [
  "export { Overview } from '../src/pages/Overview.tsx';",
  "export { rejectedRows } from '../src/lib/snapshot.ts';",
  "export { fmtDur } from '../src/lib/model.ts';",
  "export { formatTs } from '../src/lib/timefmt.ts';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
  "export { MemoryRouter } from 'react-router-dom';",
].join('\n'));
const fakes = {
  name: 'fake-state',
  setup(b) {
    b.onResolve({ filter: /\/state$/ }, (a) => (a.importer.includes('/src/') ? { path: 'fake-state', namespace: 'fake' } : undefined));
    b.onLoad({ filter: /^fake-state$/, namespace: 'fake' }, () => ({ loader: 'js', contents: [
      "export const STATE_COLOR = { missing: 'danger', late: 'warning', delayed: 'warning', covered: 'info', acked: 'info', ok: 'success', learning: 'info', maintenance: 'default', muted: 'default' };",
      'export const usePulse = () => globalThis.__pulse;'].join('\n') }));
  },
};
await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'error', outfile: out, plugins: [fakes],
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  define: { 'window.CRIBL_API_URL': '"http://pulse.test/api/v1"', 'window.CRIBL_BASE_PATH': '"/"', 'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}' },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' } });
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
let P;
try { P = await import(`${out}?t=${Date.now()}`); } finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }

// (1) rejectedRows
const asOf = 1_800_000_000;
ok(P.rejectedRows(undefined, 'cribl_logs').keep === false, '(1) no rows loaded → clear');
ok(P.rejectedRows({ dataset: 'cribl_logs', asOf }, 'cribl_parquet').keep === false, '(1) dataset changed since the rows were loaded → clear (no old dataset rows on screen)');
ok(P.rejectedRows({ dataset: 'cribl_logs', asOf }, undefined).keep === false, '(1) rows for a dataset, settings now have none → clear');
const st = P.rejectedRows({ dataset: 'cribl_logs', asOf }, 'cribl_logs');
ok(st.keep === true && st.source === 'stale' && st.asOf === asOf, "(1) same dataset → keep the rows, stateSource 'stale', stateAsOf of the rows");
ok(P.rejectedRows({ dataset: 'cribl_logs', asOf: NaN }, 'cribl_logs').keep === false, '(1) rows with no as-of time → clear');

// (2) state.tsx wiring (the provider's effects need a browser, so the branch is read from source)
const src = readFileSync(join(root, 'src/state.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const rej = src.slice(src.indexOf('reason = v.reason;'), src.indexOf('} catch (err)', src.indexOf('reason = v.reason;')));
ok(/const kept = rejectedRows\(rowsOrigin\.current, s\.dataset\)/.test(rej), '(2) the rejected branch asks rejectedRows with the settings dataset');
ok(/if \(kept\.keep\) \{ setStateSource\(kept\.source\); setStateAsOf\(kept\.asOf\); \}/.test(rej), "(2) kept → stateSource 'stale', stateAsOf of the rows (entities and updatedAt kept)");
ok(/else \{[^}]*setEntities\(\[\]\)[^}]*setUpdatedAt\(undefined\)[^}]*\}/.test(rej), '(2) otherwise → entities and updatedAt cleared');
ok(!/setStateSource\('live'\)/.test(rej.replace(/else \{[^}]*\}/, '')), "(2) the rejected branch only says 'live' when nothing is left on screen");
ok(!/computeEntities|runSearch|entityQuery/.test(rej), '(2) no entity search runs on a rejected verdict (spec 034 §4)');
ok(/setEntities\(rows\);[\s\S]{0,300}rowsOrigin\.current = \{ dataset: s\.dataset, asOf: v\.asOf \}/.test(src), '(2) a used snapshot records its dataset and as-of');
ok(/setEntities\(e\);[^\n]*rowsOrigin\.current = \{ dataset: settings\.dataset, asOf: nowS\(\) \}/.test(src), '(2) Compute now records its dataset and as-of');

// (3) the Overview source line
const unescape = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const base = () => ({
  fleet: [], activity: undefined, heartbeat: undefined, inventory: {}, loading: false, error: undefined, updatedAt: new Date(), refresh: async () => {},
  settings: { learning: { LOOKBACK: '-24h' }, rollup: 'off' }, demo: false, truncated: undefined, setup: 'ready', newestDeployment: undefined,
  availability: undefined, prevAvailability: undefined, ledger: undefined, win: { from: 1_700_000_000 - 86_400, to: 1_700_000_000 }, entities: [], rules: [], clusters: {},
  stateSource: 'live', stateAsOf: undefined, stateReason: undefined, stateAge: undefined, rollupVerdict: undefined, computeNow: async () => {}, computing: false,
});
const render = (over) => {
  globalThis.__pulse = { ...base(), ...over };
  return unescape(P.renderToStaticMarkup(P.h(P.MemoryRouter, { initialEntries: ['/'] }, P.h(P.Overview))));
};
const live = render({});
ok(live.includes('>Live<'), '(3) control: live rows say Live');
const rowsAsOf = Math.floor(Date.now() / 1000) - 1200;
const stale = render({ stateSource: 'stale', stateAsOf: rowsAsOf, stateReason: 'stale', stateAge: 1200 });
ok(stale.includes('From the last snapshot, as of '), "(3) 'stale' → the source line says the data is from the last snapshot");
ok(stale.includes(`· ${P.fmtDur(1200)} old`), `(3) 'stale' → the source line gives its age (${P.fmtDur(1200)} old)`);
ok(!stale.includes('>Live<'), "(3) 'stale' → not labelled Live");
ok(stale.includes('Snapshot not used') && stale.includes('Compute now'), "(3) 'stale' → the Snapshot not used Alert and Compute now still show");
const cleared = render({ stateSource: 'live', stateReason: 'other-dataset', updatedAt: undefined });
ok(!cleared.includes('>Live<'), '(3) cleared rows (no updatedAt) → no Live source line');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('test-rejected-stale: ok');
