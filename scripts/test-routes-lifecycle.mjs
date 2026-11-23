// Lifecycle tests for routes.ts (F7). Run: node scripts/test-routes-lifecycle.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rtl-'));
const build = (src, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', `--outfile=${join(tmp, out)}`], { stdio: 'pipe' });
build('src/lib/routes.ts', 'r.mjs');
build('src/lib/ledger.ts', 'l.mjs');
const { routeMatches, routeCondition, defaultCondition, stateOf, alertEvent, slackMessage, textMessage } = await import(join(tmp, 'r.mjs'));
const { step } = await import(join(tmp, 'l.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };
const EVENTS = ['opened', 'reminder', 'resolved', 'expired'];

// when.events filter
for (const e of EVENTS) t(`no when.events matches ${e}`, routeMatches({}, { kind: 'missing', criticality: 1, event: e }));
for (const e of EVENTS) t(`events=[opened,reminder] on ${e}`, routeMatches({ events: ['opened', 'reminder'] }, { kind: 'missing', criticality: 1, event: e }) === (e === 'opened' || e === 'reminder'));
t('criticality + team still apply to recoveries', !routeMatches({ maxCriticality: 1, team: 'a' }, { kind: 'missing', criticality: 2, team: 'a', event: 'resolved' }) && routeMatches({ maxCriticality: 2, team: 'a' }, { kind: 'missing', criticality: 2, team: 'a', event: 'expired' }));
t('condition: default has no event clause', routeCondition({}) === 'true' && routeCondition({ events: EVENTS }) === 'true');
t('condition: events subset', routeCondition({ events: ['opened', 'reminder'] }) === 'event in ("opened", "reminder")');
const OFF = ['opened', 'reminder'];
t('digest routeCondition skips the event clause', routeCondition({ events: OFF }, 'digest') === 'true' && routeCondition({ maxCriticality: 2, team: 'net', events: OFF }, 'digest') === 'toint(crit_min) <= 2 and teams_j contains_cs ",net,"');
t('missing and source_down keep the event clause', routeCondition({ events: OFF }, 'missing') === 'event in ("opened", "reminder")' && routeCondition({ events: OFF }, 'source_down') === 'event in ("opened", "reminder")');
t('digest defaultCondition skips the event clause', defaultCondition([], 'digest', OFF) === '' && defaultCondition([{ id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: [], final: true }], 'digest', OFF) === 'not ((toint(crit_min) <= 1))');
t('missing defaultCondition keeps the event clause', defaultCondition([], 'missing', OFF) === 'event in ("opened", "reminder")' && defaultCondition([], 'source_down', OFF) === 'event in ("opened", "reminder")');

// state mapping
const want = { opened: 'firing', reminder: 'firing', resolved: 'resolved', expired: 'resolved' };
for (const e of EVENTS) t(`stateOf(${e}) = ${want[e]}`, stateOf(e) === want[e]);

// payload keys
for (const k of ['missing', 'source_down']) {
  const tpl = JSON.parse(alertEvent(0, k).replace(/\{\{[^}]+\}\}/g, '1'));
  t(`${k}: payload has state, event, incident_id`, 'state' in tpl && 'event' in tpl && 'incident_id' in tpl);
}
const digestTpl = alertEvent(0, 'digest');
const digestJson = JSON.parse(digestTpl.replace(/\{\{[^}]+\}\}/g, '1'));
t('digest: payload has kind and no state, event, or incident_id', digestJson.kind === 'digest' && !('state' in digestJson) && !('event' in digestJson) && !('incident_id' in digestJson));
t('digest JSON keeps summary, severity, worker_group, input', ['summary', 'severity', 'worker_group', 'input'].every((k) => k in digestJson));
t('digest templates read no state, event, or incident_id column', [digestTpl, slackMessage('digest'), textMessage('digest')].every((s) => !/\{\{resultSet\[\d+\]\.(state|event|incident_id)/.test(s) && !/pulse:(asset|source):/.test(s)));
t('payload reads state/event/incident_id_s columns', ['missing', 'source_down'].every((k) => ['state', 'event', 'incident_id_s'].every((c) => alertEvent(0, k).includes(`{{resultSet[0].${c}}}`))));

// resolved carries the opener's incident_id
const ent = (raw) => ({ worker_group: 'wg', input: 'in', asset: 'fw01', state: 'missing', raw_state: raw, eligible: true, last_seen: 1, criticality: '1', team: 'net' });
const r1 = step([], [ent('missing')], 1000, { remindH: 4, kind: 'asset' });
const opened = r1.events[0];
const r2 = step(r1.ledger, [ent('ok')], 1300, { remindH: 4, kind: 'asset' });
const resolved = r2.events[0];
t('opened then resolved events', opened.event === 'opened' && resolved.event === 'resolved');
t('resolved carries the opener incident_id', resolved.incident_id === opened.incident_id && !!opened.incident_id);
const r3 = step(r1.ledger, [], 1300, { remindH: 4, kind: 'asset' });
t('expired carries the opener incident_id', r3.events[0].event === 'expired' && r3.events[0].incident_id === opened.incident_id);
t('ledger event maps to state', stateOf(resolved.event) === 'resolved' && stateOf(opened.event) === 'firing');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('routes lifecycle tests passed');
