// Table tests for src/lib/routes.ts. Run: node scripts/test-routes.mjs
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rt-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/routes.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'r.mjs')}`], { stdio: 'pipe' });
const mod = await import(join(tmp, 'r.mjs'));
const { routeCondition, formatFor, routingMode } = mod;

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

t('routingMode', routingMode === 'vt_results');
t('crit + team', routeCondition({ maxCriticality: 2, team: 'network' }) === 'toint(criticality) <= 2 and team == "network"');
t('empty', routeCondition({}) === 'true');
t('kinds ignored', routeCondition({ kinds: ['missing'] }) === 'true');
t('input', routeCondition({ input: 'in1' }) === 'input == "in1"');
t('all three', routeCondition({ maxCriticality: 1, team: 't', input: 'i' }) === 'toint(criticality) <= 1 and team == "t" and input == "i"');
t('quote escaped', routeCondition({ team: 'a"b' }) === 'team == "a\\"b"');
t('backslash escaped', routeCondition({ team: 'a\\b' }) === 'team == "a\\\\b"');
t('backslash then quote', routeCondition({ team: '\\"' }) === 'team == "\\\\\\""');
const OFF = ['opened', 'reminder'];
t('digest routeCondition skips the event clause', routeCondition({ events: OFF }, 'digest') === 'true' && routeCondition({ maxCriticality: 1, team: 'lab', events: OFF }, 'digest') === 'toint(crit_min) <= 1 and teams_j contains_cs ",lab,"');
t('missing and source_down keep the event clause', routeCondition({ events: OFF }, 'missing') === 'event in ("opened", "reminder")' && routeCondition({ events: OFF }, 'source_down') === 'event in ("opened", "reminder")');

for (const [ty, f] of [['slack', 'slack'], ['smtp', 'text'], ['bulletin_message', 'text'], ['sns', 'text'], ['pager_duty', 'text'], ['webhook', 'json'], ['weird', 'text']]) {
  t(`formatFor ${ty}`, formatFor(ty) === f);
}

// ---- message builders (alertEvent, slackMessage, textMessage) ----
const { alertEvent, slackMessage, textMessage, ALERT_COLUMNS, ALERT_CAPS } = mod;
const KINDS = ['missing', 'source_down', 'digest'];
const V1_KEYS = ['source', 'v', 'kind', 'state', 'event', 'incident_id', 'severity', 'asset', 'input', 'worker_group', 'criticality', 'team', 'silent_min', 'tolerance_s', 'n_alerts', 'others', 'summary', 'url', 'at'];
const DIGEST_KEYS = V1_KEYS.filter((k) => k !== 'state' && k !== 'event' && k !== 'incident_id');

// One row per kind, holding ONLY the columns that kind's query emits (after T2), as Search would render them.
const rows = {
  missing: { severity: 'critical', state: 'firing', event: 'opened', incident_id_s: 'pulse:asset:wg-prod:in_syslog:fw01:1763460000', asset_s: 'fw01', asset_u: 'fw01', input_s: 'in_syslog', worker_group_s: 'wg-prod', team_s: 'network', others_s: 'web02, web03', more_s: '(+2 more: web02, web03)', criticality: '1', silent_min: '12', tolerance_s: '300', n_alerts: '3',
    lead_s: 'fw01 stopped sending to in_syslog (wg-prod)', msg_s: 'fw01 stopped sending to in_syslog (wg-prod). Silent 12 min (tolerance 300 s).' },
  source_down: { severity: 'error', state: 'firing', event: 'opened', incident_id_s: 'pulse:source:wg-prod:in_syslog::1763460000', input_s: 'in_syslog', input_u: 'in_syslog', worker_group_s: 'wg-prod', teams_s: 'network, web', missing_s: 'fw01, web02, web03', more_s: '', crit_min: '2', s_live: '4', s_missing: '3', pct: '75',
    lead_s: 'in_syslog (wg-prod) lost 3 of 4 assets at once (75%)', msg_s: 'in_syslog (wg-prod) lost 3 of 4 assets at once (75%). Check the source, its forwarder or the network before the hosts. Missing: fw01, web02, web03.' },
  digest: { severity: 'warning', input_s: 'in_tcp', input_u: 'in_tcp', worker_group_s: 'wg-dev', teams_s: 'lab', missing_s: 'lab01', signals_s: 'lab02 (lag)', more_s: '(+1 more: in_http)', crit_min: '3', expected: '10', current: '9', missing: '1', signals: '2' },
};
// Keys of each sample row are exactly the contract.
for (const k of KINDS) t(`${k}: sample row = column contract`, JSON.stringify(Object.keys(rows[k]).sort()) === JSON.stringify([...ALERT_COLUMNS[k].strings, ...ALERT_COLUMNS[k].numbers].sort()));

const URL = 'https://org.cribl.cloud/search?job=1';
function render(tpl, row, extra = {}) {
  return tpl.replace(/\{\{([^}]+)\}\}/g, (_, expr) => {
    if (expr === 'searchResultsUrl') return extra.url ?? URL;
    if (expr === 'timestamp') return '2026-11-18T10:00:00Z';
    const m = /^resultSet\[0\]\.(\w+)$/.exec(expr);
    if (!m || !(m[1] in row)) throw new Error(`unknown placeholder {{${expr}}}`);
    return row[m[1]];
  });
}
const cols = (tpl) => [...tpl.matchAll(/\{\{resultSet\[(\d+)\]\.(\w+)\}\}/g)].map((m) => m[2]);
const ORIGIN = { origin: 'https://org.cribl.cloud', base: '/app-ui/cc-pulse' };

for (const k of KINDS) {
  const row = rows[k];
  const contract = [...ALERT_COLUMNS[k].strings, ...ALERT_COLUMNS[k].numbers];
  const tpls = [alertEvent(0, k), slackMessage(k), textMessage(k), slackMessage(k, ORIGIN), textMessage(k, ORIGIN)];
  t(`${k}: templates read only the kind's columns`, tpls.every((x) => cols(x).every((c) => contract.includes(c))));
  t(`${k}: every message carries {{searchResultsUrl}}`, tpls.every((x) => x.includes('{{searchResultsUrl}}')));
  let ev;
  try { ev = JSON.parse(render(alertEvent(0, k), row)); } catch { ev = null; }
  t(`${k}: alertEvent parses`, ev != null);
  t(`${k}: alertEvent has exactly the v1 keys`, ev && JSON.stringify(Object.keys(ev)) === JSON.stringify(k === 'digest' ? DIGEST_KEYS : V1_KEYS));
  t(`${k}: alertEvent fixed fields`, ev && ev.source === 'pulse' && ev.v === 1 && ev.kind === k && (k === 'digest' ? !('state' in ev) && !('event' in ev) && !('incident_id' in ev) : ev.state === 'firing') && ev.url === URL && ev.at === '2026-11-18T10:00:00Z');
  t(`${k}: alertEvent numbers`, ev && typeof ev.criticality === 'number' && typeof ev.n_alerts === 'number');
  t(`${k}: alertEvent row index`, alertEvent(2, k).includes('{{resultSet[2].') && !alertEvent(2, k).includes('{{resultSet[0].'));
  t(`${k}: slack mrkdwn`, /^\*[^*]+\* — /.test(slackMessage(k)) && slackMessage(k).includes('<{{searchResultsUrl}}|Open>'));
  t(`${k}: no incident link without origin`, !textMessage(k).includes('/incidents') && !slackMessage(k).includes('/incidents'));
  t(`${k}: incident link with origin`, textMessage(k, ORIGIN).includes('https://org.cribl.cloud/app-ui/cc-pulse/incidents?') && slackMessage(k, ORIGIN).includes('<https://org.cribl.cloud/app-ui/cc-pulse/incidents?'));
  t(`${k}: more suffix`, textMessage(k).includes('{{resultSet[0].more_s}}') && slackMessage(k).includes('{{resultSet[0].more_s}}'));

  // Worst case: others / missing_s at its 300-char max, the suffix carrying it, long names and a long results URL.
  // Every string column at its cap (others_s / missing_s = 300), numbers at large values.
  t(`${k}: every string column has a cap`, ALERT_COLUMNS[k].strings.every((c) => c === 'severity' || c === 'state' || c === 'event' || ALERT_CAPS[k][c] > 0));
  const long = { ...row };
  for (const c of ALERT_COLUMNS[k].strings) if (c !== 'severity' && c !== 'state' && c !== 'event') long[c] = 'x'.repeat(ALERT_CAPS[k][c]);
  for (const c of ALERT_COLUMNS[k].numbers) long[c] = '9999';
  long.severity = 'critical'; long.state = 'resolved'; long.event = 'expired';
  t(`${k}: others at its 300-char max`, (long.others_s ?? long.missing_s).length === 160);
  const longUrl = 'https://main-abcdefgh-ijklmnop.cribl.cloud/search/jobs/1763460000000.12345?group=default_search&tab=results';
  const evLong = render(alertEvent(0, k), long, { url: longUrl });
  t(`${k}: alertEvent ≤ 1000 chars with others at 300 (${evLong.length})`, evLong.length <= 1000 && JSON.parse(evLong).others.length >= 48);
  const txtLong = render(textMessage(k, ORIGIN), long, { url: longUrl });
  t(`${k}: PagerDuty text ≤ 1000 chars with others at 300 (${txtLong.length})`, txtLong.length <= 1000);
  const slLong = render(slackMessage(k, ORIGIN), long, { url: longUrl });
  t(`${k}: slack ≤ 1000 chars (${slLong.length})`, slLong.length <= 1000);
}

// Rendered sentences, one per kind.
const sl = render(slackMessage('missing'), { ...rows.missing, more_s: '' });
t('missing: slack sentence', sl === '*P1 · network* — fw01 stopped sending to in_syslog (wg-prod). Silent 12 min (tolerance 300 s).  <' + URL + '|Open>');
t('missing: text sentence', render(textMessage('missing'), rows.missing) === 'Pulse [P1 network]: fw01 stopped sending to in_syslog (wg-prod). Silent 12 min (tolerance 300 s). Alerts this run: 3. (+2 more: web02, web03) Results: ' + URL);
t('missing: incident link', render(textMessage('missing', ORIGIN), rows.missing).endsWith(' Incident: https://org.cribl.cloud/app-ui/cc-pulse/incidents?asset=fw01'));
t('missing: event summary', JSON.parse(render(alertEvent(0, 'missing'), rows.missing)).summary === 'P1 network: fw01 stopped sending to in_syslog (wg-prod)');
const ev0 = JSON.parse(render(alertEvent(0, 'missing'), rows.missing));
t('missing: event values', ev0.asset === 'fw01' && ev0.criticality === 1 && ev0.team === 'network' && ev0.silent_min === 12 && ev0.tolerance_s === 300 && ev0.n_alerts === 3 && ev0.others === 'web02, web03' && ev0.severity === 'critical');

t('source_down: slack sentence', render(slackMessage('source_down'), rows.source_down) === '*P2 · network, web* — in_syslog (wg-prod) lost 3 of 4 assets at once (75%). Check the source, its forwarder or the network before the hosts. Missing: fw01, web02, web03.  <' + URL + '|Open>');
t('source_down: text sentence', render(textMessage('source_down'), rows.source_down) === 'Pulse [P2 network, web]: in_syslog (wg-prod) lost 3 of 4 assets at once (75%). Check the source, its forwarder or the network before the hosts. Missing: fw01, web02, web03.  Results: ' + URL);
t('source_down: incident link by input', render(textMessage('source_down', ORIGIN), rows.source_down).endsWith(' Incident: https://org.cribl.cloud/app-ui/cc-pulse/incidents?input=in_syslog'));
const ev1 = JSON.parse(render(alertEvent(0, 'source_down'), rows.source_down));
t('source_down: event values', ev1.asset === '' && ev1.criticality === 2 && ev1.team === 'network, web' && ev1.silent_min === null && ev1.tolerance_s === null && ev1.n_alerts === 3 && ev1.others === 'fw01, web02, web03' && ev1.severity === 'error');

t('digest: slack sentence', render(slackMessage('digest'), rows.digest) === '*Digest P3 · lab* — in_tcp (wg-dev) has 9/10 assets reporting, 1 missing, 2 with signals. Missing: lab01. Signals: lab02 (lag). (+1 more: in_http) <' + URL + '|Open>');
t('digest: text sentence', render(textMessage('digest'), rows.digest) === 'Pulse digest [P3 lab]: in_tcp (wg-dev) has 9/10 assets reporting, 1 missing, 2 with signals. Missing: lab01. Signals: lab02 (lag). (+1 more: in_http) Results: ' + URL);
const ev2 = JSON.parse(render(alertEvent(0, 'digest'), rows.digest));
t('digest: event values', ev2.kind === 'digest' && ev2.criticality === 3 && ev2.team === 'lab' && ev2.n_alerts === 1 && ev2.others === 'lab01' && ev2.input === 'in_tcp' && ev2.worker_group === 'wg-dev' && ev2.severity === 'warning' && !!ev2.summary);
t('digest: JSON has no state, event, or incident_id', !('state' in ev2) && !('event' in ev2) && !('incident_id' in ev2));
const digestTpls = [alertEvent(0, 'digest'), slackMessage('digest'), textMessage('digest')].join('\n');
t('digest templates read no state, event, or incident_id', !/\{\{resultSet\[\d+\]\.(state|event|incident_id)/.test(digestTpls) && !/pulse:(asset|source):/.test(digestTpls));
t('digest columns omit lifecycle', !['state', 'event', 'incident_id_s'].some((c) => ALERT_COLUMNS.digest.strings.includes(c) || ALERT_COLUMNS.digest.numbers.includes(c)));
t('missing and source_down columns keep lifecycle', ['missing', 'source_down'].every((k) => ['state', 'event', 'incident_id_s'].every((c) => ALERT_COLUMNS[k].strings.includes(c))));

// An absent column must not slip through as invalid JSON: the renderer refuses unknown placeholders.
let threw = false;
try { render(alertEvent(0, 'source_down'), rows.missing); } catch { threw = true; }
t('render rejects a column the kind does not emit', threw);

// ---- notificationsFor / staleNotifications ----
const { notificationsFor, staleNotifications } = mod;
const S = { id: 'pulse_alert_missing', desc: 'Pulse alert: d', message: 'm' };
const TT = { system_notifications: 'bulletin_message', system_email: 'smtp', pulse_slack: 'slack', pulse_pd: 'pager_duty', pulse_wh: 'webhook' };
const D = { targets: ['system_notifications'], email: 'ops@example.com' };
const nf = (rs, d = D, s = S) => notificationsFor(s, rs, d, { targetTypes: TT });
const legacy = { id: 'pulse_alert_missing_notification', disabled: false, condition: 'search', group: 'default_search',
  targets: ['system_notifications', 'system_email'], metadata: [],
  targetConfigs: [{ id: 'system_notifications', conf: {} },
    { id: 'system_email', conf: { emailRecipient: { to: 'ops@example.com', ccEnabled: false }, subject: S.desc, includeResults: true, attachmentType: 'inline' } }],
  conf: { triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0, savedQueryId: 'pulse_alert_missing' } };
const n0 = nf([]);
const legacy1 = { ...legacy, targets: ['system_email'], targetConfigs: [legacy.targetConfigs[1]] };
t('no routes: first default target (email) keeps the 0.2.8 id; others get __<target>', n0.length === 10 && n0.slice(0, 5).map((n) => n.id).join() === 'pulse_alert_missing_notification,' + [1, 2, 3, 4].map((i) => `pulse_alert_missing_notification_s${i}`).join() && n0[5].id === 'pulse_alert_missing_notification__system_notifications' && JSON.stringify({ ...n0[0], conf: { ...n0[0].conf, message: undefined } }) === JSON.stringify(legacy1));
// Review fix: the default text notification carries counts and links like every other message (spec §3).
t('no routes: default text message = textMessage (counts + links)', n0[0].conf.message === textMessage('missing') && n0[0].conf.message.includes('{{searchResultsUrl}}') && n0[0].conf.message.includes('n_alerts'));
const nS = nf([], { targets: ['system_notifications', 'pulse_slack'], email: '' });
t('slack default → _notification__pulse_slack', nS.map((n) => n.id).join() === ['', '_s1', '_s2', '_s3', '_s4'].map((x) => `pulse_alert_missing_notification${x}`).concat(['', '_s1', '_s2', '_s3', '_s4'].map((x) => `pulse_alert_missing_notification__pulse_slack${x}`)).join() && nS[5].targets.join() === 'pulse_slack' && nS[5].conf.message === slackMessage('missing'));
const p1 = { id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: ['pulse_pd'], severity: 'critical', final: true };
const n1 = nf([p1]);
const r1 = n1.find((n) => n.id === 'pulse_alert_missing_route_r1__pulse_pd');
t('P1 route condition', !!r1 && JSON.stringify(r1.conf).includes('toint(criticality) <= 1'));
t('default excludes P1', n1.find((n) => n.id === 'pulse_alert_missing_notification').conf.customValue === 'not ((toint(criticality) <= 1))');
t('PD severity metadata', JSON.stringify(r1.metadata) === '[{"name":"__severity","value":"critical"}]');
t('non-final route leaves default', !('customValue' in (nf([{ ...p1, final: false }]).find((n) => n.id.endsWith('_notification'))?.conf ?? {})));
t('kinds exclude search', !nf([{ ...p1, when: { kinds: ['source_down'] } }]).some((n) => n.id.includes('_route_')));
const nm = nf([{ id: 'r2', name: 'n', when: { team: 'network' }, targets: ['pulse_slack', 'pulse_wh'], final: false }]).map((n) => n.id);
t('slack + webhook split', nm.includes('pulse_alert_missing_route_r2__pulse_slack') && nm.includes('pulse_alert_missing_route_r2__pulse_wh') && !nm.includes('pulse_alert_missing_route_r2'));

// Spec 035: one body per (search or route, target).
{
  const D35 = { targets: ['system_notifications', 'pulse_slack_ops'], email: 'ops@acme.io' };
  const TT35 = { ...TT, pulse_slack_ops: 'slack', pulse_slack_net: 'slack', system_notifications: 'bulletin_message' };
  const run = (rs, d = D35, s = S) => notificationsFor(s, rs, d, { targetTypes: TT35 });
  const base = (ns) => ns.filter((n) => !/_s[1-4]$/.test(n.id));
  const a = base(run([]));
  t('035 no routes: three bodies, email first with the 0.2.8 id', a.map((n) => n.id).join() === 'pulse_alert_missing_notification,pulse_alert_missing_notification__system_notifications,pulse_alert_missing_notification__pulse_slack_ops' && a[0].targets.join() === 'system_email');
  t('035 no routes: Slack default carries the Slack message', a[2].conf.message === slackMessage('missing') && a[1].conf.message === textMessage('missing'));
  t('035 email conf is the target\'s own', a[0].targetConfigs[0].conf.emailRecipient.to === 'ops@acme.io' && a[0].targetConfigs[0].conf.subject === S.desc && Object.keys(a[1].targetConfigs[0].conf).length === 0);
  const r1b = { id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: ['pulse_pd'], severity: 'critical', final: true };
  const r2b = { id: 'r2', name: 'net', when: { team: 'network' }, targets: ['pulse_slack_net', 'pulse_wh'], final: false };
  const all = run([r1b, r2b]);
  const b = base(all);
  const byId = (id) => b.find((n) => n.id === id);
  t('035 routes: ids', ['pulse_alert_missing_route_r1__pulse_pd', 'pulse_alert_missing_route_r2__pulse_slack_net', 'pulse_alert_missing_route_r2__pulse_wh', 'pulse_alert_missing_notification', 'pulse_alert_missing_notification__system_notifications', 'pulse_alert_missing_notification__pulse_slack_ops'].every((id) => byId(id)) && b.length === 6);
  t('035 routes: formats', byId('pulse_alert_missing_route_r2__pulse_slack_net').conf.message === slackMessage('missing') && byId('pulse_alert_missing_route_r2__pulse_wh').conf.message === alertEvent(0, 'missing'));
  t('035 routes: PagerDuty metadata and condition', JSON.stringify(byId('pulse_alert_missing_route_r1__pulse_pd').metadata) === '[{"name":"__severity","value":"critical"}]' && byId('pulse_alert_missing_route_r1__pulse_pd').conf.customValue === 'toint(criticality) <= 1 and event in ("opened", "reminder")');
  t('035 routes: conditions', byId('pulse_alert_missing_route_r2__pulse_wh').conf.customValue === 'team == "network" and not ((toint(criticality) <= 1 and event in ("opened", "reminder")))'.replace(' and event in ("opened", "reminder")', '') && byId('pulse_alert_missing_notification__pulse_slack_ops').conf.customValue === 'not ((toint(criticality) <= 1))' && byId('pulse_alert_missing_notification').conf.customValue === 'not ((toint(criticality) <= 1))');
  t('035: ids unique, one target and one matching targetConfig each', new Set(all.map((n) => n.id)).size === all.length && all.every((n) => n.targets.length === 1 && n.targetConfigs.length === 1 && n.targetConfigs[0].id === n.targets[0]));
  t('035 vt_results: the F1 search name prefixes the ids', run([r2b], D35, { id: 'pulse_route_r1_missing', desc: 'd' }).every((n) => n.id.startsWith('pulse_route_r1_missing_')));
}
const ex = ['pulse_alert_missing_notification', 'pulse_alert_missing_route_r1', 'pulse_alert_missing_route_r2_slack', 'pulse_alert_missing_route_r2_json', 'pulse_alert_missing_route_r9', 'other_route_r1'];
t('stale after removal', staleNotifications('pulse_alert_missing', [p1], ex).join() === 'pulse_alert_missing_route_r1,pulse_alert_missing_route_r2_slack,pulse_alert_missing_route_r2_json,pulse_alert_missing_route_r9');
t('stale (035): 029 format ids are stale, the live __<target> ids are not', staleNotifications('pulse_alert_missing', [p1], ['pulse_alert_missing_route_r1__pulse_pd', 'pulse_alert_missing_route_r1__pulse_pd_s2', 'pulse_alert_missing_route_r1__gone', 'pulse_alert_missing_route_r2_slack']).join() === 'pulse_alert_missing_route_r1__gone,pulse_alert_missing_route_r2_slack');

// Review fix (blocking): default-route notifications are disabled once the settings stop producing them.
const { staleDefaults, defaultSearchQuery, defaultSearchId } = mod;
const M = 'pulse_alert_missing';
const have = [`${M}_notification`, `${M}_notification_slack`, `${M}_notification_json`, `${M}_route_r1`, 'pulse_alert_source_down_notification_slack'];
const idsOf = (d) => nf([], d).map((n) => n.id);
t('staleDefaults: Slack switched off → its _notification_slack', staleDefaults(M, idsOf({ targets: ['system_notifications'], email: '' }), have).join() === `${M}_notification_slack,${M}_notification_json`);
t('staleDefaults: only Slack left → it takes _notification (035), the 029 format ids are stale', staleDefaults(M, idsOf({ targets: ['pulse_slack'], email: '' }), have).join() === `${M}_notification_slack,${M}_notification_json`);
t('staleDefaults: 035 ids are never stale, 029 format ids always are, other searches untouched', staleDefaults(M, idsOf({ targets: ['system_notifications', 'pulse_slack', 'pulse_wh'], email: '' }), [...have, `${M}_notification__pulse_slack`]).join() === `${M}_notification_slack,${M}_notification_json`);
// Review fix (major): in vt_results mode the default reads its own $vt_results search, not a custom trigger.
t('defaultSearchQuery: no final route → none', defaultSearchQuery(M, [{ ...p1, final: false }]) === undefined);
t('defaultSearchQuery: final route of another kind → none', defaultSearchQuery(M, [{ ...p1, when: { kinds: ['digest'] } }]) === undefined);
t('defaultSearchQuery: P1 final → parent rows minus P1', defaultSearchQuery(M, [p1]).startsWith('dataset="$vt_results" | where jobName == "pulse_alert_missing" | where not ((toint(criticality) <= 1))\n'));
t('digest default search with recovery off has no event clause', mod.defaultSearchQuery('pulse_source_digest', [], OFF) === undefined);
t('digest default search excludes a final route and does not filter event', mod.defaultSearchQuery('pulse_source_digest', [p1], OFF) === 'dataset="$vt_results" | where jobName == "pulse_source_digest" | where not ((toint(crit_min) <= 1))' + mod.runSummary('digest', true));
t('missing default search with recovery off keeps the event clause', (mod.defaultSearchQuery(M, [], OFF) ?? '').includes('event in ("opened", "reminder")'));
t('defaultSearchQuery: recomputes the run summary over its rows', defaultSearchQuery(M, [p1]).endsWith(mod.runSummary('missing', true)));

// Review 2 fix (major): Final stops later routes, so order matters.
const { effectiveCondition, routeSearchQuery, runSummary } = mod;
const net = { id: 'r2', name: 'net', when: { team: 'network' }, targets: ['pulse_slack'], final: false };
t('effectiveCondition: a route below a final route excludes its alerts', effectiveCondition(net, [p1, net], M) === 'team == "network" and not ((toint(criticality) <= 1))');
t('effectiveCondition: above the final route, nothing excluded', effectiveCondition(net, [net, p1], M) === 'team == "network"');
t('effectiveCondition: a non-final route above excludes nothing', effectiveCondition(net, [{ ...p1, final: false }, net], M) === 'team == "network"');
t('effectiveCondition: a final route of another kind excludes nothing', effectiveCondition(net, [{ ...p1, when: { maxCriticality: 1, kinds: ['digest'] } }, net], M) === 'team == "network"');
t('effectiveCondition: no matchers below a final → only the exclusion', effectiveCondition({ ...net, when: {} }, [p1, { ...net, when: {} }], M) === 'not ((toint(criticality) <= 1))');
t('effectiveCondition: grouped kinds use crit_min', effectiveCondition(net, [p1, net], 'pulse_alert_source_down') === 'teams_j contains_cs ",network," and not ((toint(crit_min) <= 1))');
const n12 = nf([p1, net]).find((n) => n.id === 'pulse_alert_missing_route_r2__pulse_slack');
t('notificationsFor (condition mode): the route below a final excludes it', n12?.conf.customValue === 'team == "network" and not ((toint(criticality) <= 1))');
// Review 2 fix (major): a route search counts and lists only its own rows.
const rq = routeSearchQuery(M, net, [p1, net]);
t('routeSearchQuery: effective condition, then the summary recomputed', rq === 'dataset="$vt_results" | where jobName == "pulse_alert_missing" | where team == "network" and not ((toint(criticality) <= 1))' + runSummary('missing', true));
t('digest route search with recovery off has no event clause', (() => {
  const r = { ...net, when: { team: 'lab' } };
  const q = routeSearchQuery('pulse_source_digest', r, [r], OFF);
  return q.includes('teams_j contains_cs ",lab,"') && !q.includes('event in');
})());
t('source_down route search with recovery off keeps the event clause', routeSearchQuery('pulse_alert_source_down', net, [net], OFF).includes('event in ("opened", "reminder")'));
t('digest vtSearches with recovery off do not filter on event', (() => {
  const ns = nf([p1], { targets: ['pulse_slack'], email: '', events: OFF }, { id: 'pulse_source_digest', desc: 'd' });
  const v = mod.vtSearches('pulse_source_digest', 'pulse_route_default_digest', ns);
  const blob = JSON.stringify(ns) + v.searches.map((s) => s.query).join('\n');
  return ns.length > 0 && v.searches.length > 0 && !blob.includes('event in');
})());
t('runSummary again: drops the parent summary before eventstats', /^\n\| project-away n_alerts, others, others_s, more_s, ev_rank, slot\n\| union \(print __pad = 1, asset = ""\)\n\| extend __pad = iff\(isnull\(__pad\), 0, __pad\)\n\| eventstats n_alerts = countif\(__pad == 0\)/.test(runSummary('missing', true)) && !/project-away (?!__pad)/.test(runSummary('missing')));
t('runSummary grouped again: drops n_rows / more_s', runSummary('digest', true).startsWith('\n| project-away n_rows, more_s\n| union (print __pad = 1, input = "")'));
t('runSummary: sorted before next(), the padding row last', /\| sort by __pad asc, criticality asc, asset asc\n\| extend others = /.test(runSummary('missing')) && /\| sort by __pad asc, crit_min asc, s_missing desc, input asc\n\| extend more_in = /.test(runSummary('source_down')));
t('runSummary: numbers slots after the summary, keeps slot < 5, digest has none', /more_s = [^\n]*\n\| where __pad == 0\n\| project-away __pad\n\| extend ev_rank = iff\(event in \("opened", "reminder"\), 0, 1\)\n\| sort by ev_rank asc, criticality asc, incident_id asc\n\| extend slot = row_number\(0\)\n\| where slot < 5$/.test(runSummary('missing'))
  && /sort by ev_rank asc, crit_min asc, incident_id asc/.test(runSummary('source_down', true)) && !/slot/.test(runSummary('digest', true)));
t('slot notifications: _s<i> ids, own slot and row, digest keeps one', (() => {
  const ns = nf([{ ...p1, targets: ['pulse_slack'] }], { targets: ['pulse_slack'], email: '' });
  const r = ns.filter((n) => n.id.startsWith('pulse_alert_missing_route_r1'));
  const dg = nf([], { targets: ['pulse_slack'], email: '' }, { id: 'pulse_source_digest', desc: 'd' });
  const rs0 = (n) => [...String(n.conf.message).matchAll(/resultSet\[(\d+)\]/g)].map((m) => Number(m[1]));
  return r.length === 5 && r.every((n) => n.conf.customValue === 'toint(criticality) <= 1' && rs0(n).every((x) => x === 0) && !String(n.conf.message).includes('resultSet[1]')) && dg.length === 1;
})());
t('staleNotifications / isRouteNotification: slot ids belong to their route', staleNotifications('pulse_alert_missing', [p1], ['pulse_alert_missing_route_r1__pulse_pd_s3', 'pulse_alert_missing_route_r9_s2']).join() === 'pulse_alert_missing_route_r9_s2'
  && mod.isRouteNotification('pulse_alert_missing_route_r1_slack_s4', 'pulse_alert_missing', 'r1') && mod.staleDefaults('pulse_alert_missing', [], ['pulse_alert_missing_notification_s2']).length === 1);
t('defaultSearchId',defaultSearchId('source_down') === 'pulse_route_default_source_down');
t('stale (F2): 029 default and route format ids are listed, the live r1 id is not', staleNotifications('pulse_alert_missing', [p1], ['pulse_alert_missing_notification_slack', 'pulse_alert_missing_route_r2_slack', 'pulse_alert_missing_route_r2_json', 'pulse_alert_missing_route_r1__pulse_pd']).join() === 'pulse_alert_missing_notification_slack,pulse_alert_missing_route_r2_slack,pulse_alert_missing_route_r2_json');
t('stale (F2): ids from notificationsFor are never stale', (() => {
  for (const cfg of [{ targets: ['system_notifications', 'pulse_slack', 'pulse_wh'], email: 'a@b.c' }, { targets: ['pulse_slack'], email: '' }]) {
    const ids = notificationsFor(S, [p1], cfg, { targetTypes: TT }).map((n) => n.id);
    if (staleNotifications('pulse_alert_missing', [p1], ids).length) return false;
  }
  return true;
})());
t('staleRollCall (035): with [system_email, pulse_slack] the __system_email id is stale, the live __pulse_slack is not', (() => {
  const sr = mod.staleRollCall(['system_email', 'pulse_slack'], ['pulse_roll_call_notification__system_email', 'pulse_roll_call_notification__pulse_slack']);
  return sr.includes('pulse_roll_call_notification__system_email') && !sr.includes('pulse_roll_call_notification__pulse_slack')
    && sr.join() === 'pulse_roll_call_notification__system_email';
})());
t('stale none',staleNotifications('pulse_alert_missing', [p1], ['pulse_alert_missing_route_r1__pulse_pd']).length === 0);

const { whenSentence, moveRoute } = mod;
t('when sentence full', whenSentence({ maxCriticality: 2, team: 'network', kinds: ['missing', 'source_down'] }) === 'P1–P2 · team network · missing, source down');
t('when sentence P1', whenSentence({ maxCriticality: 1 }) === 'P1');
t('when sentence input', whenSentence({ input: 'in1' }) === 'input in1');
t('when sentence empty', whenSentence({}) === 'any alert');
t('moveRoute down', moveRoute([1, 2, 3], 0, 1).join() === '2,1,3');
t('moveRoute up edge', moveRoute([1, 2, 3], 0, -1).join() === '1,2,3');

const { routeMatches, previewCount } = mod;
const ar = { kind: 'missing', criticality: 2, team: 'net', input: 'in1' };
t('match empty', routeMatches({}, ar));
t('match crit ok', routeMatches({ maxCriticality: 2 }, ar));
t('match crit no', !routeMatches({ maxCriticality: 1 }, ar));
t('match team no', !routeMatches({ team: 'x' }, ar));
t('match team+input', routeMatches({ team: 'net', input: 'in1' }, ar));
t('match kinds no', !routeMatches({ kinds: ['digest'] }, ar));
t('match kinds ok', routeMatches({ kinds: ['digest', 'missing'] }, ar));
t('preview count', JSON.stringify(previewCount({ maxCriticality: 1 }, [ar, { ...ar, criticality: 1 }])) === '{"x":1,"y":2}');
t('preview count: a final route above takes its alerts first', JSON.stringify(previewCount({ team: 'net' }, [ar, { ...ar, criticality: 1 }], [{ maxCriticality: 1 }])) === '{"x":1,"y":2}');

const src = readFileSync(join(root, 'src/lib/routes.ts'), 'utf8');
t('pure: no impure imports', !/^\s*import\s/m.test(src) && !/\b(fetch|window|document)\b/.test(src.replace(/\/\/.*$/gm, '')));

process.exit(fails ? 1 : 0);
