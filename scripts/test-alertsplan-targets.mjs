// F4 (spec 035): alertsPlan writes one notification per target, one plan line per notification, disables stale
// format-suffixed IDs, and the roll call / 030 event notifications are split per target too.
// Run: node scripts/test-alertsplan-targets.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-apt-'));
const entry = join(tmp, 'entry.ts');
writeFileSync(entry, `export * from ${JSON.stringify(join(root, 'src/lib/deploy.ts'))};\n`
  + `export { DEFAULT_SETTINGS } from ${JSON.stringify(join(root, 'src/lib/settings.ts'))};\n`
  + `export { staleNotifications, rollCallNotificationIds } from ${JSON.stringify(join(root, 'src/lib/routes.ts'))};\n`);
execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main',
  `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const known = [{ id: 'pulse_slack_ops', type: 'slack' }, { id: 'pulse_pd', type: 'pager_duty' }, { id: 'pulse_slack', type: 'slack' }];
const mk = (notify = {}, extra = {}) => ({ ...D.DEFAULT_SETTINGS, rollup: 'off', ...extra,
  notify: { ...D.DEFAULT_SETTINGS.notify, email: 'ops@acme.io', ...notify } });

/** Runs the plan's Pulse steps against an in-memory Search: saved searches and notifications are kept by id. */
const run = async (s, notes = [], only) => {
  const store = { saved: new Map(), notes: new Map(notes.map((n) => [n.id, n])) };
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url)).pathname;
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ u, method, body });
    const coll = /\/search\/saved(\/[^/]+)?$/.test(u) ? store.saved : /\/notifications(\/[^/]+)?$/.test(u) ? store.notes : undefined;
    if (coll && body?.id && (method === 'POST' || method === 'PATCH')) coll.set(body.id, body);
    const items = coll && method === 'GET' ? [...coll.values()] : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  const plan = D.alertsPlan(s, true, undefined, known);
  for (const st of plan) {
    if (only ? !only(st.id) : !st.id.startsWith('pulse_')) continue;
    try { await st.run(); } catch (e) { console.log(`  (step ${st.id}: ${e.message})`); }
  }
  const writes = calls.filter((c) => /\/notifications(\/|$)/.test(c.u) && c.method !== 'GET');
  return { plan, calls, writes, store };
};
const oneTarget = (b) => b.disabled === true || (b.targets?.length === 1 && b.targetConfigs?.length === 1 && b.targetConfigs[0].id === b.targets[0]);
const strip = (id) => id.replace(/_s[1-9]\d*$/, '');

/* 1 · default settings + an email: one target per body, F1 IDs */
{
  const { writes, plan } = await run(mk());
  t('default+email: notifications were written', writes.length > 0);
  t('default+email: every enabled body has exactly one target and one matching targetConfig', writes.every((c) => oneTarget(c.body)));
  for (const search of ['pulse_alert_missing', 'pulse_alert_source_down', 'pulse_source_digest']) {
    const mine = writes.filter((c) => c.body.id.startsWith(`${search}_notification`) && !c.body.disabled);
    const ids = [...new Set(mine.map((c) => strip(c.body.id)))].sort();
    t(`${search}: IDs follow the F1 rule (${ids.join(', ')})`, ids.join() === [`${search}_notification`, `${search}_notification__system_notifications`].join());
    t(`${search}: the base ID goes to system_email, the other to system_notifications`,
      mine.filter((c) => strip(c.body.id) === `${search}_notification`).every((c) => c.body.targets[0] === 'system_email')
      && mine.filter((c) => strip(c.body.id).endsWith('__system_notifications')).every((c) => c.body.targets[0] === 'system_notifications'));
    const step = plan.find((x) => x.id === search);
    t(`${search}: one plan line per notification (${(step.lines ?? []).join(' | ')})`, Array.isArray(step.lines) && step.lines.length === ids.length
      && step.lines.some((l) => l.startsWith(`${search}_notification → system_email (Email)`))
      && step.lines.some((l) => l.startsWith(`${search}_notification__system_notifications → system_notifications (In-product)`)));
  }
}

/* 2 · plan lines name each target and its kind */
{
  const s = mk({ targets: ['system_notifications', 'pulse_slack_ops'] });
  const plan = D.alertsPlan(s, true, undefined, known);
  const step = plan.find((x) => x.id === 'pulse_alert_missing');
  t('plan line → system_email (Email)', step.lines.some((l) => l.includes('→ system_email (Email)')));
  t('plan line → pulse_slack_ops (Slack)', step.lines.some((l) => l.startsWith('pulse_alert_missing_notification__pulse_slack_ops → pulse_slack_ops (Slack)')));
  t('three lines for three targets', step.lines.length === 3);
  t('the shown detail carries one line per notification', step.lines.every((l) => step.detail.split('\n').includes(l)));
  const { writes } = await run(s, [], (id) => id === 'pulse_alert_missing');
  t('the step writes one body per line (slots aside)', new Set(writes.map((c) => strip(c.body.id))).size === step.lines.length && writes.every((c) => oneTarget(c.body)));
}

/* 3 · stale format-suffixed notifications are disabled, never deleted */
{
  const old = [
    { id: 'pulse_alert_missing_notification_slack', disabled: false, status: 'x', targets: ['pulse_slack_ops', 'system_email'], targetConfigs: [], conf: {} },
    { id: 'pulse_alert_missing_route_r2_json', disabled: false, targets: ['pulse_wh', 'pulse_x'], targetConfigs: [], conf: {} },
    { id: 'pulse_alert_missing_notification', disabled: false, targets: ['system_notifications', 'system_email'], targetConfigs: [], conf: {} },
  ];
  const plan = D.alertsPlan(mk(), true, undefined, known);
  const stale = plan.find((x) => x.id === 'pulse_alert_missing_stale_routes');
  t('stale step is a disable step that never deletes', !!stale && /^Disable/.test(stale.title) && /never deleted/.test(stale.detail));
  const { calls, store } = await run(mk(), old, (id) => id === 'pulse_alert_missing' || id === 'pulse_alert_missing_stale_routes');
  const patched = (id) => calls.filter((c) => c.method === 'PATCH' && c.u.endsWith(`/notifications/${id}`));
  t('…_notification_slack PATCHed with disabled: true, minus status', patched('pulse_alert_missing_notification_slack').some((c) => c.body.disabled === true && !('status' in c.body)));
  t('…_route_r2_json PATCHed with disabled: true', patched('pulse_alert_missing_route_r2_json').some((c) => c.body.disabled === true));
  t('the old two-target base ID is rewritten with one target', store.notes.get('pulse_alert_missing_notification').targets.join() === 'system_email');
  t('stale: no DELETE', !calls.some((c) => c.method === 'DELETE'));
}

/* 4 · roll call (spec 033): one body per target, the ID rule, 033's __<first target> disabled */
{
  const s = mk({ targets: ['system_notifications', 'pulse_slack'] }, { searchLoad: 'daily' });
  const old = [
    { id: 'pulse_roll_call_notification__system_email', disabled: false, status: 's', targets: ['system_email'], targetConfigs: [], conf: {} },
    { id: 'pulse_roll_call_notification__pulse_slack', disabled: false, targets: ['pulse_slack'], targetConfigs: [], conf: {} },
  ];
  const { writes, plan } = await run(s, old, (id) => id === 'pulse_roll_call');
  const live = writes.filter((c) => !c.body.disabled);
  t('roll call: every enabled body has one target', live.length === 3 && live.every((c) => oneTarget(c.body)));
  t('roll call: IDs follow the rule', live.map((c) => `${c.body.id}=${c.body.targets[0]}`).sort().join() ===
    ['pulse_roll_call_notification=system_email', 'pulse_roll_call_notification__pulse_slack=pulse_slack',
      'pulse_roll_call_notification__system_notifications=system_notifications'].sort().join());
  const off = writes.filter((c) => c.body.disabled === true).map((c) => c.body.id);
  t("roll call: 033's __system_email is disabled (PATCH), the live __pulse_slack is not", off.join() === 'pulse_roll_call_notification__system_email'
    && writes.some((c) => c.method === 'PATCH' && c.u.endsWith('/notifications/pulse_roll_call_notification__system_email')));
  const step = plan.find((x) => x.id === 'pulse_roll_call');
  t(`roll call: one plan line per notification (${(step.lines ?? []).join(' | ')})`, step.lines.length === 3
    && step.lines.includes('pulse_roll_call_notification → system_email (Email)')
    && step.lines.includes('pulse_roll_call_notification__pulse_slack → pulse_slack (Slack)'));
  const st = D.staleNotifications('pulse_roll_call', [], ['pulse_roll_call_notification__system_email', 'pulse_roll_call_notification__pulse_slack'], ['system_email', 'pulse_slack']);
  t('staleNotifications lists the roll call __<first target>, not the others', st.join() === 'pulse_roll_call_notification__system_email');
}

/* 5 · 030 events (opened / resolved / reminder / expired) through routes: one body per target */
{
  const routes = [
    { id: 'r1', name: 'P1', when: { maxCriticality: 1, events: ['opened', 'resolved'] }, targets: ['pulse_slack_ops', 'pulse_pd'], severity: 'critical', final: false },
    { id: 'r2', name: 'All', when: { events: ['reminder', 'expired'] }, targets: ['pulse_slack_ops', 'system_email'], final: false },
  ];
  const s = mk({ targets: ['system_notifications', 'pulse_slack_ops'], routes, remindH: 4, recovery: true });
  const { writes, plan } = await run(s);
  t('030 events: every enabled body has one target', writes.length > 0 && writes.every((c) => oneTarget(c.body)));
  const rIds = [...new Set(writes.filter((c) => c.body.id.startsWith('pulse_alert_missing_route_')).map((c) => strip(c.body.id)))].sort();
  t(`030 events: route IDs are <search>_route_<rid>__<target> (${rIds.join(', ')})`, ['pulse_alert_missing_route_r1__pulse_pd', 'pulse_alert_missing_route_r1__pulse_slack_ops',
    'pulse_alert_missing_route_r2__pulse_slack_ops', 'pulse_alert_missing_route_r2__system_email'].every((x) => rIds.includes(x)));
  const r1 = plan.find((x) => x.id === 'pulse_alert_missing_route_r1');
  t(`030 events: route step has one line per target (${(r1.lines ?? []).join(' | ')})`, r1.lines.length === 2
    && r1.lines.some((l) => l.includes('→ pulse_pd (PagerDuty)')) && r1.lines.some((l) => l.includes('→ pulse_slack_ops (Slack)')));
}

/* 6 · source: writeNotification guards every write; notifyTargets is never a body's target list */
{
  const src = readFileSync(join(root, 'src/lib/deploy.ts'), 'utf8');
  t('deploy.ts never passes notifyTargets(s) as a body target list', !/targets:\s*notifyTargets/.test(src));
  let threw = false;
  try { await D.writeNotification({ id: 'x', disabled: false, condition: 'search', group: 'default_search', targets: ['a', 'b'], metadata: [],
    targetConfigs: [{ id: 'a', conf: {} }, { id: 'b', conf: {} }], conf: {} }); } catch { threw = true; }
  t('writeNotification refuses an enabled two-target body', threw);
  t('notifyTargets puts system_email first', D.notifyTargets(mk({ targets: ['pulse_slack_ops'] })).join() === 'system_email,pulse_slack_ops');
}

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('alertsplan-targets ok');
