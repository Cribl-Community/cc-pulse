// F10 (spec 030): Settings → Alerts "Send recovery notifications" and "Remind every".
// Recovery off must reach what Deploy writes (default route + routes without when.events); remindH must reach both
// ledger writers. Run: node scripts/test-alerts-recovery.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rec-'));
const build = (entry, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/deploy.ts', 'd.mjs');
build('src/lib/routes.ts', 'r.mjs');
build('src/lib/settings.ts', 's.mjs');
build('src/lib/kql.ts', 'k.mjs');
const D = await import(join(tmp, 'd.mjs'));
const R = await import(join(tmp, 'r.mjs'));
const S = await import(join(tmp, 's.mjs'));
const K = await import(join(tmp, 'k.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

/* ── settings defaults ── */
t('default notify.recovery is on', S.DEFAULT_SETTINGS.notify.recovery === true && S.normalizeSettings({}).notify.recovery === true);
t('default notify.remindH is 0', S.DEFAULT_SETTINGS.notify.remindH === 0 && S.normalizeSettings({}).notify.remindH === 0);
t('recovery false survives normalize', S.normalizeSettings({ notify: { targets: [], email: '', routes: [], recovery: false } }).notify.recovery === false);
t('remindH normalized (negative / junk → 0, 4 → 4)', S.normalizeRemindH(-2) === 0 && S.normalizeRemindH('x') === 0 && S.normalizeRemindH(4) === 4
  && S.normalizeSettings({ notify: { targets: [], email: '', routes: [], remindH: 6 } }).notify.remindH === 6);
t('defaultEvents: on → all four', JSON.stringify(S.defaultEvents({ notify: { recovery: true } })) === JSON.stringify(['opened', 'reminder', 'resolved', 'expired']));
t('defaultEvents: off → opened, reminder', JSON.stringify(S.defaultEvents({ notify: { recovery: false } })) === JSON.stringify(['opened', 'reminder']));
t('explicit route when.events survive normalizeRoutes', JSON.stringify(S.normalizeRoutes([{ id: 'r1', name: 'a', when: { events: ['resolved', 'opened', 'bogus'] }, targets: ['x'] }])[0].when.events) === JSON.stringify(['opened', 'resolved']));

/* ── pure routes.ts: the default route and routes without when.events follow the settings default ── */
const OFF = ['opened', 'reminder'];
const NO_REC = 'event in ("opened", "reminder")';
const NET = { id: 'r2', name: 'Network team', when: { team: 'network' }, targets: ['pulse_slack_net'], final: false };
const P1 = { id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: ['pulse_pd'], final: true };
// The bulletin keeps the plain text id and every event; native PagerDuty never gets recoveries (scripts/test-pd-recovery.mjs).
const ALL = { id: 'r3', name: 'All events', when: { team: 'ops', events: ['opened', 'reminder', 'resolved', 'expired'] }, targets: ['system_notifications', 'pulse_pd'], final: false };
const types = { pulse_pd: 'pager_duty', pulse_slack_net: 'slack', system_notifications: 'bulletin_message' };
const nf = (routes, events) => R.notificationsFor({ id: 'pulse_alert_missing', desc: 'd' }, routes, { targets: ['system_notifications'], email: '', events }, { targetTypes: types });
const dOff = nf([], OFF).find((n) => n.id === 'pulse_alert_missing_notification');
const dOn = nf([], undefined).find((n) => n.id === 'pulse_alert_missing_notification');
t('recovery off: default notification triggers only on opened/reminder', dOff?.conf.triggerType === 'resultsCount' && dOff.conf.customValue === NO_REC);
t('recovery on: default notification fires on resultsCount only (resolved/expired included)', dOn?.conf.triggerType === 'resultsCount' && !('customValue' in dOn.conf));
const rOff = nf([NET, ALL], OFF);
t('recovery off: a route without when.events excludes resolved/expired', rOff.find((n) => n.id === 'pulse_alert_missing_route_r2__pulse_slack_net')?.conf.customValue === `team == "network" and ${NO_REC}`);
t('recovery off: a route with explicit events keeps them', rOff.find((n) => n.id === 'pulse_alert_missing_route_r3__system_notifications')?.conf.customValue === 'team == "ops"');
t('recovery on: routes unchanged', nf([NET], undefined).find((n) => n.id === 'pulse_alert_missing_route_r2__pulse_slack_net')?.conf.customValue === 'team == "network"');
t('defaultSearchQuery: off, no final → filters events', R.defaultSearchQuery('pulse_alert_missing', [], OFF) === `dataset="$vt_results" | where jobName == "pulse_alert_missing" | where ${NO_REC}` + R.runSummary('missing', true));
t('defaultSearchQuery: on, no final → none', R.defaultSearchQuery('pulse_alert_missing', []) === undefined && R.defaultSearchQuery('pulse_alert_missing', [], ['opened', 'reminder', 'resolved', 'expired']) === undefined);
t('defaultSearchQuery: off + final', R.defaultSearchQuery('pulse_alert_missing', [P1], OFF) === `dataset="$vt_results" | where jobName == "pulse_alert_missing" | where not ((toint(criticality) <= 1 and ${NO_REC})) and ${NO_REC}` + R.runSummary('missing', true));
t('routeMatches/previewCount follow the default', !R.routeMatches({}, { kind: 'missing', criticality: 1, event: 'resolved' }, OFF) && R.routeMatches({}, { kind: 'missing', criticality: 1, event: 'resolved' })
  && R.previewCount({}, [{ kind: 'missing', criticality: 1, event: 'expired' }, { kind: 'missing', criticality: 1, event: 'opened' }], [], OFF).x === 1);

/* ── alertsPlan on a fake Cribl: what Deploy writes ── */
const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const mk = (routes, recovery) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: ['system_notifications'], email: '', routes, remindH: 0, recovery }, learning });
const known = [{ id: 'pulse_pd', type: 'pager_duty' }, { id: 'pulse_slack_net', type: 'slack' }, { id: 'system_notifications', type: 'bulletin_message' }];
function fakeCribl(store) {
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    const m = /^\/m\/default_search\/(search\/saved|notifications)(?:\/([^/]+))?$/.exec(u);
    const reply = (status, v) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    if (!m) return reply(404, { error: `no route ${u}` });
    const col = store[m[1]];
    if (method === 'GET' && !m[2]) return reply(200, { items: col });
    if (method === 'POST' && !m[2]) { col.push(body); return reply(200, { items: [body] }); }
    if (method === 'PATCH' && m[2]) { const i = col.findIndex((x) => x.id === m[2]); if (i < 0) return reply(404, {}); col[i] = body; return reply(200, { items: [body] }); }
    return reply(405, { error: `${method} not allowed` });
  };
}
const apply = async (s) => {
  const store = { 'search/saved': [], notifications: [] };
  fakeCribl(store);
  const plan = D.alertsPlan(s, true, undefined, known, { origin: 'https://org.cribl.cloud', base: '/app-ui/pulse' });
  for (const st of plan.filter((x) => x.id.startsWith('pulse_'))) await st.run();
  return store;
};
for (const kind of ['missing', 'source_down']) {
  const parent = kind === 'missing' ? 'pulse_alert_missing' : 'pulse_alert_source_down';
  const off = await apply(mk([NET], false));
  const ds = off['search/saved'].find((x) => x.id === `pulse_route_default_${kind}`);
  const def = off.notifications.find((n) => n.id === `${parent}_notification`);
  t(`deploy, recovery off (${kind}): default reads pulse_route_default_${kind} filtered to opened/reminder`, !!ds && ds.query.split('\n')[0].includes(NO_REC) && ds.query.split('\n')[0].includes('slot == 0')
    && def?.conf.triggerType === 'resultsCount' && def?.conf.savedQueryId === ds.id);
  const rs = off['search/saved'].find((x) => x.id === `pulse_route_r2_${kind}`);
  t(`deploy, recovery off (${kind}): route search without when.events excludes recoveries`, !!rs && rs.query.includes(NO_REC));
  const on = await apply(mk([NET], true));
  const defOn = on.notifications.find((n) => n.id === `${parent}_notification`);
  const dsOn = on['search/saved'].find((x) => x.id === `pulse_route_default_${kind}`);
  t(`deploy, recovery on (${kind}): five default slot searches, resultsCount notes`, !!dsOn && dsOn.query.split('\n')[0].includes('slot == 0')
    && defOn?.conf.triggerType === 'resultsCount' && defOn.conf.savedQueryId === `pulse_route_default_${kind}`
    && !String(defOn.conf.customValue ?? '').includes('slot =='));
  t(`deploy, recovery on (${kind}): route slot search has no event clause on first line`, !on['search/saved'].find((x) => x.id === `pulse_route_r2_${kind}`)?.query.split('\n')[0].includes('event in'));
}
const undef = await apply(mk([], undefined));
t('deploy, recovery unset (older settings): treated as on — default slot searches still written', undef['search/saved'].some((x) => x.id === 'pulse_route_default_missing' && x.query.split('\n')[0].includes('slot == 0')));

/* ── remindH reaches ledgerQuery for both writers ── */
for (const rollup of ['off', 'auto']) {
  const base = { ...S.DEFAULT_SETTINGS, rollup };
  for (const id of ['pulse_ledger_asset', 'pulse_ledger_source']) {
    const q0 = K.savedSearches(base).find((x) => x.id === id)?.query ?? '';
    const q4 = K.savedSearches({ ...base, notify: { ...base.notify, remindH: 4 } }).find((x) => x.id === id)?.query ?? '';
    const q2 = K.savedSearches({ ...base, notify: { ...base.notify, remindH: 2 } }).find((x) => x.id === id)?.query ?? '';
    t(`${id} (${rollup}): remindH 0 → no reminder clause`, q0.length > 0 && !/now\(\) - pt >=/.test(q0));
    t(`${id} (${rollup}): remindH 4 → 14400 s`, /now\(\) - pt >= 14400/.test(q4));
    t(`${id} (${rollup}): remindH 2 → 7200 s`, /now\(\) - pt >= 7200/.test(q2));
  }
}

/* ── Alerts page wiring ── */
const page = readFileSync(join(root, 'src/pages/Alerts.tsx'), 'utf8');
t('Alerts: Switch "Send recovery notifications" bound to notify.recovery (default on)', /<Switch aria-label="Send recovery notifications" checked=\{settings\.notify\.recovery !== false\}/.test(page) && page.includes('<Text>Send recovery notifications</Text>'));
t('Alerts: NumberField "Remind every (hours)" bound to notify.remindH (default 0)', /<NumberField label="Remind every \(hours\)" value=\{settings\.notify\.remindH \?\? 0\} min=\{0\}/.test(page) && /remindH: normalizeRemindH\(v\)/.test(page));

/* ── src/state.tsx untouched ── */
// (F7 wired state.tsx to the cadence, so the "untouched" check was retired.)

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);
