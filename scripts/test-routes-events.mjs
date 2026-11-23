// Spec 030 §3, review R1: every notification message follows the row's `event`. Run: node scripts/test-routes-events.mjs
// The message templates have no conditionals, so the alert searches compute lead_s / msg_s per row (lifecycleColumns)
// and Slack, text (email, bulletin, PagerDuty) and the JSON `summary` read them. Offline this is a text check of the
// KQL (no KQL interpreter, spec 030 acceptance 2) plus renders of the templates with the values that KQL produces.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rte-'));
const build = (src, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/kql.ts', 'k.mjs');
build('src/lib/routes.ts', 'r.mjs');
const K = await import(join(tmp, 'k.mjs'));
const R = await import(join(tmp, 'r.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const base = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: [], email: '', recovery: true, remindH: 0 }, learning };
const query = (s, id) => K.savedSearches(s).find((x) => x.id === id).query;
const ID = { missing: 'pulse_alert_missing', source_down: 'pulse_alert_source_down' };
const ORIGIN = { origin: 'https://org.cribl.cloud', base: '/app-ui/cc-pulse' };
const tpls = (k) => ({ summary: R.alertEvent(0, k), slack: R.slackMessage(k, ORIGIN), text: R.textMessage(k, ORIGIN) });

// 1. The templates carry no opened-only sentence: the event's sentence comes from the row.
for (const k of Object.keys(ID)) {
  for (const [name, tpl] of Object.entries(tpls(k))) {
    t(`${k} ${name}: no hard-coded opened sentence`, !/stopped sending|assets at once|Silent \{\{|Check the source/.test(tpl));
  }
  t(`${k}: JSON summary reads lead_s`, JSON.parse(R.alertEvent(0, k).replace(/\{\{resultSet\[0\]\.(\w+)\}\}/g, (_, c) => (/^(criticality|crit_min|silent_min|tolerance_s|n_alerts|s_missing)$/.test(c) ? '1' : `<${c}>`))).summary.endsWith('<lead_s>'));
  t(`${k}: Slack and text read msg_s`, R.slackMessage(k).includes('{{resultSet[0].msg_s}}') && R.textMessage(k).includes('{{resultSet[0].msg_s}}'));
}

// 2. The alert searches switch on event, with lifecycleText's words, and emit both columns.
for (const rollup of ['off', 'auto']) {
  const s = { ...base, rollup };
  for (const [k, id] of Object.entries(ID)) {
    const q = query(s, id);
    const who = k === 'missing' ? 'asset_s' : 'input_s';
    t(`[${rollup}] ${id}: lead_s switches on event`, /\| extend lead_s = substring\(case\(event == "resolved", strcat\("Resolved: "/.test(q)
      && q.includes(`event == "reminder", strcat("Reminder: ", ${who}, " still silent after ", dur_t)`)
      && q.includes(`event == "expired", strcat("Closed: ", ${who}, " left the 24 h window; Pulse stopped tracking it")`));
    t(`[${rollup}] ${id}: resolved names what is back`, q.includes(k === 'missing' ? 'strcat("Resolved: ", asset_s, " is sending to ", input_s, " again", " after ", dur_t)' : 'strcat("Resolved: ", input_s, " is sending again", " after ", dur_t)'));
    t(`[${rollup}] ${id}: opened keeps today's sentence (default branch)`, k === 'missing'
      ? q.includes('strcat(asset_s, " stopped sending to ", input_s, " (", worker_group_s, ")")), 0, 120)')
      : q.includes('" assets at once (", tostring(pct), "%)")), 0, 110)'));
    t(`[${rollup}] ${id}: msg_s adds the resolved tail and start time`, q.includes('" · "') && q.includes('"). Incident started ", strftime(toint(opened_at), "%Y-%m-%dT%H:%M:%SZ"), ".")') && /event == "opened", strcat\(lead_s, /.test(q));
    t(`[${rollup}] ${id}: duration rounds like formatDuration`, q.includes('dur_t = iff(dur_min < 60, strcat(tostring(dur_min), " min"), strcat(tostring(round(dur_min / 60, 1)), " h"))'));
    t(`[${rollup}] ${id}: reminder duration is ${k === 'missing' ? 'the silence' : 'time since opened'}`, q.includes(k === 'missing' ? 'iff(event == "reminder", todouble(silent_min) * 60, now() - todouble(opened_at))' : 'dur_min = round(max_of(now() - todouble(opened_at), 0) / 60, 0)'));
    const summaryEs = k === 'missing' ? 'eventstats n_alerts = countif(__pad == 0)' : 'eventstats n_rows = countif(__pad == 0)';
    t(`[${rollup}] ${id}: lead_s / msg_s before the run summary`, q.indexOf('msg_s = ') > 0 && q.indexOf('msg_s = ') < q.indexOf(summaryEs));
    t(`[${rollup}] ${id}: under 4000 chars (${q.length})`, q.length < 4000);
  }
  t(`[${rollup}] digest stays stateless (no lifecycle columns)`, !query(s, 'pulse_source_digest').includes('lead_s'));
}
t('window hours follow the lookback', query({ ...base, learning: { ...learning, LOOKBACK: '-48h' } }, 'pulse_alert_missing').includes('left the 48 h window'));
t('remindH 4 + rollup auto: alert searches still under 4000', Object.values(ID).every((id) => query({ ...base, rollup: 'auto', notify: { ...base.notify, remindH: 4 } }, id).length < 4000));

// 3. Renders, with the column values the KQL above computes for each event (spec 030 §3 texts).
const URL = 'https://org.cribl.cloud/search?job=1';
const render = (tpl, row) => tpl.replace(/\{\{([^}]+)\}\}/g, (_, e) => (e === 'searchResultsUrl' ? URL : e === 'timestamp' ? '2026-11-20T10:47:00Z' : row[/^resultSet\[0\]\.(\w+)$/.exec(e)[1]] ?? (() => { throw new Error(e); })()));
const open = Date.UTC(2026, 10, 20, 10, 0, 0) / 1000;
const asset = { severity: 'critical', incident_id_s: 'pulse:asset:wg:in_syslog:fw01:' + open, asset_s: 'fw01', asset_u: 'fw01', input_s: 'in_syslog', worker_group_s: 'wg', team_s: 'network', others_s: '', more_s: '', criticality: '1', silent_min: '0', tolerance_s: '300', n_alerts: '1' };
const life = (ev) => R.lifecycleText(ev, { asset: 'fw01', input: 'in_syslog', criticality: 1, team: 'network', openedAt: open, nowS: open + 47 * 60, silentS: 4 * 3600, windowH: 24 });
// lead_s = lifecycleText without the resolved "(P1 · network). Incident started …" tail; msg_s = lifecycleText.
const rowFor = (ev) => ({ ...asset, event: ev, state: R.stateOf(ev), lead_s: life(ev).replace(/ \(P1 · network\)\..*$|\.$/, ''), msg_s: life(ev) });
const res = rowFor('resolved');
t('resolved lead_s', res.lead_s === 'Resolved: fw01 is sending to in_syslog again after 47 min');
t('resolved Slack says Resolved … after 47 min', render(R.slackMessage('missing'), res) === `*P1 · network* — Resolved: fw01 is sending to in_syslog again after 47 min (P1 · network). Incident started 2026-11-20T10:00:00Z.  <${URL}|Open>`);
const resEv = JSON.parse(render(R.alertEvent(0, 'missing'), res));
t('resolved JSON / PagerDuty summary', resEv.summary === 'P1 network: Resolved: fw01 is sending to in_syslog again after 47 min' && resEv.state === 'resolved' && resEv.event === 'resolved');
t('resolved text (email, bulletin, PagerDuty)', render(R.textMessage('missing'), res).startsWith('Pulse [P1 network]: Resolved: fw01 is sending to in_syslog again after 47 min (P1 · network).'));
for (const ev of ['resolved', 'reminder', 'expired']) {
  const row = rowFor(ev);
  const all = [render(R.slackMessage('missing'), row), render(R.textMessage('missing'), row), JSON.parse(render(R.alertEvent(0, 'missing'), row)).summary];
  t(`${ev}: no message says "stopped sending"`, all.every((m) => !m.includes('stopped sending')));
}
t('reminder Slack', render(R.slackMessage('missing'), rowFor('reminder')).startsWith('*P1 · network* — Reminder: fw01 still silent after 4 h.'));
t('expired Slack', render(R.slackMessage('missing'), rowFor('expired')).startsWith('*P1 · network* — Closed: fw01 left the 24 h window; Pulse stopped tracking it.'));
const src = { severity: 'error', state: 'resolved', event: 'resolved', incident_id_s: 'pulse:source:wg:in_syslog::' + open, input_s: 'in_syslog', input_u: 'in_syslog', worker_group_s: 'wg', teams_s: 'network', missing_s: '', more_s: '', crit_min: '2', s_live: '0', s_missing: '0', pct: '0',
  lead_s: 'Resolved: in_syslog is sending again after 3 h', msg_s: 'Resolved: in_syslog is sending again after 3 h (P2 · network). Incident started 2026-11-20T10:00:00Z.' };
t('source_down resolved summary', JSON.parse(render(R.alertEvent(0, 'source_down'), src)).summary === 'P2 network: Resolved: in_syslog is sending again after 3 h');
t('source_down resolved text = lifecycleText', render(R.textMessage('source_down'), src).startsWith('Pulse [P2 network]: ' + R.lifecycleText('resolved', { input: 'in_syslog', criticality: 2, team: 'network', openedAt: open, nowS: open + 3 * 3600 })));

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('routes event texts tests passed');
