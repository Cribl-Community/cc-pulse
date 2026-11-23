// R2 (spec 030 §3): the plain native `pager_duty` target stays without auto-resolve. It sends no event_action, so a
// resolved / expired row would reach PagerDuty as one more trigger ("<asset> stopped sending"). With recovery on (the
// default), native PagerDuty targets must still get firing rows only, on routes and on the default route alike, while
// every other target keeps its recoveries. Run: node scripts/test-pd-recovery.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-pdrec-'));
const build = (entry, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/deploy.ts', 'd.mjs');
build('src/lib/routes.ts', 'r.mjs');
const D = await import(join(tmp, 'd.mjs'));
const R = await import(join(tmp, 'r.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const FIRING = 'event in ("opened", "reminder")';
const types = { pulse_pd: 'pager_duty', pulse_slack_net: 'slack', system_notifications: 'bulletin_message', system_email: 'smtp' };
const P1 = { id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: ['pulse_pd'], severity: 'critical', final: true };
const MIX = { id: 'r2', name: 'Ops', when: { team: 'ops' }, targets: ['system_notifications', 'pulse_pd', 'pulse_slack_net'], final: false };
const REC = { id: 'r3', name: 'Recoveries only', when: { events: ['resolved', 'expired'] }, targets: ['pulse_pd'], final: false };
const nf = (id, routes, targets, events) => R.notificationsFor({ id, desc: 'd' }, routes, { targets, email: '', events }, { targetTypes: types });
const byId = (ns, id) => ns.find((n) => n.id === id);
const hasPd = (n) => n.targets.includes('pulse_pd');

/* ── pure: notificationsFor, recovery on (the default) ── */
t('firingEvents keeps opened / reminder', JSON.stringify(R.firingEvents(R.ALERT_EVENTS)) === '["opened","reminder"]' && R.firingEvents(['resolved', 'expired']).length === 0);
for (const parent of ['pulse_alert_missing', 'pulse_alert_source_down']) {
  const ns = nf(parent, [P1, MIX, REC], ['pulse_pd'], undefined);
  const pd = ns.filter(hasPd);
  t(`${parent}: every native PagerDuty notification triggers on firing rows only`, pd.length === 15 && pd.every((n) => n.conf.triggerType === 'resultsCount' && String(n.conf.customValue).includes(FIRING) && !String(n.conf.customValue).includes('slot ==')));
  t(`${parent}: no notification mixes PagerDuty with another target`, pd.every((n) => n.targets.join() === 'pulse_pd'));
  const r1 = byId(ns, `${parent}_route_r1__pulse_pd`);
  t(`${parent}: PagerDuty-only route gets its __<target> id and __severity`, !!r1 && hasPd(r1) && JSON.stringify(r1.metadata) === '[{"name":"__severity","value":"critical"}]');
  const text = byId(ns, `${parent}_route_r2__system_notifications`), pdN = byId(ns, `${parent}_route_r2__pulse_pd`), slack = byId(ns, `${parent}_route_r2__pulse_slack_net`);
  t(`${parent}: mixed route: the bulletin keeps every event`, text?.targets.join() === 'system_notifications' && !String(text.conf.customValue).includes('event in'));
  t(`${parent}: mixed route: Slack keeps every event`, slack?.targets.join() === 'pulse_slack_net' && !String(slack.conf.customValue).includes('event in'));
  t(`${parent}: mixed route: PagerDuty has its own _route_r2__pulse_pd, firing only`, pdN?.targets.join() === 'pulse_pd' && String(pdN.conf.customValue).includes(FIRING));
  t(`${parent}: a recoveries-only route writes no PagerDuty notification`, !ns.some((n) => n.id.startsWith(`${parent}_route_r3`)));
  const def = byId(ns, `${parent}_notification`);
  t(`${parent}: default to PagerDuty only: _notification, firing only`, def?.targets.join() === 'pulse_pd' && def.conf.triggerType === 'resultsCount'
    && String(def.conf.customValue).includes(FIRING) && String(def.conf.customValue).includes('not ((toint') && !String(def.conf.customValue).includes('slot =='));
  const mixed = nf(parent, [], ['system_notifications', 'pulse_pd'], undefined);
  const dText = byId(mixed, `${parent}_notification`), dPd = byId(mixed, `${parent}_notification__pulse_pd`);
  t(`${parent}: default mixed: the bulletin stays resultsCount > 0 (recoveries included)`, dText?.targets.join() === 'system_notifications' && dText.conf.triggerType === 'resultsCount' && !('customValue' in dText.conf));
  t(`${parent}: default mixed: PagerDuty gets _notification__pulse_pd, firing only`, dPd?.targets.join() === 'pulse_pd' && dPd.conf.customValue === FIRING);
  const off = nf(parent, [MIX], ['system_notifications', 'pulse_pd'], ['opened', 'reminder']);
  t(`${parent}: recovery off: PagerDuty and the others share one condition`, byId(off, `${parent}_route_r2__system_notifications`)?.conf.customValue === byId(off, `${parent}_route_r2__pulse_pd`)?.conf.customValue);
}
const dg = nf('pulse_source_digest', [P1], ['pulse_pd'], undefined);
t('digest (no recoveries): PagerDuty is not event-filtered', dg.filter(hasPd).every((n) => !String(n.conf.customValue ?? '').includes('event in')));
t('isRouteNotification knows _pager_duty and __<target>', R.isRouteNotification('pulse_alert_missing_route_r2_pager_duty', 'pulse_alert_missing', 'r2') && R.isRouteNotification('pulse_alert_missing_route_r2__pulse_pd_s1', 'pulse_alert_missing', 'r2'));
t('staleNotifications: a live route\'s __<target> is not stale, its 029 _pager_duty and a removed route\'s are',
  R.staleNotifications('pulse_alert_missing', [MIX], ['pulse_alert_missing_route_r2__pulse_pd']).length === 0
  && R.staleNotifications('pulse_alert_missing', [MIX], ['pulse_alert_missing_route_r2_pager_duty']).length === 1
  && R.staleNotifications('pulse_alert_missing', [], ['pulse_alert_missing_route_r2__pulse_pd']).length === 1);
t('staleDefaults knows _notification_pager_duty', R.staleDefaults('pulse_alert_missing', ['pulse_alert_missing_notification'], ['pulse_alert_missing_notification_pager_duty']).join() === 'pulse_alert_missing_notification_pager_duty');

/* ── Deploy on a fake Cribl (vt_results): what each PagerDuty notification actually reads ── */
const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const mk = (routes, targets, recovery = true) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets, email: '', routes, remindH: 0, recovery }, learning });
const known = Object.entries(types).filter(([id]) => id !== 'system_email').map(([id, type]) => ({ id, type }));
const reqs = [];
function fakeCribl(store) {
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    reqs.push(method);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const reply = (status, v) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    const m = /^\/m\/default_search\/(search\/saved|notifications)(?:\/([^/]+))?$/.exec(u);
    if (!m) return reply(404, { error: `no route ${u}` });
    const col = store[m[1]];
    if (method === 'GET' && !m[2]) return reply(200, { items: col });
    if (method === 'POST' && !m[2]) { col.push(body); return reply(200, { items: [body] }); }
    if (method === 'PATCH' && m[2]) { const i = col.findIndex((x) => x.id === m[2]); if (i < 0) return reply(404, {}); col[i] = body; return reply(200, { items: [body] }); }
    return reply(405, { error: `${method} not allowed` });
  };
}
const apply = async (s, store = { 'search/saved': [], notifications: [] }) => {
  fakeCribl(store);
  const plan = D.alertsPlan(s, true, undefined, known, { origin: 'https://org.cribl.cloud', base: '/app-ui/pulse' });
  for (const st of plan.filter((x) => x.id.startsWith('pulse_'))) await st.run();
  return store;
};
const rowsOf = (store, n) => store['search/saved'].find((x) => x.id === n.conf.savedQueryId);
for (const kind of ['missing', 'source_down']) {
  const parent = kind === 'missing' ? 'pulse_alert_missing' : 'pulse_alert_source_down';
  const st = await apply(mk([P1, MIX], ['system_notifications', 'pulse_pd']));
  const mine = st.notifications.filter((n) => n.conf.savedQueryId === parent || rowsOf(st, n)?.query.includes(`jobName == "${parent}"`));
  const pd = mine.filter(hasPd), other = mine.filter((n) => !hasPd(n));
  t(`deploy (${kind}): three PagerDuty groups (r1, r2, default) x 5 slots each read a search`, pd.length === 15 && pd.every((n) => !!rowsOf(st, n)));
  t(`deploy (${kind}): every search a PagerDuty notification reads keeps firing rows only`, pd.every((n) => rowsOf(st, n).query.includes(`| where `) && rowsOf(st, n).query.split('\n')[0].includes(FIRING) && rowsOf(st, n).query.split('\n')[0].includes('slot ==')));
  t(`deploy (${kind}): P1 → PagerDuty only reads pulse_route_r1_${kind}`, byId(st.notifications, `${parent}_route_r1__pulse_pd`)?.conf.savedQueryId === `pulse_route_r1_${kind}`);
  t(`deploy (${kind}): the mixed route's PagerDuty reads pulse_route_r2_${kind}_firing`, byId(st.notifications, `${parent}_route_r2__pulse_pd`)?.conf.savedQueryId === `pulse_route_r2_${kind}_firing`);
  t(`deploy (${kind}): the other targets keep their recoveries`, other.length > 0 && other.every((n) => !(rowsOf(st, n)?.query.split('\n')[0] ?? '').includes('event in ("opened", "reminder")'))
    && byId(st.notifications, `${parent}_route_r2__system_notifications`)?.conf.savedQueryId === `pulse_route_r2_${kind}`
    && byId(st.notifications, `${parent}_route_r2__system_notifications`)?.conf.triggerType === 'resultsCount');
  t(`deploy (${kind}): the default PagerDuty reads pulse_route_default_${kind}_firing`, byId(st.notifications, `${parent}_notification__pulse_pd`)?.conf.savedQueryId === `pulse_route_default_${kind}_firing`);
  t(`deploy (${kind}): firing searches run with their route searches`, st['search/saved'].filter((x) => x.id.endsWith(`${kind}_firing`)).every((x) => x.schedule.cronSchedule === '1-59/5 * * * *'));
  // PagerDuty leaves the mixed route: its _firing search and notification stop (disabled, never deleted).
  await apply(mk([P1, { ...MIX, targets: ['system_notifications'] }], ['system_notifications']), st);
  t(`deploy (${kind}): PagerDuty removed → pulse_route_r2_${kind}_firing stops running`, st['search/saved'].find((x) => x.id === `pulse_route_r2_${kind}_firing`)?.schedule.enabled === false);
  t(`deploy (${kind}): … and _route_r2__pulse_pd is disabled`, byId(st.notifications, `${parent}_route_r2__pulse_pd`)?.disabled === true
    && byId(st.notifications, `${parent}_route_r2__system_notifications`)?.disabled === false);
}
t('deploy sends no DELETE', !reqs.includes('DELETE'));

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
