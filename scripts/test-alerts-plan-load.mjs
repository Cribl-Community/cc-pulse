// alertsPlan per search load (spec 033 F6). Run: node scripts/test-alerts-plan-load.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-apl-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const mk = (load, targets, extra = {}) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets, email: '' }, learning,
  ...(load ? { searchLoad: load } : {}), rollCall: { hour: 7, tz: 'Europe/Paris', allClear: false, ...extra }, });
const IDS = ['pulse_rollup', 'pulse_state', 'pulse_ledger_asset', 'pulse_ledger_source', 'pulse_alert_missing', 'pulse_alert_source_down', 'pulse_source_digest'];

const runAll = async (s, existing) => {
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const items = u.endsWith('/search/saved') ? existing.map((id) => ({ id, query: 'q', schedule: { enabled: true, cronSchedule: '* * * * *' } })) : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  const plan = D.alertsPlan(s, true, undefined, []);
  for (const st of plan) if (!['commit', 'deploy'].includes(st.id)) { try { await st.run(); } catch { /* lookups etc. */ } }
  return { plan, calls };
};

for (const load of ['standard', 'hourly', 'daily']) {
  const { calls } = await runAll(mk(load, ['a', 'b']), IDS);
  t(`${load}: no DELETE`, !calls.some((c) => c.method === 'DELETE'));
}

// Standard: unchanged (with and without searchLoad), tz UTC
const std = await runAll(mk('standard', ['a']), []);
const bare = await runAll(mk(undefined, ['a']), []);
t('standard equals missing searchLoad', JSON.stringify(std.plan.map((x) => [x.id, x.title, x.detail])) === JSON.stringify(bare.plan.map((x) => [x.id, x.title, x.detail]))
  && JSON.stringify(std.calls) === JSON.stringify(bare.calls));
t('standard has no disable steps', !std.plan.some((x) => /disable/i.test(x.title) && IDS.includes(x.id)));
const stdPosts = std.calls.filter((c) => c.body?.schedule);
t('standard tz UTC', stdPosts.length >= 7 && stdPosts.every((c) => c.body.schedule.tz === 'UTC'));
const stdRoll = mk('standard', ['a']); stdRoll.rollup = 'auto';
t('standard auto keeps rollup steps', D.alertsPlan(stdRoll, true).some((x) => x.id === 'rollup_check'));

const hr = await runAll(mk('hourly', ['a']), []);
t('hourly tz is rollCall.tz', hr.calls.filter((c) => c.body?.schedule).every((c) => c.body.schedule.tz === 'Europe/Paris'));

// Daily
const dsettings = mk('daily', ['a', 'b']); dsettings.rollup = 'auto';
const d = await runAll(dsettings, IDS);
t('daily: no rollup_backfill / rollup_check', !d.plan.some((x) => x.id === 'rollup_backfill' || x.id === 'rollup_check'));
const patches = d.calls.filter((c) => c.method === 'PATCH' && c.body?.schedule && IDS.includes(c.body.id));
t('daily: seven disable PATCHes', patches.length === 7 && patches.every((c) => c.body.schedule.enabled === false));
t('daily: disable titles', IDS.every((id) => /disable/i.test(d.plan.find((x) => x.id === id)?.title ?? '')));
const rc = d.calls.find((c) => c.body?.id === 'pulse_roll_call' && c.body.schedule);
t('daily: roll call saved search, tz', !!rc && rc.body.schedule.tz === 'Europe/Paris' && rc.body.schedule.cronSchedule === '0 7 * * *');
// Spec 035 ID rule: the first target keeps pulse_roll_call_notification, the others get __<targetId>.
const notes = d.calls.filter((c) => c.method !== 'GET' && c.body?.id?.startsWith('pulse_roll_call_notification'));
t('daily: two roll call notifications', notes.length === 2 && notes.map((c) => c.body.id).sort().join() === 'pulse_roll_call_notification,pulse_roll_call_notification__b');
t('daily: single target, no results, n_missing > 0', notes.every((c) => c.body.targets.length === 1 && c.body.targetConfigs[0].conf.includeResults === false && c.body.conf.customValue === 'n_missing > 0'));
t('daily: no other notifications', !d.calls.some((c) => /\/notifications/.test(c.u) && c.method !== 'GET' && !c.body.id.startsWith('pulse_roll_call_')));
const ac = await runAll(mk('daily', ['a'], { allClear: true }), IDS);
const an = ac.calls.find((c) => c.body?.id === 'pulse_roll_call_notification');
t('allClear fires every run', an.body.conf.customValue === 'true');

// Off and absent: no request, and no step when the context lists what exists
const none = await runAll(mk('daily', ['a']), []);
t('daily, none exist: no PATCH on disabled searches', !none.calls.some((c) => c.method === 'PATCH' && IDS.includes(c.body?.id)));
const withCtx = D.alertsPlan(mk('daily', ['a']), true, { nowS: 0, existing: ['pulse_state'] }, []);
t('spec 038: absent off searches still get a disable step', IDS.every((id) => withCtx.some((x) => x.id === id && /^Disable /.test(x.title))));

// Switching back (Economy → Standard / Hourly): pulse_roll_call and its notifications are disabled, never deleted (R2)
const runBack = async (s, saved, notifs) => {
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    calls.push({ u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const items = u.endsWith('/search/saved') ? saved : u.endsWith('/notifications') ? notifs : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  const plan = D.alertsPlan(s, true, undefined, []);
  for (const st of plan) if (!['commit', 'deploy'].includes(st.id)) { try { await st.run(); } catch { /* lookups etc. */ } }
  return { plan, calls };
};
const rcSaved = () => [...IDS.map((id) => ({ id, query: 'q', schedule: { enabled: false, cronSchedule: '* * * * *' } })),
  { id: 'pulse_roll_call', query: 'q', status: 'x', schedule: { enabled: true, cronSchedule: '0 7 * * *', tz: 'Europe/Paris' } }];
const rcNotes = () => [
  { id: 'pulse_roll_call_notification__a', disabled: false, status: 's', targets: ['a'] },
  { id: 'pulse_roll_call_notification__b', targets: ['b'] },
  { id: 'pulse_roll_call_notification__c', disabled: true, targets: ['c'] },
  { id: 'pulse_state_other', targets: ['a'] },
];
for (const load of ['standard', 'hourly']) {
  const back = await runBack(mk(load, ['a', 'b']), rcSaved(), rcNotes());
  const step = back.plan.find((x) => x.id === 'pulse_roll_call');
  t(`${load}: plan has a "Disable pulse_roll_call" step`, !!step && /^Disable pulse_roll_call/.test(step.title) && step.volatile === true);
  const sp = back.calls.filter((c) => c.method === 'PATCH' && /\/search\/saved\/pulse_roll_call$/.test(c.u));
  t(`${load}: pulse_roll_call PATCHed with schedule off, full body minus status`, sp.length === 1 && sp[0].body.schedule.enabled === false
    && sp[0].body.schedule.cronSchedule === '0 7 * * *' && sp[0].body.query === 'q' && !('status' in sp[0].body));
  const np = back.calls.filter((c) => c.method === 'PATCH' && /\/notifications\/pulse_roll_call_notification/.test(c.u));
  t(`${load}: roll call notifications disabled (not the already-off one)`, np.map((c) => c.body.id).sort().join() === 'pulse_roll_call_notification__a,pulse_roll_call_notification__b'
    && np.every((c) => c.body.disabled === true && !('status' in c.body)));
  t(`${load}: other notifications untouched`, !back.calls.some((c) => c.method === 'PATCH' && /pulse_state_other/.test(c.u)));
  t(`${load}: switching back has no DELETE`, !back.calls.some((c) => c.method === 'DELETE'));
  t(`${load}: no write re-creates the roll call`, !back.calls.some((c) => c.method === 'POST' && c.body?.id?.startsWith('pulse_roll_call')));
}
const absentRc = D.alertsPlan(mk('standard', ['a']), true, { nowS: 0, existing: ['pulse_state'] }, []);
t('spec 038: standard, roll call absent (context): disable step still there', absentRc.some((x) => x.id === 'pulse_roll_call' && /^Disable pulse_roll_call if installed/.test(x.title)));
const presentRc = D.alertsPlan(mk('standard', ['a']), true, { nowS: 0, existing: ['pulse_state', 'pulse_roll_call'] }, []);
t('standard, roll call present (context): disable step', presentRc.some((x) => x.id === 'pulse_roll_call' && /^Disable/.test(x.title)));
const noRc = await runBack(mk('standard', ['a']), [], []);
t('standard, nothing installed: roll call step writes nothing', !noRc.calls.some((c) => c.method !== 'GET' && /roll_call/.test(c.u)));
const dailyOnce = D.alertsPlan(mk('daily', ['a']), true, undefined, []).filter((x) => x.id === 'pulse_roll_call');
t('daily: one roll call step, not a disable', dailyOnce.length === 1 && !/^Disable/.test(dailyOnce[0].title));

// R4: Economy also switches off the spec 029 searches built on the turned-off parents (route, default, _firing),
// so over a day the only scheduled Pulse search left is pulse_roll_call (acceptance 5).
const CHILDREN = ['pulse_route_r1_missing', 'pulse_route_r2_missing_firing', 'pulse_route_default_missing', 'pulse_route_default_missing_firing1',
  'pulse_route_r1_source_down', 'pulse_route_default_source_down_s2', 'pulse_route_r3_digest', 'pulse_route_default_digest'];
const runStore = async (s, ids, ctx) => {
  const store = new Map(ids.map((id) => [id, { id, query: 'q', status: 'x', schedule: { enabled: true, cronSchedule: '1-59/5 * * * *', tz: 'UTC' } }]));
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ u, method, body });
    if (/\/search\/saved(\/|$)/.test(u) && (method === 'PATCH' || method === 'POST') && body?.id) store.set(body.id, body);
    const items = u.endsWith('/search/saved') ? [...store.values()] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  const plan = D.alertsPlan(s, true, ctx, []);
  for (const st of plan) if (!['commit', 'deploy'].includes(st.id)) { try { await st.run(); } catch { /* lookups etc. */ } }
  return { plan, calls, store };
};
const eco = await runStore(mk('daily', ['a']), [...IDS, ...CHILDREN, 'user_search']);
const cp = eco.calls.filter((c) => c.method === 'PATCH' && CHILDREN.some((id) => c.u.endsWith(`/search/saved/${id}`)));
t('daily: every route/default/_firing search PATCHed with schedule off', CHILDREN.every((id) => cp.some((c) => c.body.id === id))
  && cp.every((c) => c.body.schedule.enabled === false && c.body.schedule.cronSchedule === '1-59/5 * * * *' && c.body.query === 'q' && !('status' in c.body)));
t('daily: route searches not re-created or updated with a schedule on', !eco.calls.some((c) => c.method !== 'GET' && c.body?.id?.startsWith('pulse_route_') && c.body.schedule?.enabled !== false));
t('daily: unrelated search untouched', !eco.calls.some((c) => c.method !== 'GET' && /user_search/.test(c.u)));
t('daily: no DELETE with route searches', !eco.calls.some((c) => c.method === 'DELETE'));
const scheduled = [...eco.store.values()].filter((x) => x.id.startsWith('pulse_') && x.schedule?.enabled !== false).map((x) => x.id);
t('daily: one scheduled Pulse search left (pulse_roll_call)', scheduled.join() === 'pulse_roll_call');
const onlyChild = D.alertsPlan(mk('daily', ['a']), true, { nowS: 0, existing: ['pulse_route_r1_missing'] }, []);
t('daily: parent absent, its route search present (context): disable step kept', onlyChild.some((x) => x.id === 'pulse_alert_missing' && /^Disable/.test(x.title))
  && onlyChild.some((x) => x.id === 'pulse_alert_source_down' && /^Disable/.test(x.title)));
const oc = await runStore(mk('daily', ['a']), ['pulse_route_r1_missing'], { nowS: 0, existing: ['pulse_route_r1_missing'] });
t('daily: orphan route search disabled', oc.store.get('pulse_route_r1_missing').schedule.enabled === false);
{
  // Spec 038: every off parent now has a step, so run only pulse_alert_missing's and check it leaves source_down's child alone.
  const store = new Map(['pulse_alert_missing', 'pulse_route_r1_source_down'].map((id) => [id, { id, query: 'q', schedule: { enabled: true, cronSchedule: '* * * * *' } }]));
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (init.method === 'PATCH' && body?.id) store.set(body.id, body);
    const items = String(url).endsWith('/search/saved') ? [...store.values()] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  await D.alertsPlan(mk('daily', ['a']), true, { nowS: 0, existing: ['pulse_alert_missing'] }, []).find((x) => x.id === 'pulse_alert_missing').run();
  t('daily: a parent only switches off its own kind', store.get('pulse_route_r1_source_down').schedule.enabled === true && store.get('pulse_alert_missing').schedule.enabled === false);
}

// Spec 038 F1: disable steps do not depend on ctx.existing; titled "if installed"; run-time skips send no write.
{
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
  const K = await import(join(tmp, 'k.mjs'));
  const TAIL = 'if installed (schedule off, never deleted)';
  const stdP = D.alertsPlan(mk('standard', ['a']), true, { nowS: 0, existing: [] }, []);
  const rcStep = stdP.find((x) => x.id === 'pulse_roll_call');
  t('F1 standard, existing []: "Disable pulse_roll_call if installed" step', !!rcStep && rcStep.title.startsWith('Disable pulse_roll_call if installed'));
  for (const load of ['hourly']) {
    const p = D.alertsPlan(mk(load, ['a']), true, { nowS: 0, existing: [] }, []);
    t(`F1 ${load}, existing []: roll call disable step`, p.some((x) => x.id === 'pulse_roll_call' && x.title.startsWith('Disable pulse_roll_call if installed')));
  }
  const dailyS = mk('daily', ['a']);
  const offIds = K.savedSearches(dailyS).filter((x) => x.enabled === false).map((x) => x.id);
  t('F1 savedSearches(daily) marks seven searches off', offIds.length === 7);
  const dP = D.alertsPlan(dailyS, true, { nowS: 0, existing: [] }, []);
  t('F1 daily, existing []: a "Disable <id> if installed" step for each off search',
    offIds.every((id) => dP.some((x) => x.id === id && x.title.startsWith(`Disable ${id} if installed`))));
  t('F1 daily: no roll call disable step', !dP.some((x) => x.id === 'pulse_roll_call' && /^Disable/.test(x.title)));
  const disableSteps = [...stdP, ...dP].filter((x) => /^Disable /.test(x.title) && !/notifications on/.test(x.title));
  t('F1 every disable step title starts "Disable " and has the "if installed" tail', disableSteps.length >= 8
    && disableSteps.every((x) => x.title.startsWith('Disable ') && x.title.includes(TAIL)));
  // Not present: skipped, no write.
  const absent = await runStore(mk('daily', ['a']), [], { nowS: 0, existing: [] });
  const absentRes = [];
  for (const id of offIds) absentRes.push(await absent.plan.find((x) => x.id === id).run());
  t('F1 daily, not present: each step reports "not present: skipped"', absentRes.every((r) => r === 'not present: skipped'));
  t('F1 daily, not present: no PATCH/POST to the off ids', !absent.calls.some((c) => (c.method === 'PATCH' || c.method === 'POST') && offIds.some((id) => c.u.endsWith(`/search/saved/${id}`) || c.body?.id === id)));
  // Already disabled: skipped, no write.
  const runOff = async (s, offSaved) => {
    const calls = [];
    globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
    globalThis.fetch = async (url, init = {}) => {
      const u = String(url);
      calls.push({ u, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
      const items = u.endsWith('/search/saved') ? offSaved.map((id) => ({ id, query: 'q', schedule: { enabled: false, cronSchedule: '* * * * *' } })) : [];
      return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
    };
    const plan = D.alertsPlan(s, true, { nowS: 0, existing: offSaved }, []);
    return { plan, calls };
  };
  const dOff = await runOff(mk('daily', ['a']), offIds);
  const offRes = [];
  for (const id of offIds) offRes.push(await dOff.plan.find((x) => x.id === id).run());
  t('F1 daily, already disabled: each step reports "already disabled: skipped"', offRes.every((r) => r === 'already disabled: skipped'));
  t('F1 daily, already disabled: no PATCH/POST', !dOff.calls.some((c) => c.method === 'PATCH' || c.method === 'POST'));
  const sOff = await runOff(mk('standard', ['a']), ['pulse_roll_call']);
  const sRes = await sOff.plan.find((x) => x.id === 'pulse_roll_call').run();
  t('F1 standard, roll call already disabled: skipped, no write', /skipped/.test(sRes) && !sOff.calls.some((c) => c.method === 'PATCH' || c.method === 'POST'));
  const sAbs = await runOff(mk('standard', ['a']), []);
  const aRes = await sAbs.plan.find((x) => x.id === 'pulse_roll_call').run();
  t('F1 standard, roll call not present: skipped, no write', aRes === 'not present: skipped' && !sAbs.calls.some((c) => c.method === 'PATCH' || c.method === 'POST'));
  // Still disables an enabled one.
  const on = await runStore(mk('daily', ['a']), ['pulse_state'], { nowS: 0, existing: [] });
  t('F1 daily, stale empty list but pulse_state installed and on: PATCHed off', on.calls.some((c) => c.method === 'PATCH' && c.u.endsWith('/search/saved/pulse_state'))
    && on.store.get('pulse_state').schedule.enabled === false);
  t('F1 daily, run again once off: skipped', (await on.plan.find((x) => x.id === 'pulse_state').run()) === 'already disabled: skipped');
}

// R1: a target ID ending in `_s1` (`pulse_ops_s1`). Plan lines group each body with its own slot copies, and the
// stale step does not disable the live bodies the route step just wrote.
{
  const S = 'pulse_alert_missing';
  const T = 'pulse_ops_s1';
  const ROUTE = { id: 'r1', name: 'Ops', when: { team: 'ops' }, targets: [T], final: false };
  const s = mk(undefined, ['system_notifications', T]);
  s.notify.routes = [ROUTE];
  const produced = [`${S}_notification`, ...[0, 1, 2, 3, 4].flatMap((i) => [`${S}_notification__${T}`, `${S}_route_r1__${T}`].map((b) => `${b}${i ? `_s${i}` : ''}`))];
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const method = init.method ?? 'GET';
    calls.push({ u, method, body: init.body ? JSON.parse(init.body) : undefined });
    const items = method === 'GET' && /\/notifications$/.test(u) ? produced.map((id) => ({ id, disabled: false, targets: [T] })) : [];
    const text = JSON.stringify({ items });
    return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
  };
  const plan = D.alertsPlan(s, true, undefined, []);
  const main = plan.find((x) => x.id === S);
  const route = plan.find((x) => x.id === `${S}_route_r1`);
  const stale = plan.find((x) => x.id === `${S}_stale_routes`);
  t('R1 plan: default line for __pulse_ops_s1 with its five slots',
    (main?.lines ?? []).some((l) => l.startsWith(`${S}_notification__${T} → ${T}`) && l.endsWith('(5 result slots)')));
  t('R1 plan: no default line cut back to __pulse_ops', !(main?.lines ?? []).some((l) => l.startsWith(`${S}_notification__pulse_ops →`)));
  t('R1 plan: route r1 is one line with five slots', route?.lines?.length === 1 && route.lines[0].startsWith(`${S}_route_r1__${T} → ${T}`)
    && route.lines[0].endsWith('(5 result slots)'));
  let ran = true;
  try { await stale?.run(); } catch { ran = false; }
  const disabled = calls.filter((c) => c.method !== 'GET' && c.body?.disabled === true).map((c) => c.body.id);
  t('R1 stale step: ran, disables none of the live pulse_ops_s1 bodies', !!stale && ran && disabled.length === 0);
}

if (fail) process.exit(1);
console.log('alerts-plan-load ok');
