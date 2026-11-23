#!/usr/bin/env node
// F5: confirmRows, laneViews, and FleetRunner. Renders with react-dom/server the way scripts/test-nav.mjs does.
// Capra and plan.ts are swapped only for FleetRunner so the test can call the Modal handlers the component passed
// and the Button handlers it rendered. Run: node scripts/test-fleet-runner.mjs
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'node_modules/.tmp-fleet-runner-entry.mjs');
const out = join(root, 'node_modules/.tmp-fleet-runner-bundle.mjs');

const CORE = `
import { createElement as h } from 'react';
function bag() {
  return (globalThis.__capra ??= { alerts: [], buttons: [], modals: [], cancels: [] });
}
export function Alert(p) { bag().alerts.push(p); return h('div', { role: 'status' }, p.title, p.children); }
export function Text(p) { return h('span', null, p.children); }
export function Button(p) { bag().buttons.push(p); return h('button', { type: 'button' }, p.children); }
export function Table(p) {
  bag().tables = bag().tables ?? [];
  bag().tables.push(p);
  const hdr = (p.columns ?? []).map((c) => c.label).join(' ');
  const body = (p.items ?? []).map((item) => (p.columns ?? []).map((c) => item[c.id]).join(' ')).join(' ');
  return h('table', null, hdr, body);
}
export function Modal(p) {
  const b = bag();
  b.modals.push(p);
  const cancel = () => p.onClose?.();
  b.cancels.push(cancel);
  if (!p.isOpen) return null;
  return h('div', { role: 'dialog' }, p.title, p.children,
    h('button', { type: 'button', onClick: () => p.onConfirm?.() }, p.confirmButtonText),
    h('button', { type: 'button', onClick: cancel }, p.cancelButtonText));
}
`;

const PLAN = `
export async function runAll(steps, seed, onChange) {
  const bag = globalThis.__plan;
  bag.calls.push({ fn: 'runAll', steps, seed, onChange });
  if (bag.gate) await bag.gate;
  return { failed: bag.failed ?? [], state: bag.nextState ?? seed };
}
export async function retryLane(steps, state, lane, onChange) {
  const bag = globalThis.__plan;
  bag.calls.push({ fn: 'retryLane', steps, state, lane, onChange });
  if (bag.gate) await bag.gate;
  return { failed: [], state: bag.nextState ?? state };
}
export function skipLane(steps, state, lane, onChange) {
  globalThis.__plan.calls.push({ fn: 'skipLane', steps, state, lane, onChange });
  return state;
}
`;

writeFileSync(entry, [
  "export { confirmRows, laneViews } from '../src/lib/fleetRun.ts';",
  "export { FleetRunner } from '../src/components/FleetRunner.tsx';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
].join('\n'));

const plugin = {
  name: 'fleet-runner-fakes',
  setup(b) {
    b.onResolve({ filter: /^@capra\/core$/ }, (args) => (
      args.importer.endsWith('FleetRunner.tsx') ? { path: 'spy-core', namespace: 'fake' } : undefined));
    b.onResolve({ filter: /\/plan$/ }, (args) => (
      args.importer.endsWith('FleetRunner.tsx') ? { path: 'spy-plan', namespace: 'fake' } : undefined));
    b.onLoad({ filter: /.*/, namespace: 'fake' }, (args) => {
      if (args.path === 'spy-core') return { loader: 'js', resolveDir: root, contents: CORE };
      if (args.path === 'spy-plan') return { loader: 'js', resolveDir: root, contents: PLAN };
    });
  },
};

await build({
  entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'error', outfile: out, plugins: [plugin],
  loader: { '.css': 'empty', '.svg': 'empty', '.png': 'empty' },
  define: {
    'window.CRIBL_API_URL': '"http://pulse.test/api/v1"',
    'window.CRIBL_BASE_PATH': '"/"',
    'process.env.NODE_ENV': '"production"',
    'import.meta.env': '{"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  },
  banner: { js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);' },
});

let P;
try { P = await import(`${out}?t=${Date.now()}`); }
finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const textOf = (n) => (n == null || typeof n === 'boolean' ? '' : typeof n === 'string' || typeof n === 'number' ? String(n)
  : Array.isArray(n) ? n.map(textOf).join('') : textOf(n.props?.children));
const unescape = (s) => s.replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const fleetSrc = readFileSync(join(root, 'src/lib/fleetRun.ts'), 'utf8');
const runnerSrc = readFileSync(join(root, 'src/components/FleetRunner.tsx'), 'utf8');
const imports = fleetSrc.match(/^import .+$/gm) ?? [];
ok(imports.length > 0 && imports.every((line) => line.startsWith('import type ')), 'fleetRun.ts uses import type only');
ok(!/from ['"]\.\/api['"]/.test(fleetSrc), 'fleetRun.ts does not import api.ts');
ok((runnerSrc.match(/^export /gm) ?? []).length === 1 && /export function FleetRunner\(/.test(runnerSrc), 'FleetRunner.tsx exports only a component');

const step = (id, title) => ({ id, title, detail: id, run: async () => { throw new Error(`step ${id} should not run`); } });

/* ── confirmRows ── */
const pack = step('prod-us/pack', 'Install / upgrade pack cribl-pulse 1.3.0');
const dest = step('prod-us/dest', 'Destination pulse_lake');
const route = step('prod-us/route', 'Route pulse_observer');
const dmzPack = step('dmz/pack', 'Install / upgrade pack cribl-pulse 1.3.0');
const dmzDest = step('dmz/dest', 'Destination pulse_lake');
const dmzRoute = step('dmz/route', 'Route pulse_observer');
const searchSteps = [
  step('search/pulse_state', 'Saved search pulse_state'),
  step('search/pulse_gaps', 'Saved search pulse_gaps'),
  step('search/pulse_state_route_slack', 'Route slack on pulse_state'),
  step('search/lookup', 'Lookup pulse_overrides.csv'),
  step('search/assets', 'Lookup pulse_assets.csv'),
  step('search/maint', 'Lookup pulse_maintenance.csv'),
];
const lanes = [
  { id: 'prod-us', title: 'prod-us', steps: [pack, dest, route] },
  { id: 'dmz', title: 'dmz', steps: [dmzPack, dmzDest, dmzRoute] },
  { id: 'same', title: 'same', steps: [], unchanged: 'up to date' },
  { id: 'search', title: 'Search alerts', steps: searchSteps },
];
const targets = [
  { group: 'prod-us', mode: 'selected', inputs: ['syslog:a', 'syslog:b'], installed: '1.2.0' },
  { group: 'dmz', mode: 'all', inputs: [], installed: '' },
];
const rows = P.confirmRows(lanes, targets, 'pulse_lake');
const prod = rows.find((r) => r.where === 'prod-us');
const dmz = rows.find((r) => r.where === 'dmz');
const search = rows.find((r) => r.where === 'Cribl Search');
ok(rows.length === 3 && !rows.some((r) => r.where === 'same'), 'confirmRows skips a lane with no steps');
ok(prod?.text === 'pack cribl-pulse 1.2.0 \u2192 1.3.0 \u00b7 destination pulse_lake created or updated \u00b7 route pulse_observer added or overwritten (2 sources)',
  `prod-us names the pack transition, destination, and pulse_observer source count (got ${prod?.text})`);
ok(dmz?.text === 'pack cribl-pulse 1.3.0 installed \u00b7 destination pulse_lake created or updated \u00b7 route pulse_observer added or overwritten (all sources)',
  `missing installed and mode all (got ${dmz?.text})`);
ok(search?.text === '2 saved searches and their notifications overwritten, 3 lookups republished',
  `search row counts Saved search steps and the three lookup ids (got ${search?.text})`);

/* T6: the shared Storage lane names the Lake dataset and the _5m rollup dataset it creates. */
const sharedLanes = [
  { id: 'shared', title: 'Storage', steps: [
    step('shared/dataset', 'Lake dataset pulse_metrics_pq'),
    step('shared/dataset5m', 'Lake dataset pulse_metrics_pq_5m'),
  ] },
  ...lanes,
];
const sharedRows = P.confirmRows(sharedLanes, targets, 'pulse_lake');
const storage = sharedRows.find((r) => r.where === 'Storage');
ok(sharedRows.length === 4 && sharedRows[0] === storage, 'confirmRows lists the shared Storage lane first');
ok(storage?.text === 'Lake dataset pulse_metrics_pq created if missing · 5-minute rollup dataset pulse_metrics_pq_5m created if missing',
  `shared row names the Lake dataset and its _5m rollup (got ${storage?.text})`);
ok(/pulse_metrics_pq(?!_5m)/.test(storage?.text ?? '') && /pulse_metrics_pq_5m/.test(storage?.text ?? ''),
  'shared row text is not empty and names both datasets');
const rawOnly = P.confirmRows([{ id: 'shared', title: 'Storage', steps: [step('shared/dataset', 'Lake dataset custom_ds')] }], [], 'd');
ok(rawOnly[0]?.text === 'Lake dataset custom_ds created if missing', `shared row with only the raw dataset step (got ${rawOnly[0]?.text})`);

/* T6: Strict mode only lists pack items whose child path is granted too (spec 016). */
const policiesSrc = readFileSync(join(root, 'config/policies.yml'), 'utf8');
ok(/object: '\/m\/\*\/p\/\*\/system\/inputs\/\*', actions: \['GET'\]/.test(policiesSrc), "policies grant GET on '/m/*/p/*/system/inputs/*'");
ok(/object: '\/m\/\*\/p\/\*\/routes\/\*', actions: \['GET'\]/.test(policiesSrc), "policies grant GET on '/m/*/p/*/routes/*'");

/* ── laneViews ── */
const flat = [...lanes.flatMap((l) => l.steps)];
const viewsOf = (status) => P.laneViews(lanes, flat, status);
const idle = viewsOf({});
ok(idle.find((v) => v.id === 'same')?.phase === 'unchanged' && idle.find((v) => v.id === 'same')?.retry === false, 'unchanged lane stays unchanged');
ok(idle.find((v) => v.id === 'prod-us')?.phase === 'idle' && idle.find((v) => v.id === 'prod-us')?.retry === false, 'no statuses is idle, without retry');
ok(idle.find((v) => v.id === 'search')?.name === 'search', 'search lane is named search');
const failedViews = viewsOf({ 'prod-us/route': { s: 'failed', msg: 'no' }, 'prod-us/dest': { s: 'skipped' } });
const failedProd = failedViews.find((v) => v.id === 'prod-us');
ok(failedProd?.name === 'prod-us' && failedProd?.phase === 'failed' && failedProd?.retry === true && failedProd?.skip === true, 'failed prod-us offers retry and skip');
ok(viewsOf({ 'prod-us/pack': { s: 'running' } }).find((v) => v.id === 'prod-us')?.phase === 'running', 'a running step is running');
ok(viewsOf({ 'prod-us/pack': { s: 'done' }, 'prod-us/dest': { s: 'done' }, 'prod-us/route': { s: 'done' } }).find((v) => v.id === 'prod-us')?.phase === 'done', 'every step done');
ok(viewsOf({ 'dmz/pack': { s: 'skipped' }, 'dmz/dest': { s: 'skipped' }, 'dmz/route': { s: 'skipped' } }).find((v) => v.id === 'dmz')?.phase === 'skipped' &&
  viewsOf({ 'dmz/pack': { s: 'skipped' } }).find((v) => v.id === 'dmz')?.retry === false, 'skipped is not retryable');
const blockedByLake = viewsOf({
  'prod-us/pack': { s: 'done', msg: 'installed' },
  'prod-us/dest': { s: 'skipped', msg: 'skipped: needs \u201cLake dataset pulse_metrics_pq\u201d' },
  'prod-us/route': { s: 'skipped', msg: 'skipped: needs \u201cDestination pulse_lake\u201d' },
});
const blockedProd = blockedByLake.find((v) => v.id === 'prod-us');
ok(blockedProd?.phase === 'failed' && blockedProd?.retry === true && blockedProd?.skip === true,
  'a group blocked by a failed Lake step offers Retry and Skip');
const runningAndFailed = viewsOf({ 'prod-us/pack': { s: 'running' }, 'prod-us/route': { s: 'failed' } }).find((v) => v.id === 'prod-us');
ok(runningAndFailed?.phase === 'running' && runningAndFailed?.retry === false, 'retry is false unless the phase is failed');

/* ── render FleetRunner ── */
globalThis.__plan = { calls: [], gate: null, nextState: {}, failed: [] };
const noop = () => {};
const render = (props) => {
  globalThis.__capra = { alerts: [], buttons: [], modals: [], cancels: [], tables: [] };
  let seen = [];
  const html = unescape(P.renderToStaticMarkup(P.h(P.FleetRunner, {
    children: (views) => { seen = views; return null; },
    ...props,
  })));
  return {
    html, seen, modal: globalThis.__capra.modals.at(-1), buttons: globalThis.__capra.buttons,
    alerts: globalThis.__capra.alerts, tables: globalThis.__capra.tables, cancel: globalThis.__capra.cancels.at(-1),
  };
};

{ // open: the modal lists every row and the overwrite warning, and does not run
  globalThis.__plan.calls = [];
  const { html, modal, alerts, tables } = render({ lanes, steps: flat, rows, open: true, onClose: noop });
  ok(modal?.isOpen === true, 'open true passes isOpen to Modal');
  ok(modal?.title === 'Deploy Pulse to 2 worker groups and Cribl Search?', `modal title (got ${modal?.title})`);
  for (const row of rows) ok(html.includes(row.where) && html.includes(row.text), `modal contains ${row.where}`);
  ok(html.includes('These changes are written to Cribl configuration. Each group is committed and deployed to its workers.'),
    'modal explains that changes are written to Cribl configuration');
  ok(html.includes('Where') && html.includes('What changes'), 'modal has Where and What changes table headers');
  ok(tables.some((t) => t.columns?.some((c) => c.label === 'Where') && t.columns?.some((c) => c.label === 'What changes')),
    'confirm table columns are Where and What changes');
  ok(html.includes('Overwrites are not undone automatically'), 'modal contains the overwrite warning');
  ok(alerts.some((a) => textOf(a.title).includes('Overwrites are not undone automatically')), 'the warning Alert title');
  ok(alerts.some((a) => textOf(a.children).includes('A failed group stops on its own')), 'the warning Alert body');
  ok(globalThis.__plan.calls.length === 0, 'rendering the modal does not call runAll');
}

{ // mockup B: deploy titles from lanes that have steps (confirmRows / ticks omit the rest)
  const titleOf = (laneList, rowList = rows) => render({ lanes: laneList, steps: flat, rows: rowList, open: true, onClose: noop }).modal?.title;
  const threeGroups = [
    { id: 'a', title: 'a', steps: [pack] },
    { id: 'b', title: 'b', steps: [dmzPack] },
    { id: 'c', title: 'c', steps: [route] },
    { id: 'search', title: 'Search alerts', steps: searchSteps },
  ];
  ok(titleOf(threeGroups) === 'Deploy Pulse to 3 worker groups and Cribl Search?', 'three group lanes plus search');
  ok(titleOf([lanes[0], lanes[3]]) === 'Deploy Pulse to 1 worker group and Cribl Search?', 'one group lane plus search');
  ok(titleOf([lanes[0], lanes[1]]) === 'Deploy Pulse to 2 worker groups?', 'groups without search omit Cribl Search');
  ok(titleOf([lanes[3]]) === 'Deploy Cribl Search?', 'search lane only');
  ok(titleOf([lanes[2]]) === 'Deploy everything?', 'no lanes with steps keeps Deploy everything?');
}

{ // cancel and onClose do not call runAll; confirm calls it with the same step objects, then onPhase and onDone
  globalThis.__plan.calls = [];
  let closed = 0;
  const { modal } = render({ lanes, steps: flat, rows, open: true, onClose: () => { closed++; } });
  modal.onClose();
  ok(closed === 1 && globalThis.__plan.calls.length === 0, 'onClose does not call runAll');
  const { cancel } = render({ lanes, steps: flat, rows, open: true, onClose: () => { closed++; } });
  cancel();
  ok(closed === 2 && globalThis.__plan.calls.every((c) => c.fn !== 'runAll'), 'cancel button calls onClose and does not call runAll');

  let release;
  globalThis.__plan.gate = new Promise((r) => { release = r; });
  globalThis.__plan.nextState = { 'prod-us/deploy': { s: 'done' } };
  const order = [];
  const { modal: confirmModal } = render({
    lanes, steps: flat, rows, open: true, onClose: noop,
    onPhase: (s) => order.push(['phase', s]),
    onDone: () => order.push(['done']),
  });
  const pending = confirmModal.onConfirm();
  ok(pending instanceof Promise, 'confirm returns the run promise');
  const ran = globalThis.__plan.calls.filter((c) => c.fn === 'runAll');
  ok(ran.length === 1 && ran[0].steps === flat && flat.every((s, i) => ran[0].steps[i] === s), 'confirm calls runAll with the same step objects');
  ok(order.length === 0, 'onPhase and onDone wait until runAll resolves');
  release();
  await pending;
  ok(order.length === 2 && order[0][0] === 'phase' && order[0][1] === globalThis.__plan.nextState && order[1][0] === 'done',
    'onPhase then onDone when the promise resolves');
  globalThis.__plan.gate = null;
}

{ // open false, prod-us/deploy already failed: FleetRunner's own buttons, and they call retryLane / skipLane
  globalThis.__plan.calls = [];
  globalThis.__plan.gate = null;
  const deploy = step('prod-us/deploy', 'Deploy');
  const record = step('prod-us/record', 'Record deployment');
  const group = { id: 'prod-us', title: 'prod-us', steps: [deploy, record] };
  const { html, seen, buttons } = render({
    lanes: [group], steps: [deploy, record], rows: [], open: false,
    status: { 'prod-us/deploy': { s: 'failed', msg: 'deploy failed' }, 'prod-us/record': { s: 'skipped' } },
    onClose: noop,
  });
  ok(html.includes('Retry prod-us') && html.includes('Skip prod-us'), 'open false with a failed prod-us/deploy shows Retry prod-us and Skip prod-us');
  ok(seen.some((v) => v.id === 'prod-us' && v.name === 'prod-us' && v.phase === 'failed' && v.retry && v.skip), 'children receive the failed prod-us view');
  const retryBtn = buttons.find((b) => b.children === 'Retry prod-us');
  const skipBtn = buttons.find((b) => b.children === 'Skip prod-us');
  ok(retryBtn && skipBtn, 'Retry and Skip are the buttons FleetRunner rendered');
  retryBtn.onClick();
  const retried = globalThis.__plan.calls.filter((c) => c.fn === 'retryLane');
  ok(retried.length === 1 && retried[0].lane === 'prod-us' && retried[0].steps[0] === deploy, 'Retry prod-us calls retryLane for lane id prod-us');
  skipBtn.onClick();
  const skipped = globalThis.__plan.calls.filter((c) => c.fn === 'skipLane');
  ok(skipped.length === 1 && skipped[0].lane === 'prod-us' && skipped[0].steps[1] === record, 'Skip prod-us calls skipLane for lane id prod-us');
  ok(!globalThis.__plan.calls.some((c) => c.fn === 'runAll'), 'Retry and Skip do not call runAll');
}

{ // a group skipped because Lake failed still shows Retry and Skip, and they target that group
  globalThis.__plan.calls = [];
  globalThis.__plan.gate = null;
  const dataset = step('shared/dataset', 'Lake dataset');
  const packStep = step('prod-us/pack', 'Install pack');
  const destStep = step('prod-us/dest', 'Destination');
  const routeStep = step('prod-us/route', 'Route');
  const shared = { id: 'shared', title: 'Storage', steps: [dataset] };
  const group = { id: 'prod-us', title: 'prod-us', steps: [packStep, destStep, routeStep] };
  const { html, seen } = render({
    lanes: [shared, group], steps: [dataset, packStep, destStep, routeStep], rows: [], open: false,
    status: {
      'shared/dataset': { s: 'failed', msg: 'dataset failed' },
      'prod-us/pack': { s: 'done', msg: 'installed' },
      'prod-us/dest': { s: 'skipped', msg: 'skipped: needs \u201cLake dataset\u201d' },
      'prod-us/route': { s: 'skipped', msg: 'skipped: needs \u201cDestination\u201d' },
    },
    onClose: noop,
  });
  ok(html.includes('Retry prod-us') && html.includes('Skip prod-us'), 'a Lake-blocked group shows Retry prod-us and Skip prod-us');
  ok(seen.some((v) => v.id === 'prod-us' && v.phase === 'failed' && v.retry && v.skip), 'children see the blocked group as failed');
  const retryBtn = globalThis.__capra.buttons.find((b) => b.children === 'Retry prod-us');
  retryBtn.onClick();
  const retried = globalThis.__plan.calls.filter((c) => c.fn === 'retryLane');
  ok(retried.length === 1 && retried[0].lane === 'prod-us' && retried[0].steps.includes(destStep), 'Retry prod-us retries that group, including the skipped destination');
}

{ // a recorded run must not keep the next Deploy everything from opening, and an empty plan must still close
  globalThis.__plan.calls = [];
  globalThis.__plan.gate = null;
  globalThis.__plan.nextState = {};
  let closed = 0;
  const deploy = step('prod-us/deploy', 'Deploy');
  const record = step('prod-us/record', 'Record deployment');
  const group = { id: 'prod-us', title: 'prod-us', steps: [deploy, record] };
  const status = { 'prod-us/deploy': { s: 'failed', msg: 'deploy failed' }, 'prod-us/record': { s: 'skipped' } };
  const again = render({
    lanes: [group], steps: [deploy, record], rows, open: true, status,
    onClose: () => { closed++; },
  });
  ok(again.modal?.isOpen === true, 'Deploy everything opens the modal again after a run has recorded state');
  ok(again.html.includes('Retry prod-us'), 'the earlier failed lane still offers Retry while the next confirm is open');
  const pending = again.modal.onConfirm();
  ok(closed === 1, 'confirm closes the modal before the run records a step');
  const ran = globalThis.__plan.calls.filter((c) => c.fn === 'runAll');
  ok(ran.length === 1 && ran[0].seed && Object.keys(ran[0].seed).length === 0, 'confirm runs from an empty state, not the previous run');
  await pending;
  ok(closed === 1, 'confirm calls onClose once');

  closed = 0;
  globalThis.__plan.calls = [];
  const empty = render({
    lanes: [{ id: 'same', title: 'same', steps: [], unchanged: 'up to date' }],
    steps: [], rows: [], open: true,
    onClose: () => { closed++; },
  });
  ok(empty.modal?.isOpen === true, 'a plan with no steps still opens the modal');
  await empty.modal.onConfirm();
  ok(closed === 1, 'confirm closes the modal when the plan records no steps');
  ok(globalThis.__plan.calls.some((c) => c.fn === 'runAll' && Object.keys(c.seed).length === 0), 'an empty plan still goes through runAll');
}

console.log(fail ? `\nfleet runner tests: ${fail} failure(s)` : '\nfleet runner tests OK');
process.exit(fail ? 1 : 0);
