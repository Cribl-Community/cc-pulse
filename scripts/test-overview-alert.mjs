// Spec 034 F8: the Overview's "Snapshot not used" Alert, rendered for real.
// src/pages/Overview.tsx is bundled with esbuild; `usePulse` from '../state' is swapped for a fixture, and the Overview's
// `Alert` from '@capra/core' is wrapped (same component, props recorded) so the test can call the action's onClick.
// Run: node scripts/test-overview-alert.mjs   (also run by `npm test`)
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log(`FAIL ${msg}`); } };

const entry = join(root, 'node_modules/.tmp-overview-alert-entry.mjs');
const out = join(root, 'node_modules/.tmp-overview-alert-bundle.mjs');
writeFileSync(entry, [
  "export { Overview } from '../src/pages/Overview.tsx';",
  "export { reasonMessage } from '../src/lib/snapshot.ts';",
  "export { fmtDur } from '../src/lib/model.ts';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
  "export { MemoryRouter } from 'react-router-dom';",
  // T1: the real provider (its computeNow from src/lib/computeNow is swapped for a controllable fake below).
  "export { PulseProvider, usePulse as realUsePulse } from '../src/state.tsx';",
].join('\n'));
const fakes = {
  name: 'fake-state-and-alert',
  setup(b) {
    b.onResolve({ filter: /\/state$/ }, (a) => (a.importer.includes('/src/') ? { path: 'fake-state', namespace: 'fake' } : undefined));
    b.onResolve({ filter: /^@capra\/core$/ }, (a) => (a.namespace === 'file' && a.importer.endsWith('/src/pages/Overview.tsx') ? { path: 'spy-core', namespace: 'fake' } : undefined));
    b.onResolve({ filter: /\/lib\/computeNow$/ }, (a) => (a.importer.endsWith('/src/state.tsx') ? { path: 'fake-compute', namespace: 'fake' } : undefined));
    b.onLoad({ filter: /^fake-compute$/, namespace: 'fake' }, () => ({ loader: 'js', contents: 'export const computeNow = (s) => globalThis.__compute(s);' }));
    b.onLoad({ filter: /^fake-state$/, namespace: 'fake' }, () => ({ loader: 'js', contents: [
      "export const STATE_COLOR = { missing: 'danger', late: 'warning', delayed: 'warning', covered: 'info', acked: 'info', ok: 'success', learning: 'info', maintenance: 'default', muted: 'default' };",
      'export const usePulse = () => globalThis.__pulse;'].join('\n') }));
    b.onLoad({ filter: /^spy-core$/, namespace: 'fake' }, () => ({ loader: 'js', resolveDir: root, contents: [
      "export * from '@capra/core';",
      "import { Alert as RealAlert } from '@capra/core';",
      "import { createElement } from 'react';",
      'export const Alert = (p) => { globalThis.__alerts.push(p); return createElement(RealAlert, p); };'].join('\n') }));
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
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n)
  : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children));
let calls = 0;
const base = () => ({
  fleet: [], activity: undefined, heartbeat: undefined, inventory: {}, loading: false, error: undefined, updatedAt: new Date(), refresh: async () => {},
  settings: { learning: { LOOKBACK: '-24h' }, rollup: 'off' }, demo: false, truncated: undefined, setup: 'ready', newestDeployment: undefined,
  availability: undefined, prevAvailability: undefined, ledger: undefined, win: { from: 1_700_000_000 - 86_400, to: 1_700_000_000 }, entities: [], rules: [], clusters: {},
  stateSource: 'live', stateAsOf: undefined, stateReason: 'stale', stateAge: 3600, rollupVerdict: undefined,
  computeNow: async () => { calls++; },
});
const render = (over) => {
  globalThis.__alerts = [];
  globalThis.__pulse = { ...base(), ...over };
  const html = unescape(P.renderToStaticMarkup(P.h(P.MemoryRouter, { initialEntries: ['/'] }, P.h(P.Overview))));
  return { html, alert: globalThis.__alerts.find((p) => p.title === 'Snapshot not used') };
};

{ // (a) negative verdict, with an age
  const { html, alert } = render({});
  ok(html.includes('Snapshot not used'), '(a) markup shows the "Snapshot not used" Alert');
  ok(html.includes(P.reasonMessage('stale')), '(a) markup shows reasonMessage(stale)');
  ok(html.includes(P.fmtDur(3600)) && html.includes(`The last snapshot is ${P.fmtDur(3600)} old.`), '(a) markup shows the snapshot age fmtDur(3600)');
  ok(alert && alert.appearance === 'warning', '(a) the Alert is a warning');
  ok(alert && textOf(alert.children).includes(P.reasonMessage('stale')) && textOf(alert.children).includes(P.fmtDur(3600)), '(a) reason and age are inside the Alert');
  ok(textOf(alert?.action) === 'Compute now' && html.includes('Compute now'), '(a) the Alert action is "Compute now"');
  ok(alert?.action?.props?.pending === false, '(a) Compute now is not pending while nothing runs');
}
{ // (b) no snapshot at all
  const { html, alert } = render({ stateReason: 'empty', stateAge: undefined });
  ok(alert && html.includes('There is no snapshot yet.') && textOf(alert.children).includes(P.reasonMessage('empty')), '(b) stateAge undefined → "There is no snapshot yet." with the reason');
  ok(!html.includes('The last snapshot is'), '(b) no age line when there is no snapshot');
}
{ // (c) no Alert when the snapshot is used, there is no reason, or in demo mode
  for (const [over, what] of [[{ stateSource: 'snapshot', stateAsOf: 1_700_000_000 }, "stateSource 'snapshot'"],
    [{ stateReason: undefined }, 'no stateReason'], [{ demo: true }, 'demo mode']]) {
    const { html, alert } = render(over);
    ok(!alert && !html.includes('Snapshot not used') && !html.includes('Compute now'), `(c) ${what} → no Alert`);
  }
}
{ // (d) the action calls computeNow exactly once; rendering alone never calls it
  calls = 0;
  const { alert } = render({});
  ok(calls === 0, '(d) rendering does not call computeNow');
  alert.action.props.onClick();
  ok(calls === 1, '(d) Compute now calls computeNow exactly once');
}
{ // (e) T1: setup 'not-deployed' (a rejected snapshot leaves the entities empty) still shows the Alert, ahead of the empty state
  calls = 0;
  const { html, alert } = render({ setup: 'not-deployed' });
  const iAlert = html.indexOf('Snapshot not used'), iEmpty = html.indexOf("Pulse isn't watching anything yet");
  ok(alert && iAlert >= 0 && html.includes(P.reasonMessage('stale')) && html.includes(`The last snapshot is ${P.fmtDur(3600)} old.`), '(e) not-deployed + stateReason → the Alert with reason and age');
  ok(textOf(alert?.action) === 'Compute now' && html.includes('Compute now'), '(e) not-deployed + stateReason → Compute now');
  ok(iEmpty < 0 || iAlert < iEmpty, '(e) the Alert comes ahead of the not-deployed screen');
  alert?.action?.props?.onClick();
  ok(calls === 1, '(e) Compute now on the not-deployed screen calls computeNow once');
  const none = render({ setup: 'not-deployed', stateReason: undefined });
  ok(!none.alert && none.html.includes("Pulse isn't watching anything yet"), '(e) not-deployed without a reason → only the empty state');
}
{ // (f) T1: setup 'waiting' shows the Alert and not "Waiting for the first heartbeats" while the snapshot is rejected
  const { html, alert } = render({ setup: 'waiting' });
  ok(alert && html.includes(P.reasonMessage('stale')) && html.includes('Compute now'), '(f) waiting + stateReason → the Alert with Compute now');
  ok(!html.includes('Waiting for the first heartbeats'), '(f) waiting + stateReason → no "Waiting for the first heartbeats" Alert');
  const noAge = render({ setup: 'waiting', stateReason: 'empty', stateAge: undefined });
  ok(noAge.alert && noAge.html.includes('There is no snapshot yet.') && !noAge.html.includes('Waiting for the first heartbeats'), '(f) waiting + no snapshot → the Alert, no Waiting');
  const plain = render({ setup: 'waiting', stateReason: undefined });
  ok(!plain.alert && plain.html.includes('Waiting for the first heartbeats'), '(f) waiting without a reason → the Waiting Alert as before');
}
{ // (g) T1: while a compute runs the button is pending and a click does nothing
  calls = 0;
  const { alert } = render({ computing: true });
  ok(alert?.action?.props?.pending === true, '(g) computing → Compute now is pending');
  alert?.action?.props?.onClick();
  ok(calls === 0, '(g) computing → a click does not call computeNow');
}
{ // (h) T1: the reason messages no longer say Pulse reads live data; they say the snapshot can't be used and offer Compute now
  for (const r of ['no-search', 'disabled', 'exports', 'other-dataset', 'rollup', 'empty', 'truncated', 'stale', 'unknown-reason'])
    ok(!/live data/i.test(P.reasonMessage(r)), `(h) reasonMessage(${r}) does not say "live data"`);
  for (const r of ['rollup', 'empty', 'truncated', 'stale', 'unknown-reason'])
    ok(/can't be used/.test(P.reasonMessage(r)) && /Compute now runs .* once/.test(P.reasonMessage(r)), `(h) reasonMessage(${r}) says the snapshot can't be used and Compute now runs it once`);
}
{ // (i) T1: the provider's computeNow has an in-flight guard and clears stateReason/stateAge after a success
  let started = 0, release;
  globalThis.__compute = () => { started++; return new Promise((res) => { release = () => res([{ asset: 'a', input: 'in', worker_group: 'g' }]); }); };
  let ctx;
  const Grab = () => { ctx = P.realUsePulse(); return null; };
  P.renderToStaticMarkup(P.h(P.PulseProvider, null, P.h(Grab)));
  ok(typeof ctx?.computeNow === 'function' && ctx.computing === false, '(i) the provider exposes computeNow and computing (false at rest)');
  const first = ctx.computeNow();
  await new Promise((r) => setTimeout(r, 0));
  const second = ctx.computeNow();
  await new Promise((r) => setTimeout(r, 0));
  ok(started === 1, `(i) a second computeNow while one runs does nothing (started ${started})`);
  release?.(); await first; await second;
  const third = ctx.computeNow();
  await new Promise((r) => setTimeout(r, 0));
  ok(started === 2, `(i) once it settles, computeNow runs again (started ${started})`);
  release?.(); await third;
  const src = readFileSync(join(root, 'src/state.tsx'), 'utf8');
  const body = src.slice(src.indexOf('const computeNow = useCallback'), src.indexOf('}, [DEMO, settings])', src.indexOf('const computeNow = useCallback')));
  const ok1 = body.indexOf('setEntities(e)'), catchAt = body.indexOf('catch (err)');
  ok(ok1 > 0 && /setStateReason\(undefined\)/.test(body.slice(ok1, catchAt)) && /setStateAge\(undefined\)/.test(body.slice(ok1, catchAt)),
    '(i) a successful compute clears stateReason and stateAge (the Alert goes away)');
}
{ // the Alert is the only caller of computeNow in src/
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.tsx?$/.test(f)) files.push(p); } };
  walk(join(root, 'src'));
  const callers = files.flatMap((f) => [...readFileSync(f, 'utf8').matchAll(/\bcomputeNow\(\)/g)].map(() => f.slice(root.length + 1)));
  ok(callers.length >= 1 && callers.every((c) => c === 'src/pages/Overview.tsx'), `only Overview calls computeNow() (found: ${callers.join(', ') || 'none'})`);
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('test-overview-alert: ok');
