// R1: a rejected snapshot with no rows on screen (on open, or after a dataset change) is a "snapshot gap". The pages other
// than the Overview must then say why and point to Compute now (on the Overview, its only caller), not "No assets yet", "No worker group yet", "<asset> has not
// sent anything … Pulse is not deployed" or a Set up Pulse CTA (setupState() alone reads 'waiting'/'not-deployed' then).
// The pages are bundled with esbuild and rendered for real; `usePulse` from '../state' is swapped for a fixture.
// Run: node scripts/test-snapshot-gap.mjs   (also run by `npm test`)
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0, n = 0;
const ok = (c, msg) => { n++; if (!c) { fail++; console.log(`FAIL ${msg}`); } };

const entry = join(root, 'node_modules/.tmp-snapshot-gap-entry.mjs');
const out = join(root, 'node_modules/.tmp-snapshot-gap-bundle.mjs');
writeFileSync(entry, [
  "export { Assets } from '../src/pages/Assets.tsx';",
  "export { Groups, GroupDetail } from '../src/pages/Groups.tsx';",
  "export { Asset } from '../src/pages/Asset.tsx';",
  "export { Identity } from '../src/pages/Identity.tsx';",
  "export { Incidents } from '../src/pages/Incidents.tsx';",
  "export { GAP_POINTER } from '../src/components/SnapshotGap.tsx';",
  "export { reasonMessage, snapshotGap, SNAPSHOT_GAP_TITLE } from '../src/lib/snapshot.ts';",
  "export { setupState } from '../src/lib/setup.ts';",
  "export { fmtDur } from '../src/lib/model.ts';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
  "export { MemoryRouter, Routes, Route } from 'react-router-dom';",
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

const unescape = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const base = () => ({
  fleet: [], entities: [], sources: [], activity: undefined, heartbeat: undefined, inventory: {}, rawInventory: {}, rules: [], clusters: {}, windows: [],
  loading: false, error: undefined, updatedAt: undefined, refresh: async () => {}, reloadSetup: async () => {},
  settings: { learning: { LOOKBACK: '-24h' }, rollup: 'off', refresh: 'manual' }, ai: {}, demo: false, truncated: undefined,
  setup: 'not-deployed', newestDeployment: undefined, incidents: [], prevIncidents: [], availability: undefined, prevAvailability: undefined,
  ledger: undefined, histLoading: false, win: { from: 1_700_000_000 - 86_400, to: 1_700_000_000 }, prevWin: { from: 1_700_000_000 - 172_800, to: 1_700_000_000 - 86_400 },
  actSpan: 3600, actBins: 24, stateSource: 'live', stateAsOf: undefined, stateReason: 'stale', stateAge: 3600, rollupVerdict: undefined,
  computing: false, computeNow: async () => {}, applyOverride: () => {}, applyWindows: async () => {},
});
const pages = [
  { name: 'Assets', path: '/assets', route: '/assets', el: () => P.Assets, wrong: ['No assets yet', 'Set up Pulse'] },
  { name: 'Groups', path: '/groups', route: '/groups', el: () => P.Groups, wrong: ['No worker group yet', 'Set up Pulse'] },
  { name: 'GroupDetail', path: '/groups/prod-eu', route: '/groups/:group', el: () => P.GroupDetail, wrong: ['Pulse is not deployed there'] },
  { name: 'Asset', path: '/assets/fw-01', route: '/assets/:asset', el: () => P.Asset, wrong: ['has not sent anything', 'Pulse is not deployed on its source'] },
  { name: 'Identity', path: '/identity', route: '/identity', el: () => P.Identity, wrong: ['No source yet', 'Set up Pulse'] },
  { name: 'Incidents', path: '/incidents', route: '/incidents', el: () => P.Incidents, wrong: ['Every silence stayed within its learned tolerance', 'Set up Pulse'] },
];
const render = (pg, over) => {
  globalThis.__pulse = { ...base(), ...over };
  return unescape(P.renderToStaticMarkup(P.h(P.MemoryRouter, { initialEntries: [pg.path] },
    P.h(P.Routes, null, P.h(P.Route, { path: pg.route, element: P.h(pg.el()) })))));
};

// The pure verdict.
ok(P.snapshotGap({ demo: false, stateReason: 'stale', stateSource: 'live', fleetCount: 0 }), 'gap: rejected, rows cleared');
ok(!P.snapshotGap({ demo: false, stateReason: 'stale', stateSource: 'stale', fleetCount: 3 }), 'no gap: stale rows still on screen');
ok(!P.snapshotGap({ demo: false, stateReason: undefined, stateSource: 'live', fleetCount: 0 }), 'no gap: snapshot not rejected (truly empty)');
ok(!P.snapshotGap({ demo: false, stateReason: 'stale', stateSource: 'snapshot', fleetCount: 0 }), 'no gap: snapshot in use');
ok(!P.snapshotGap({ demo: true, stateReason: 'stale', stateSource: 'live', fleetCount: 0 }), 'no gap: demo');
// What the finding saw: setupState alone reads 'not-deployed' / 'waiting' in the gap, so pages can't rely on it.
ok(P.setupState({ demo: false, deployments: [], fleetCount: 0, loading: false }) === 'not-deployed', 'setupState is not-deployed with no rows and no record');
ok(P.setupState({ demo: false, deployments: [{ group: 'g' }], fleetCount: 0, loading: false }) === 'waiting', 'setupState is waiting with no rows and a record');

for (const pg of pages) {
  for (const setup of ['not-deployed', 'waiting']) {
    for (const [reason, age] of [['stale', 3600], ['no-search', undefined], ['other-dataset', 120]]) {
      const html = render(pg, { setup, stateReason: reason, stateAge: age });
      const tag = `${pg.name} (${setup}, ${reason})`;
      ok(html.includes(P.SNAPSHOT_GAP_TITLE), `${tag}: shows "${P.SNAPSHOT_GAP_TITLE}"`);
      ok(html.includes(P.reasonMessage(reason)), `${tag}: shows why the snapshot was not used`);
      ok(html.includes(age !== undefined ? `The last snapshot is ${P.fmtDur(age)} old.` : 'There is no snapshot yet.'), `${tag}: shows the snapshot age`);
      ok(html.includes(P.GAP_POINTER), `${tag}: points to Compute now on the Overview`);
      ok(html.includes('Go to Overview'), `${tag}: offers a Go to Overview button`);
      for (const w of pg.wrong) ok(!html.includes(w), `${tag}: does not say "${w}"`);
    }
  }
  // Not a gap: a truly empty fleet keeps each page's own empty state (and its Set up Pulse CTA when not deployed).
  const html = render(pg, { setup: 'not-deployed', stateReason: undefined, stateAge: undefined });
  ok(!html.includes(P.SNAPSHOT_GAP_TITLE) && !html.includes('Go to Overview'), `${pg.name} (no rejection): no gap notice`);
  ok(html.includes(pg.wrong[0]), `${pg.name} (no rejection): keeps "${pg.wrong[0]}"`);
}

// The pointer leads to the Overview (the Snapshot not used Alert and its Compute now); nothing is computed on these pages.
{
  let calls = 0;
  for (const pg of pages) render(pg, { computeNow: async () => { calls++; } });
  ok(calls === 0, 'rendering a page in the gap never runs computeNow');
  const src = ['SnapshotGap.tsx', 'useSnapshotGap.tsx'].map((f) => readFileSync(join(root, 'src/components', f), 'utf8')).join('\n');
  ok(/navigate\('\/'\)/.test(src) && !/computeNow\(/.test(src), 'the gap CTA navigates to the Overview ("/") and never calls computeNow');
}

if (fail) { console.log(`test-snapshot-gap: ${fail} of ${n} checks failed`); process.exit(1); }
console.log(`test-snapshot-gap: all ${n} checks passed`);
