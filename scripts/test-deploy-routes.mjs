// Spec 029 acceptance 3 on a fake Cribl: alertsPlan writes the route and default notifications through
// notificationsFor, writes the F1 route searches (routingMode 'vt_results'), and disables removed routes (full
// object, disabled: true) without ever sending DELETE. Run: node scripts/test-deploy-routes.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-dr-'));
const build = (entry, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/deploy.ts', 'd.mjs');
build('src/lib/routes.ts', 'r.mjs');
const D = await import(join(tmp, 'd.mjs'));
const R = await import(join(tmp, 'r.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const P1 = { id: 'r1', name: 'P1 to PagerDuty', when: { maxCriticality: 1 }, targets: ['pulse_pd'], severity: 'critical', final: true };
const NET = { id: 'r2', name: 'Network team', when: { team: 'network' }, targets: ['pulse_slack_net'], final: false };
const mk = (routes) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: ['system_notifications'], email: '', routes }, learning });
const known = [{ id: 'pulse_pd', type: 'pager_duty' }, { id: 'pulse_slack_net', type: 'slack' }, { id: 'system_notifications', type: 'bulletin_message' }];

/** A fake Cribl Search: saved searches and notifications kept in memory; every request recorded. */
function fakeCribl(store) {
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)).pathname.replace(/^\/api\/v1/, '');
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ u, method, body });
    const m = /^\/m\/default_search\/(search\/saved|notifications)(?:\/([^/]+))?$/.exec(u);
    const reply = (status, v) => ({ ok: status < 400, status, text: async () => JSON.stringify(v) });
    if (!m) return reply(404, { error: `no route ${u}` });
    const col = store[m[1]];
    if (method === 'GET' && !m[2]) return reply(200, { items: col });
    if (method === 'POST' && !m[2]) { if (col.some((x) => x.id === body.id)) return reply(409, { error: 'exists' }); col.push(body); return reply(200, { items: [body] }); }
    if (method === 'PATCH' && m[2]) {
      const i = col.findIndex((x) => x.id === m[2]);
      if (i < 0) return reply(404, { error: 'missing' });
      col[i] = body; // Search replaces the object: a partial PATCH would lose fields
      return reply(200, { items: [body] });
    }
    return reply(405, { error: `${method} not allowed` });
  };
  return calls;
}

const apply = async (s, store) => {
  const calls = fakeCribl(store);
  const plan = D.alertsPlan(s, true, undefined, known, { origin: 'https://org.cribl.cloud', base: '/app-ui/pulse' });
  // Every Search step of the plan (the lookups need KV and are covered elsewhere).
  for (const st of plan.filter((x) => x.id.startsWith('pulse_'))) await st.run();
  return { calls, plan };
};

/* ── acceptance 3 ── */
const store = { 'search/saved': [], notifications: [] };
const { calls, plan } = await apply(mk([P1, NET]), store);
const note = (id) => store.notifications.find((n) => n.id === id);
const r1 = note('pulse_alert_missing_route_r1__pulse_pd'), r2 = note('pulse_alert_missing_route_r2__pulse_slack_net'), def = note('pulse_alert_missing_notification');
t('writes pulse_alert_missing_route_r1 (→ pulse_pd)', !!r1 && r1.targets.join() === 'pulse_pd');
t('writes pulse_alert_missing_route_r2_slack (→ pulse_slack_net)', !!r2 && r2.targets.join() === 'pulse_slack_net');
t('writes pulse_alert_missing_notification (→ system_notifications)', !!def && def.targets.join() === 'system_notifications');
// Review fix: in vt_results mode the default reads its own F1 search (no custom trigger, t0.md).
const dsq = store['search/saved'].find((x) => x.id === 'pulse_route_default_missing');
const defLine = dsq?.query.split('\n')[0] ?? '';
t('the default excludes P1 through pulse_route_default_missing', defLine.includes('slot == 0') && defLine.includes('not ((toint(criticality) <= 1))')
  && def?.conf.triggerType === 'resultsCount' && def.conf.triggerComparator === '>' && def.conf.triggerCount === 0
  && !String(def.conf.customValue ?? '').includes('slot ==') && def.conf.savedQueryId === 'pulse_route_default_missing');
t('the default does not exclude the non-final network route', !/network/.test(dsq?.query ?? ''));
t('the default text message carries counts and links', def?.conf.message.includes('{{searchResultsUrl}}') && def.conf.message.includes('n_alerts') && def.conf.message.includes('/incidents?asset='));
t('PagerDuty route carries __severity critical', JSON.stringify(r1?.metadata) === JSON.stringify([{ name: '__severity', value: 'critical' }]));
t('Slack route carries the Slack message with the incident link', /^\*P\{\{resultSet\[0\]\.criticality\}\}/.test(r2?.conf.message ?? '') && r2.conf.message.includes('https://org.cribl.cloud/app-ui/pulse/incidents?asset='));
t('every write is a POST or PATCH, no DELETE', calls.every((c) => c.method !== 'DELETE'));
t('plan lists a step per route with its targets', plan.some((x) => x.id === 'pulse_alert_missing_route_r1' && x.detail.includes('pulse_pd'))
  && plan.some((x) => x.id === 'pulse_alert_missing_route_r2' && x.detail.includes('pulse_slack_net')));
t('route steps need their parent', plan.find((x) => x.id === 'pulse_alert_missing_route_r1')?.needs?.includes('pulse_alert_missing'));
t('a route applies to every alert search when kinds is empty', ['pulse_alert_source_down', 'pulse_source_digest'].every((id) => !!note(`${id}_route_r1__pulse_pd`) && !!note(`${id}_route_r2__pulse_slack_net`)));

/* ── vt_results (routingMode, the constant T0 set) ── */
t('routingMode is vt_results', R.routingMode === 'vt_results');
const saved = (id) => store['search/saved'].find((x) => x.id === id);
const rs1 = saved('pulse_route_r1_missing'), rs2 = saved('pulse_route_r2_missing');
t('writes pulse_route_<rid>_<kind> for each route and kind', !!rs1 && !!rs2 && ['source_down', 'digest'].every((k) => !!saved(`pulse_route_r1_${k}`) && !!saved(`pulse_route_r2_${k}`)));
// r1 sends to native PagerDuty only, so its rows are the firing ones (spec 030 §3: the plain pager_duty preset has no auto-resolve).
const rs1Line = rs1?.query.split('\n')[0] ?? '';
t('route search query reads the parent through $vt_results', rs1Line === 'dataset="$vt_results" | where jobName == "pulse_alert_missing" | where slot == 0 and (toint(criticality) <= 1 and event in ("opened", "reminder"))');
t('slot searches keep the parent summary (no one-row recount)', ['pulse_route_r1_missing', 'pulse_route_r1_missing_s2', 'pulse_route_default_missing_s4', 'pulse_route_r2_source_down', 'pulse_route_r2_source_down_s3'].every((id) => {
  const q = saved(id)?.query ?? '';
  return q.length > 0 && q.split('\n').length === 1 && !/project-away|eventstats/.test(q);
}));
t('the route below the final P1 route excludes P1 (Final stops later routes)', rs2?.query.split('\n')[0] === 'dataset="$vt_results" | where jobName == "pulse_alert_missing" | where slot == 0 and (team == "network" and not ((toint(criticality) <= 1)))');
t('grouped kinds use crit_min / teams', saved('pulse_route_r2_source_down')?.query.split('\n')[0] === 'dataset="$vt_results" | where jobName == "pulse_alert_source_down" | where slot == 0 and (teams_j contains_cs ",network," and not ((toint(crit_min) <= 1)))');
t('scheduled 2 minutes after the parent', rs1?.schedule.cronSchedule === '1-59/5 * * * *' && saved('pulse_route_r1_source_down')?.schedule.cronSchedule === '1-59/5 * * * *'
  && saved('pulse_route_r1_digest')?.schedule.cronSchedule === '9 * * * *');
t('route notification (slot 0) is resultsCount on its slot search', r1?.conf.triggerType === 'resultsCount' && r1.conf.savedQueryId === 'pulse_route_r1_missing'
  && !String(r1.conf.customValue ?? '').includes('slot ==') && r2?.conf.savedQueryId === 'pulse_route_r2_missing');
const nf = await apply(mk([NET]), { 'search/saved': [], notifications: [] });
const nd0 = nf.calls.find((c) => c.body?.id === 'pulse_alert_missing_notification')?.body;
t('no final route: default points at pulse_route_default_missing slot search', nd0?.conf.triggerType === 'resultsCount' && nd0.conf.savedQueryId === 'pulse_route_default_missing');
t('no final route: five default slot searches (_s1 … _s4)', [0, 1, 2, 3, 4].every((i) => {
  const sid = i ? `pulse_route_default_missing_s${i}` : 'pulse_route_default_missing';
  const s = store['search/saved'].find((x) => x.id === sid);
  return s?.query.split('\n')[0].includes(`slot == ${i}`);
}));
t('five slot notifications per route and default (_s1 … _s4), each on its own derived search',
  [0, 1, 2, 3, 4].every((i) => { const id = (b) => (i ? `${b}_s${i}` : b); const n1 = note(id('pulse_alert_missing_route_r1__pulse_pd')), nd = note(id('pulse_alert_missing_notification'));
    const rs = i ? `pulse_route_r1_missing_s${i}` : 'pulse_route_r1_missing';
    const ds = i ? `pulse_route_default_missing_s${i}` : 'pulse_route_default_missing';
    return n1?.conf.triggerType === 'resultsCount' && n1.conf.savedQueryId === rs && nd?.conf.savedQueryId === ds && nd.conf.message.includes('resultSet[0]') && !nd.conf.message.includes('resultSet[1]'); }));
t('shiftCron',R.shiftCron('*/5 * * * *') === '2-59/5 * * * *' && R.shiftCron('58 * * * *') === '0 * * * *' && R.shiftCron('7 * * * *') === '9 * * * *'
  && R.shiftCron('4-59/5 * * * *') === '1-59/5 * * * *' && R.shiftCron('3-59/5 * * * *') === '*/5 * * * *');

/* ── a removed route is disabled with its full object, never deleted ── */
const before = structuredClone(note('pulse_alert_missing_route_r2__pulse_slack_net'));
note('pulse_alert_missing_route_r2__pulse_slack_net').status = { lastRun: 1 }; // read-only field the API returns
const second = await apply(mk([P1]), store);
const off = second.calls.filter((c) => c.method === 'PATCH' && c.u === '/m/default_search/notifications/pulse_alert_missing_route_r2__pulse_slack_net');
t('removed route notification PATCHed once', off.length === 1);
t('… with disabled: true', off[0]?.body.disabled === true);
t('… keeping the stored fields (targets, conf, metadata)', JSON.stringify(off[0]?.body.targets) === JSON.stringify(before.targets)
  && off[0]?.body.conf.savedQueryId === before.conf.savedQueryId && off[0]?.body.conf.message === before.conf.message && Array.isArray(off[0]?.body.metadata));
t('… without the read-only status', off[0] && !('status' in off[0].body));
t('other kinds\' r2 notifications disabled too', ['pulse_alert_source_down', 'pulse_source_digest'].every((id) => note(`${id}_route_r2__pulse_slack_net`)?.disabled === true));
t('the live route stays enabled', note('pulse_alert_missing_route_r1__pulse_pd')?.disabled === false);
t('the removed route search stops running (schedule off, full body)', saved('pulse_route_r2_missing')?.schedule.enabled === false && saved('pulse_route_r2_missing')?.query === rs2.query);
t('no DELETE request is sent', second.calls.every((c) => c.method !== 'DELETE'));
const third = await apply(mk([P1]), store);
t('an already disabled notification is not PATCHed again', !third.calls.some((c) => c.method === 'PATCH' && /route_r2/.test(c.u)));


/* ── review fix (blocking): default notifications are disabled when their targets go ── */
const st2 = { 'search/saved': [], notifications: [] };
const withSlack = { ...mk([]), notify: { targets: ['system_notifications', 'pulse_slack_net'], email: '', routes: [] } };
await apply(withSlack, st2);
const n2 = (id) => st2.notifications.find((n) => n.id === id);
t('a Slack default target writes _notification__pulse_slack_net', n2('pulse_alert_missing_notification__pulse_slack_net')?.disabled === false);
await apply(mk([]), st2); // Slack switched off under Channels
t('… switching it off disables _notification__pulse_slack_net', n2('pulse_alert_missing_notification__pulse_slack_net')?.disabled === true);
t('… the text default stays enabled', n2('pulse_alert_missing_notification')?.disabled === false);
// 029 upgrade with only a Slack default target: the first default target takes _notification, the old 029 _notification_slack is disabled (no duplicate Slack).
const st3 = { 'search/saved': [], notifications: [{ id: 'pulse_alert_missing_notification_slack', disabled: false, targets: ['pulse_slack_net'], conf: { savedQueryId: 'pulse_alert_missing', message: 'old' } }] };
await apply({ ...mk([]), notify: { targets: ['pulse_slack_net'], email: '', routes: [] } }, st3);
t('029 _notification_slack disabled, Slack default now on _notification (no duplicate Slack)', st3.notifications.find((n) => n.id === 'pulse_alert_missing_notification_slack')?.disabled === true
  && st3.notifications.find((n) => n.id === 'pulse_alert_missing_notification')?.disabled === false);
// Final route removed: default back on the parent, the default search stops running.
const st4 = { 'search/saved': [], notifications: [] };
await apply(mk([P1]), st4);
await apply(mk([]), st4);
t('final route removed: default reads pulse_route_default_missing', st4.notifications.find((n) => n.id === 'pulse_alert_missing_notification')?.conf.savedQueryId === 'pulse_route_default_missing');
t('… and pulse_route_default_missing stays enabled (no final → default slot searches)', st4['search/saved'].find((x) => x.id === 'pulse_route_default_missing')?.schedule.enabled !== false);

/* ── review fix (major): a caller without the target list (AskBar) writes the same bodies ── */
{
  const st5 = { 'search/saved': [], notifications: [] };
  fakeCribl(st5);
  const inner = globalThis.fetch;
  globalThis.fetch = async (url, init) => new URL(String(url)).pathname.endsWith('/notification-targets')
    ? { ok: true, status: 200, text: async () => JSON.stringify({ items: known }) } : inner(url, init);
  const plan5 = D.alertsPlan(mk([P1, NET]), true, undefined, [], {});
  for (const st of plan5.filter((x) => x.id.startsWith('pulse_'))) await st.run();
  const n5 = (id) => st5.notifications.find((n) => n.id === id);
  t('AskBar plan: Slack route gets _route_r2__pulse_slack_net with the Slack message', /^\*P/.test(n5('pulse_alert_missing_route_r2__pulse_slack_net')?.conf.message ?? '') && !n5('pulse_alert_missing_route_r2'));
  t('AskBar plan: PagerDuty route keeps __severity', JSON.stringify(n5('pulse_alert_missing_route_r1__pulse_pd')?.metadata) === JSON.stringify([{ name: '__severity', value: 'critical' }]));
}

/* ── deploy.ts builds no notification body of its own ── */
const src = readFileSync(join(root, 'src/lib/deploy.ts'), 'utf8');
t('deploy.ts has no targetConfigs and no inline notification body', !/targetConfigs/.test(src) && !/condition:\s*'search'/.test(src) && /notificationsFor\(/.test(src));
t('deploy.ts sends no DELETE', !/method:\s*['"]DELETE['"]/.test(src));

if (fail) process.exit(1);
