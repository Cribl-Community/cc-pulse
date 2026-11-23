// Tests for packSources (F1) and fleetPlan (F3). npm test runs every scripts/test-*.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/lib/packSources.ts'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-fp-'));
const esbuild = join(root, 'node_modules/.bin/esbuild');
const bundle = (file, out) => {
  execFileSync(esbuild, [join(root, file), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
};
bundle('src/lib/packSources.ts', 'packSources.mjs');
bundle('src/lib/routeFilter.ts', 'routeFilter.mjs');
const P = await import(join(tmp, 'packSources.mjs'));
const RF = await import(join(tmp, 'routeFilter.mjs'));

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok(!/from ['"]react['"]|\bfetch\(|\bapi\(|from ['"]\.\/api['"]/.test(src), 'packSources.ts has no React, fetch, or api import');

const key = P.packInputKey('syslog', 'cc-paloalto', 'in_pan_syslog');
ok(key === 'syslog:cc-paloalto.in_pan_syslog', 'packInputKey(syslog, cc-paloalto, in_pan_syslog)');

const filter = RF.routeFilterFor([key], 'true');
const matches = (id) => new Function('__inputId', `return (${filter});`)(id);
ok(matches('syslog:cc-paloalto.in_pan_syslog:tcp'), 'routeFilterFor matches the pack source with a :tcp suffix');
ok(!matches('syslog:in_pan_syslog'), 'routeFilterFor does not match a global source of the same name');
ok(!matches('syslog:cc-paloalto.in_pan_syslog_extra'), 'routeFilterFor does not match a longer id');

const reach = (routes) => P.packReach(routes, key);
const info = (routes) => P.packReachInfo(routes, key);

ok(reach([{ filter: 'true', targetContext: 'group', output: '__group' }]) === 'yes', 'true → group → yes');
ok(reach([{ filter: 'true', output: 'pan_out' }]) === 'no', 'true, missing final, own destination → no');
ok(reach([{ filter: "__inputId==='syslog:cc-paloalto.other'", targetContext: 'group', output: '__group' }, { filter: 'true', output: 'x' }]) === 'no', 'another input forwarded, then consumed → no');

const maybeBare = [{ filter: 'sourcetype==="pan"', targetContext: 'group', output: '__group' }];
ok(reach(maybeBare) === 'maybe', 'unrelated field forwarded, no id → maybe');
const bareInfo = info(maybeBare);
ok(bareInfo.reach === 'maybe' && bareInfo.routeId === undefined, 'id-less maybe-forward has no routeId');

const named = info([{ filter: 'sourcetype==="pan"', targetContext: 'group', output: '__group', id: 'fwd_pan' }]);
ok(named.reach === 'maybe' && named.routeId === 'fwd_pan', 'packReachInfo names the route id');
const byName = info([{ filter: 'sourcetype==="pan"', targetContext: 'group', output: '__group', name: 'Forward PAN' }]);
ok(byName.reach === 'maybe' && byName.routeId === 'Forward PAN', 'packReachInfo uses name when id is absent');
const firstMaybe = info([
  { filter: 'sourcetype==="pan"', targetContext: 'group', output: '__group' },
  { filter: 'host==="fw"', targetContext: 'group', output: '__group', id: 'later' },
]);
ok(firstMaybe.reach === 'maybe' && firstMaybe.routeId === undefined, 'a later named maybe-forward does not invent an id for an earlier one');

ok(reach([{ filter: 'true', targetContext: 'group', output: '__group', disabled: true }, { filter: 'true', output: 'x' }]) === 'no', 'disabled forward is ignored');
ok(reach([{ filter: 'true', final: false, output: 'x' }, { filter: 'true', targetContext: 'group', output: '__group' }]) === 'yes', 'final false, then forward → yes');

ok(reach([{ filter: "__inputId==='syslog:cc-paloalto.in_pan_syslog'", targetContext: 'group', output: '__group' }]) === 'yes', 'quoted key → yes');
ok(reach([{ filter: '__inputId==="syslog:cc-paloalto.in_pan_syslog"', targetContext: 'group' }]) === 'yes', 'double-quoted key → yes');
ok(reach([{ filter: "__inputId==='syslog:cc-paloalto.in_pan_syslog:tcp'", targetContext: 'group', output: '__group' }]) === 'no', 'longer quoted id is not this source');
ok(reach([{ filter: "__inputId==='syslog:cc-paloalto.in_pan_syslog_extra'", targetContext: 'group', output: '__group' }]) === 'no', 'key prefix inside a longer id is not this source');
ok(reach([{ filter: '  true  ', targetContext: 'group', output: '__group' }]) === 'yes', 'trimmed true → yes');
ok(reach([]) === 'no', 'no routes → no');
ok(reach([{ filter: 'sourcetype==="pan"', output: 'x' }]) === 'no', 'unrelated final route is not a maybe-forward');

/* T5: __inputId filters are evaluated against the key, not just searched for a quoted key. */
const fwd = (filter) => [{ filter, targetContext: 'group', output: '__group' }, { filter: 'true', output: 'x' }];
const keep = (filter) => [{ filter, output: 'pan_out' }, { filter: 'true', targetContext: 'group', output: '__group' }];
ok(reach(fwd("__inputId.startsWith('syslog:')")) === 'yes', "startsWith('syslog:') forwarded → yes");
ok(reach(fwd("__inputId.startsWith('syslog:cc-paloalto')")) === 'yes', "startsWith('syslog:cc-paloalto') forwarded → yes");
ok(reach(fwd('__inputId.startsWith("syslog:cc-paloalto.")')) === 'yes', 'double-quoted startsWith forwarded → yes');
ok(reach(keep("__inputId.startsWith('syslog:')")) === 'no', "startsWith('syslog:') kept in the pack → no");
ok(reach(fwd("__inputId.startsWith('tcp:')")) === 'no', "startsWith('tcp:') is another input → carry on → no");
ok(reach(keep("__inputId.startsWith('tcp:')")) === 'yes', "startsWith('tcp:') consuming route does not stop this source → yes");
ok(reach(fwd("__inputId=='syslog:cc-paloalto.in_pan_syslog'")) === 'yes', '== key → yes');
ok(reach(fwd("__inputId==='syslog:cc-paloalto.in_pan_syslog'")) === 'yes', '=== key → yes');
ok(reach(fwd("'syslog:cc-paloalto.in_pan_syslog' === __inputId")) === 'yes', 'key === __inputId (literal first) → yes');
ok(reach(fwd("__inputId == 'syslog:cc-paloalto.other'")) === 'no', '== another id → carry on → no');
ok(reach(fwd("__inputId!='syslog:cc-paloalto.in_pan_syslog'")) === 'no', '!= key is not this source → no');
ok(reach(fwd("__inputId!=='syslog:cc-paloalto.in_pan_syslog'")) === 'no', '!== key is not this source → no');
ok(reach(keep("__inputId!=='syslog:cc-paloalto.in_pan_syslog'")) === 'yes', '!== key consuming route does not stop this source → yes');
ok(reach(fwd("__inputId!=='syslog:cc-paloalto.other'")) === 'yes', '!== another id takes this source → yes');
ok(reach(fwd("__inputId != 'syslog:cc-paloalto.other'")) === 'yes', '!= another id takes this source → yes');
ok(reach(fwd("!__inputId.startsWith('cribl:')")) === 'yes', "!startsWith('cribl:') takes this source → yes");
ok(reach(fwd("!__inputId.startsWith('syslog:')")) === 'no', "!startsWith('syslog:') is not this source → no");
ok(reach(fwd(RF.routeFilterFor([key], 'true'))) === 'yes', 'the routeFilterFor filter for this key → yes');
ok(reach(fwd(RF.routeFilterFor(['syslog:cc-paloalto.other'], 'true'))) === 'no', 'the routeFilterFor filter for another key → no');
ok(reach(fwd("(__inputId.startsWith('tcp:') || __inputId.startsWith('syslog:cc-'))")) === 'yes', 'parenthesised || of startsWith → yes');
const fwdOnly = (filter) => [{ filter, targetContext: 'group', output: '__group' }];
ok(reach(fwdOnly("__inputId.startsWith('syslog:') && sourcetype==='pan'")) === 'maybe', 'matching id && another field → maybe');
ok(reach(fwdOnly("__inputId.startsWith('tcp:') && sourcetype==='pan'")) === 'no', 'other id && another field → no');
ok(reach(fwdOnly("__inputId.startsWith('tcp:') || sourcetype==='pan'")) === 'maybe', 'other id || another field → maybe');
ok(reach(fwdOnly("__inputId.includes('pan')")) === 'maybe', 'unread __inputId call → maybe');
ok(reach(fwdOnly('/pan/.test(__inputId)')) === 'maybe', 'regex on __inputId → maybe');
ok(reach(fwdOnly("__inputId === 'syslog:cc-paloalto.in_pan_syslog' ? true : false")) === 'maybe', 'ternary → maybe');
ok(reach(fwdOnly("!__inputId === 'syslog:cc-paloalto.in_pan_syslog'")) === 'maybe', '!__inputId === key (negates before comparing) → maybe');
ok(reach(fwdOnly("__inputId === 'syslog:cc-paloalto.in_pan_syslog")) === 'maybe', 'unterminated string → maybe');
ok(reach(fwdOnly("__inputId.startsWith('tcp:')")) === 'no', 'a lone forward of another input → no');
ok(reach(fwd('false')) === 'no', 'false forwards nothing → no');

const cases = [
  maybeBare,
  [{ filter: 'true', targetContext: 'group', output: '__group' }],
  [{ filter: 'true', output: 'pan_out' }],
  [{ filter: 'true', final: false, output: 'x' }, { filter: 'true', targetContext: 'group', output: '__group' }],
];
ok(cases.every((routes) => reach(routes) === info(routes).reach), 'packReach returns the same reach as packReachInfo');

ok(P.streamPackForward('4.16.0') === false, '4.16.0 is below 4.17');
ok(P.streamPackForward('4.17.0') === true, '4.17.0 can forward');
ok(P.streamPackForward('4.20.1') === true, '4.20.1 can forward');
ok(P.streamPackForward(undefined) === true, 'undefined version is not treated as old');
ok(P.streamPackForward('fake-020') === true, 'unparseable version is not treated as old');
ok(P.streamPackForward('4.9.0') === false, '4.9 is below 4.17 (not a float compare)');
ok(P.streamPackForward('5.0.0') === true, '5.0 can forward');

const fleetSrc = existsSync(join(root, 'src/lib/fleetPlan.ts')) ? readFileSync(join(root, 'src/lib/fleetPlan.ts'), 'utf8') : '';
ok(!fleetSrc || !/from ['"]react['"]|\bfetch\(|\bapi\(/.test(fleetSrc), 'fleetPlan.ts has no React, fetch, or api(');

if (fleetSrc) {
  const fakeApi = join(tmp, 'fake-api.mjs');
  writeFileSync(fakeApi, `
export const API = '/api/v1';
export class ApiError extends Error {
  constructor(status, path, msg, method = 'GET', body = '') { super(msg); this.status = status; this.path = path; this.method = method; this.body = body; }
}
export const items = (r) => (r && r.items) || [];
export async function api() { throw new Error('not used'); }
export const listDatasets = async () => [];
export const kvGet = async () => ({});
export const kvPut = async () => undefined;
export const publishLookup = async () => undefined;
export const setPackVar = async () => undefined;
export async function commitGroup() { return 'deadbeef'; }
export async function deployGroup() { return undefined; }
export const listGroups = async () => [];
export const runSearch = async () => [];
`);
  const outFleet = join(tmp, 'fleetPlan.mjs');
  const esb = await import('esbuild');
  await esb.build({
    entryPoints: [join(root, 'src/lib/fleetPlan.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: outFleet,
    logLevel: 'error',
    define: { 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'fake-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: fakeApi })); } }],
  });
  const { fleetPlan } = await import(outFleet);
  const LEARNING = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
  const S = { dataset: 'pulse_metrics_pq', destination: 'pulse_lake_pq', routeFilter: "!__inputId.startsWith('cribl:')", rollup: 'off', learning: LEARNING, notify: { targets: [], email: '', routes: [] }, refresh: '1m' };
  const V = '1.3.0';
  const rec = (group, inputs) => ({ group, inputs, filter: '', at: '2026-11-01T00:00:00Z', pack: V, dataset: S.dataset, destination: S.destination });
  const targets = [
    { group: 'new', mode: 'selected', inputs: ['tcp:in_a'], prev: null, installed: undefined },
    { group: 'old', mode: 'selected', inputs: ['tcp:in_a', 'tcp:in_b'], prev: rec('old', ['tcp:in_a']), installed: V },
    { group: 'same', mode: 'selected', inputs: ['tcp:in_a'], prev: rec('same', ['tcp:in_a']), installed: V },
  ];
  const r = fleetPlan(targets, S, { alerts: true, enabled: true });
  const lanes = r.lanes ?? [];
  ok(lanes.map((l) => l.id).join(',') === 'shared,new,old,same,search', 'fleetPlan lanes: shared, new, old, same, search');
  const ids = (r.steps ?? []).map((x) => x.id);
  const stepOf = (id) => (r.steps ?? []).find((x) => x.id === id);
  ok(ids.filter((x) => /(^|\/)dataset$/.test(x)).join() === 'shared/dataset' && ids.includes('shared/dataset5m'), 'Lake steps once in shared lane');
  ok(!ids.some((x) => /^(new|old|same)\/.*\/(dataset|dataset5m)$/.test(x) || /^(new|old|same)\/(dataset|dataset5m)$/.test(x)), 'no group lane dataset steps');
  ok(['new/pack', 'new/dest', 'new/route'].every((x) => ids.includes(x)), 'new has pack, dest, route');
  ok(['new/pack', 'new/dest'].every((x) => stepOf('new/route')?.needs?.includes(x)), 'new/route needs new/pack and new/dest');
  ok(['new/pack', 'new/dest', 'new/route'].every((x) => stepOf('new/commit')?.needs?.includes(x)), 'new/commit needs new/pack, new/dest, and new/route');
  ok(stepOf('old/commit')?.needs?.join(',') === 'old/route', 'route-only commit needs the route');
  ok(stepOf('new/deploy')?.needs?.includes('new/commit') && stepOf('old/deploy')?.needs?.includes('old/commit'), 'deploy still needs its own commit');
  ok(stepOf('new/dest')?.needs?.join(',') === 'shared/dataset', 'new/dest needs shared/dataset');
  ok(ids.filter((x) => x.startsWith('old/')).join(',') === 'old/route,old/commit,old/deploy,old/record', 'old route-only lane');
  const sameLane = lanes.find((l) => l.id === 'same');
  ok(sameLane && sameLane.steps.length === 0 && sameLane.unchanged === 'up to date', 'same lane up to date');
  const search = (r.steps ?? []).filter((x) => x.id.startsWith('search/'));
  ok(search.length > 0 && search.every((x) => JSON.stringify(x.needs ?? []) === '["shared/dataset"]'), 'every search step needs only shared/dataset');
  const lastGroup = Math.max(...ids.filter((x) => /^(new|old)\//.test(x)).map((x) => ids.indexOf(x)));
  ok(ids.indexOf(search[0]?.id) > lastGroup, 'search lane after group lanes');
  const inv = fleetPlan([{ group: 'empty', inputs: [], mode: 'selected', prev: null }], S, { alerts: false, enabled: true });
  ok(inv.invalid.some((x) => x.group === 'empty' && /pick at least one/.test(x.reason)), 'empty inputs invalid');
  ok(!(inv.steps ?? []).some((x) => x.id.startsWith('empty/')), 'invalid group not in steps');
  ok(!inv.lanes.some((l) => l.id === 'search'), 'alerts false: no search lane');
  const full = fleetPlan([{ group: 'same', mode: 'selected', inputs: ['tcp:in_a'], prev: rec('same', ['tcp:in_a']), installed: V, full: true }], S, { alerts: false, enabled: true });
  const fullIds = (full.steps ?? []).map((x) => x.id);
  ok(fullIds.includes('same/pack') && fullIds.includes('same/dest'), 'full: true forces pack and dest on route-only group');
}

const planSrc = readFileSync(join(root, 'src/lib/plan.ts'), 'utf8');
for (const f of ['runSteps', 'retryFrom', 'skipFrom', 'restart', 'runAll', 'retryLane', 'skipLane'])
  ok(new RegExp(`export (async )?(function|const) ${f}\\b`).test(planSrc), `plan.ts exports ${f}`);

const fakeCribl = join(tmp, 'fake-cribl-api.mjs');
writeFileSync(fakeCribl, `
export const API = '/api/v1';
export class ApiError extends Error {
  constructor(status, path, msg, method = 'GET', body = '') { super(msg); this.status = status; this.path = path; this.method = method; this.body = body; }
  get detail() { return this.method + ' ' + this.path + '\\nHTTP ' + this.status + '\\n\\n' + this.body; }
}
export const items = (r) => (r && r.items) || [];
const st = () => globalThis.__cribl;
export async function api(path, opts = {}) {
  const m = (opts.method || 'GET').toUpperCase(), s = st();
  s.calls.push({ m, path });
  if (path === '/products/lake/lakes/default/datasets') {
    if (m === 'GET') return { items: s.datasets };
    if (s.failDataset > 0) { s.failDataset--; throw new ApiError(500, path, 'dataset failed', m); }
    s.datasets.push(opts.json);
    return {};
  }
  let g = path.match(/^\\/m\\/([^/]+)\\/system\\/outputs/);
  if (g) {
    if (m !== 'GET' && s.failDest?.[g[1]] > 0) { s.failDest[g[1]]--; throw new ApiError(500, path, 'dest failed', m); }
    return m === 'GET' ? { items: s.outputs[g[1]] ?? [] } : ((s.outputs[g[1]] ??= []).push(opts.json), {});
  }
  g = path.match(/^\\/m\\/([^/]+)\\/routes\\/default$/);
  if (g) {
    if (m !== 'GET' && s.failRoute?.[g[1]] > 0) { s.failRoute[g[1]]--; throw new ApiError(500, path, 'route failed', m); }
    if (m !== 'GET') (s.trace ??= []).push('route:' + g[1]);
    return m === 'GET' ? { items: [s.routes[g[1]] ?? { id: 'default', routes: [] }] } : ((s.routes[g[1]] = opts.json), {});
  }
  g = path.match(/^\\/m\\/([^/]+)\\/packs/);
  if (g) {
    if (m === 'GET') return { items: s.packs[g[1]] ?? [] };
    if (m === 'PUT' && s.failPack?.[g[1]] > 0) { s.failPack[g[1]]--; throw new ApiError(500, path, 'pack upload failed', m); }
    if (m === 'PUT') return { source: 'upload.crbl' };
    s.packs[g[1]] = [{ id: 'cribl-pulse', version: s.shipped }]; return {};
  }
  throw new Error('fake Cribl: unexpected ' + m + ' ' + path);
}
export const listDatasets = async () => items(await api('/products/lake/lakes/default/datasets'));
export const kvGet = async (k, d) => (k in st().kv ? st().kv[k] : d);
export const kvPut = async (k, v) => { st().kv[k] = v; };
export const publishLookup = async () => undefined;
export const setPackVar = async () => undefined;
export async function commitGroup(group) { const s = st(); (s.trace ??= []).push('commit:' + group); s.commits.push(group); return 'c0ffee' + s.commits.length; }
export async function deployGroup(group) { const s = st(); s.deploys.push(group);
  if (s.failDeploy[group] > 0) { s.failDeploy[group]--; throw new ApiError(409, '/master/groups/' + group + '/deploy', 'a deploy is already in progress', 'PATCH'); } }
export const listGroups = async () => [];
export const runSearch = async () => [];
`);
const esb = await import('esbuild');
const bundleWithFake = async (entry, out) => {
  await esb.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    outfile: join(tmp, out),
    logLevel: 'error',
    define: { 'import.meta.env.BASE_URL': '"/"' },
    plugins: [{ name: 'fake-api', setup(b) { b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: fakeCribl })); } }],
  });
};
globalThis.fetch = async () => ({ blob: async () => new Blob(['crbl']) });
await bundleWithFake('src/lib/plan.ts', 'plan.mjs');
await bundleWithFake('src/lib/fleetPlan.ts', 'fleetPlanRun.mjs');
await bundleWithFake('src/lib/fleetRun.ts', 'fleetRun.mjs');
const R = await import(join(tmp, 'plan.mjs'));
const { fleetPlan: fleetPlanRun } = await import(join(tmp, 'fleetPlanRun.mjs'));
const { laneViews } = await import(join(tmp, 'fleetRun.mjs'));
const LEARNING2 = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const S2 = { dataset: 'pulse_metrics_pq', destination: 'pulse_lake_pq', routeFilter: "!__inputId.startsWith('cribl:')", rollup: 'off', learning: LEARNING2, notify: { targets: [], email: '' } };
const V2 = '1.3.0';

if (fleetSrc && typeof R.runAll === 'function') {
  globalThis.__cribl = { datasets: [{ id: S2.dataset, format: 'parquet' }, { id: `${S2.dataset}_5m`, format: 'parquet' }], outputs: {}, routes: {}, packs: {}, shipped: V2, kv: {},
    commits: [], deploys: [], failDeploy: { 'prod-us': 1 }, calls: [] };
  const run = fleetPlanRun([{ group: 'prod-us', mode: 'all', inputs: [], prev: null }, { group: 'dmz', mode: 'selected', inputs: ['syslog:in_s'], prev: null }], S2, { alerts: false, enabled: true });
  const r1 = await R.runAll(run.steps, {}, () => {});
  const s1 = r1.state;
  ok(s1['prod-us/deploy']?.s === 'failed' && s1['prod-us/record']?.s === 'skipped', 'runAll: prod-us/deploy failed, prod-us/record skipped');
  ok(run.steps.filter((x) => x.id.startsWith('dmz/')).every((x) => s1[x.id]?.s === 'done'), 'runAll: every dmz step done despite prod-us');
  const before = globalThis.__cribl.commits.filter((g) => g === 'prod-us').length;
  const r2 = await R.retryLane(run.steps, s1, 'prod-us', () => {});
  ok(r2.state['prod-us/deploy']?.s === 'done' && r2.state['prod-us/record']?.s === 'done', 'retryLane(prod-us): deploy and record done');
  ok(globalThis.__cribl.commits.filter((g) => g === 'prod-us').length === before, 'retryLane(prod-us): commit list unchanged');
  const cribl = (extra) => {
    globalThis.__cribl = {
      datasets: [{ id: S2.dataset, format: 'parquet' }, { id: `${S2.dataset}_5m`, format: 'parquet' }],
      outputs: {}, routes: {}, packs: {}, shipped: V2, kv: {},
      commits: [], deploys: [], failDeploy: {}, calls: [], trace: [],
      failPack: {}, failDest: {}, failRoute: {}, ...extra,
    };
  };
  const repair = async (label, failedId, extra, targets) => {
    cribl(extra);
    const plan = fleetPlanRun(targets, S2, { alerts: false, enabled: true });
    const first = await R.runAll(plan.steps, {}, () => {});
    const stt = first.state;
    ok(stt[failedId]?.s === 'failed', `${label}: ${failedId} failed`);
    ok(stt['prod-us/commit']?.s === 'skipped' && stt['prod-us/deploy']?.s === 'skipped' && stt['prod-us/record']?.s === 'skipped', `${label}: commit, deploy, and record skipped`);
    ok(globalThis.__cribl.commits.length === 0 && globalThis.__cribl.kv['deployments/prod-us'] == null, `${label}: no commit and no deployment record`);
    const second = await R.retryLane(plan.steps, stt, 'prod-us', () => {});
    const trace = globalThis.__cribl.trace;
    const routeAt = trace.lastIndexOf('route:prod-us');
    const commitAt = trace.lastIndexOf('commit:prod-us');
    ok(second.state['prod-us/route']?.s === 'done' && second.state['prod-us/commit']?.s === 'done' && second.state['prod-us/deploy']?.s === 'done' && second.state['prod-us/record']?.s === 'done', `${label}: retry finishes route, commit, deploy, and record`);
    ok(routeAt >= 0 && commitAt > routeAt && globalThis.__cribl.commits.filter((g) => g === 'prod-us').length === 1, `${label}: the single commit follows the repaired route`);
    ok(globalThis.__cribl.kv['deployments/prod-us'] != null, `${label}: deployment record is written on the retry`);
  };
  const fresh = [{ group: 'prod-us', mode: 'all', inputs: [], prev: null }];
  await repair('failed pack', 'prod-us/pack', { failPack: { 'prod-us': 1 } }, fresh);
  await repair('failed dest', 'prod-us/dest', { failDest: { 'prod-us': 1 } }, fresh);
  await repair('failed route', 'prod-us/route', { failRoute: { 'prod-us': 1 } }, fresh);
  const prevRoute = { group: 'prod-us', inputs: ['syslog:in_a'], filter: '', at: '2026-11-01T00:00:00Z', pack: V2, dataset: S2.dataset, destination: S2.destination };
  await repair('failed route on a route-only lane', 'prod-us/route', { failRoute: { 'prod-us': 1 } }, [
    { group: 'prod-us', mode: 'selected', inputs: ['syslog:in_b'], prev: prevRoute, installed: V2 },
  ]);
  cribl({ datasets: [{ id: `${S2.dataset}_5m`, format: 'parquet' }], failDataset: 1 });
  const lakePlan = fleetPlanRun([{ group: 'prod-us', mode: 'all', inputs: [], prev: null }], S2, { alerts: false, enabled: true });
  const lake = await R.runAll(lakePlan.steps, {}, () => {});
  const lakeState = lake.state;
  ok(lakeState['shared/dataset']?.s === 'failed', 'failed Lake dataset: shared/dataset failed');
  ok(lakeState['prod-us/dest']?.s === 'skipped' && lakeState['prod-us/route']?.s === 'skipped', 'failed Lake dataset: dest and route skipped');
  ok(lakeState['prod-us/commit']?.s === 'skipped' && lakeState['prod-us/deploy']?.s === 'skipped' && lakeState['prod-us/record']?.s === 'skipped', 'failed Lake dataset: commit, deploy, and record skipped');
  ok(globalThis.__cribl.commits.length === 0 && globalThis.__cribl.kv['deployments/prod-us'] == null, 'failed Lake dataset: the pack is not committed or recorded alone');
  const blocked = laneViews(lakePlan.lanes, lakePlan.steps, lakeState).find((v) => v.id === 'prod-us');
  ok(blocked?.phase === 'failed' && blocked?.retry === true && blocked?.skip === true, 'failed Lake dataset: the group offers Retry and Skip');
  const lakeFixed = await R.retryLane(lakePlan.steps, lakeState, 'shared', () => {});
  ok(lakeFixed.state['shared/dataset']?.s === 'done' && lakeFixed.state['prod-us/dest']?.s === 'skipped', 'retry shared finishes the dataset and leaves the group skipped');
  const still = laneViews(lakePlan.lanes, lakePlan.steps, lakeFixed.state).find((v) => v.id === 'prod-us');
  ok(still?.phase === 'failed' && still?.retry === true, 'the group stays retryable after the dataset exists');
  const resumed = await R.retryLane(lakePlan.steps, lakeFixed.state, 'prod-us', () => {});
  ok(resumed.state['prod-us/dest']?.s === 'done' && resumed.state['prod-us/route']?.s === 'done' && resumed.state['prod-us/commit']?.s === 'done' && resumed.state['prod-us/deploy']?.s === 'done' && resumed.state['prod-us/record']?.s === 'done', 'retry group finishes dest, route, commit, deploy, and record');
  ok(globalThis.__cribl.commits.filter((g) => g === 'prod-us').length === 1 && globalThis.__cribl.kv['deployments/prod-us'] != null, 'resuming the group commits once and writes the deployment record');
  const stopSteps = [
    { id: 'shared/dataset', title: 'shared', run: async () => 'ok' },
    { id: 'bad/deploy', title: 'bad', run: async () => { throw new Error('boom'); } },
    { id: 'bad/record', title: 'rec', needs: ['bad/deploy'], run: async () => 'nope' },
    { id: 'search/ss1', title: 'search', needs: ['shared/dataset'], run: async () => 'search ran' },
  ];
  const r3 = await R.runAll(stopSteps, {}, () => {});
  ok(r3.state['search/ss1']?.s === 'done' && r3.state['search/ss1']?.msg === 'search ran', 'runAll: search/ runs after an earlier lane failed');
  let ran = 0;
  const skipSteps = [
    { id: 'lane/a', title: 'a', run: async () => { ran++; return 'x'; } },
    { id: 'lane/b', title: 'b', run: async () => { ran++; return 'x'; } },
  ];
  const afterSkip = R.skipLane(skipSteps, { 'lane/a': { s: 'failed', msg: 'err' }, 'lane/b': { s: 'pending' } }, 'lane', () => {});
  ok(afterSkip['lane/a']?.s === 'skipped' && afterSkip['lane/b']?.s === 'skipped' && ran === 0, 'skipLane: marks failed and pending skipped without run()');
  const r4 = await R.runSteps(stopSteps, 0, {}, () => {});
  ok(r4.failedAt === 1, 'runSteps still stops on first failure');
}

console.log(fail ? `${fail} failure(s)` : 'fleet plan tests OK');
process.exit(fail ? 1 : 0);
