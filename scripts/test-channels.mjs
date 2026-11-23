// Table tests for src/lib/channels.ts. Run: node scripts/test-channels.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ch-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/channels.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'c.mjs')}`], { stdio: 'pipe' });
const { PULSE_TARGET_PREFIX, targetBody, validChannel, teamsSrcExpression } = await import(join(tmp, 'c.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

t('prefix', PULSE_TARGET_PREFIX === 'pulse_');

const key = 'k'.repeat(32);
const bodies = [
  ['slack', { id: 'pulse_a', url: 'https://hooks.slack.com/x' }, 'slack'],
  ['pagerduty', { id: 'pulse_a', routingKey: key, severity: 'error' }, 'pager_duty'],
  ['webhook', { id: 'pulse_a', url: 'https://e.com/h' }, 'webhook'],
  ['teams', { id: 'pulse_a', url: 'https://e.com/h' }, 'webhook'],
];
for (const [p, f, type] of bodies) {
  const b = targetBody(p, f);
  t(`${p}: type ${type}, id passed through`, b.type === type && b.id === 'pulse_a');
}
t('webhook ndjson POST', (b => b.format === 'ndjson' && b.method === 'POST')(targetBody('webhook', { id: 'pulse_a', url: 'https://e.com' })));
t('webhook bearer has token', targetBody('webhook', { id: 'pulse_a', url: 'https://e.com', auth: 'bearer', token: 'T' }).token === 'T');
t('webhook basic has username/password', (b => b.username === 'u' && b.password === 'p')(targetBody('webhook', { id: 'pulse_a', url: 'https://e.com', auth: 'basic', username: 'u', password: 'p' })));
const teams = targetBody('teams', { id: 'pulse_t', url: 'https://e.com/h' });
t('teams custom format', teams.format === 'custom' && teams.method === 'POST');
t('teams srcExpression has AdaptiveCard and message', teams.srcExpression.includes('AdaptiveCard') && teams.srcExpression.includes('message'));
t('teams expression runs', (() => { const o = JSON.parse(new Function('__e', 'return ' + teamsSrcExpression('message'))({ message: 'hi' })); return o.attachments[0].content.body[0].text === 'hi'; })());

const ok = { id: 'pulse_a', url: 'https://hooks.slack.com/x', routingKey: key };
const cases = [
  ['valid slack', 'slack', ok, [], false],
  ['valid pagerduty', 'pagerduty', ok, [], false],
  ['valid webhook', 'webhook', { ...ok, url: 'https://e.com' }, [], false],
  ['valid teams', 'teams', { ...ok, url: 'https://e.com' }, [], false],
  ['no prefix', 'slack', { ...ok, id: 'a' }, [], true],
  ['uppercase id', 'slack', { ...ok, id: 'pulse_A' }, [], true],
  ['empty suffix', 'slack', { ...ok, id: 'pulse_' }, [], true],
  ['id too long', 'slack', { ...ok, id: 'pulse_' + 'a'.repeat(49) }, [], true],
  ['id max length', 'slack', { ...ok, id: 'pulse_' + 'a'.repeat(48) }, [], false],
  ['duplicate', 'slack', ok, ['pulse_a'], true],
  ['slack wrong host', 'slack', { ...ok, url: 'https://evil.com/x' }, [], true],
  ['slack http', 'slack', { ...ok, url: 'http://hooks.slack.com/x' }, [], true],
  ['pd 31 chars', 'pagerduty', { ...ok, routingKey: 'k'.repeat(31) }, [], true],
  ['pd 33 chars', 'pagerduty', { ...ok, routingKey: 'k'.repeat(33) }, [], true],
  ['webhook http', 'webhook', { ...ok, url: 'http://e.com' }, [], true],
  ['teams http', 'teams', { ...ok, url: 'http://e.com' }, [], true],
  ['webhook empty url', 'webhook', { ...ok, url: '' }, [], true],
];
for (const [name, p, f, ex, bad] of cases) {
  const r = validChannel(p, f, ex);
  t(name, bad ? typeof r === 'string' && r.length > 0 : r === null);
}

const { redact, channelRows } = await import(join(tmp, 'c.mjs'));
t('redact slack url', redact('https://hooks.slack.com/services/T0/B0/abcdefgh1234') === 'hooks.slack.com/…/••••1234');
t('redact url without path keeps host', redact('https://e.com') === 'e.com');
for (const s of ['abc', 'abcd', 'abcdefgh', 'k'.repeat(32), 'secretvalue12345', 'https://e.com/a/b/SECRETTOKEN99', 'https://u:pw@e.com/x/ZZZZYYYYXXXX']) {
  const r = redact(s);
  const body = s.replace(/^https?:\/\/[^/]*/, '');
  let shown = 0;
  for (let n = 1; n <= body.length; n++) if (body.length >= n && r.includes(body.slice(0, n)) && n > 4 && body.slice(0, n).length > 4) shown = Math.max(shown, n);
  t(`redact never leaks more than 4: ${s}`, shown === 0 && !r.includes(s.slice(-5)) && !r.includes('pw@'));
}
t('redact short secret fully masked', !redact('abcd').includes('abcd'));
const rows = channelRows([
  { id: 'a', type: 'slack', url: 'https://hooks.slack.com/services/T0/B0/abcdefgh1234', status: { health: 'Green', metrics: { totalSent: 3, errorCnt: 1 } } },
  { id: 'b', type: 'bulletin_message', status: { health: 'Yellow' } },
  { id: 'c', type: 'smtp', to: ['x@e.com', 'y@e.com'], status: { health: 'Red' } },
  { id: 'd', type: 'pager_duty', routingKey: 'k'.repeat(28) + 'wxyz' },
  { id: 'e', type: 'sns' },
  { id: 'f', type: 'webhook', format: 'custom', srcExpression: teamsSrcExpression('message'), url: 'https://e.com/h/abcdefghij' },
  { id: 'g', type: 'webhook', format: 'ndjson', url: 'https://e.com' },
  // T0 shape: non-smtp targets report sentCount / numDropped
  { id: 'h', type: 'webhook', url: 'https://e.com', status: { health: 'Green', metrics: { sentCount: 4, numDropped: 2, bytesOut: 900 } } },
]);
const by = Object.fromEntries(rows.map((r) => [r.id, r]));
t('rows slack', by.a.kind === 'Slack' && by.a.tone === 'success' && by.a.sent === 3 && by.a.errors === 1);
t('rows in-product + warning', by.b.kind === 'In-product' && by.b.tone === 'warning');
t('rows email + danger, recipients are per alert', by.c.kind === 'Email' && by.c.tone === 'danger' && by.c.where === 'recipients set per alert');
t('rows sentCount / numDropped (T0)', by.h.sent === 4 && by.h.errors === 2);
t('rows pagerduty last 4, missing health default', by.d.kind === 'PagerDuty' && by.d.tone === 'default' && by.d.where.endsWith('wxyz') && !by.d.where.includes('kk'));
t('rows sns', by.e.kind === 'SNS');
t('rows missing metrics', by.d.sent === undefined && by.d.errors === undefined);
t('rows teams vs webhook', by.f.kind === 'Teams' && by.g.kind === 'Webhook' && by.g.where === 'e.com');

const { TEST_CRON, testStopAt, disabledSaved, compareMetrics, TEST_TIMEOUT_MS } = await import(join(tmp, 'c.mjs'));
t('test cron runs every minute (a date-pinned cron never runs, T0)', TEST_CRON === '* * * * *');
const at = Date.parse('2026-11-18T10:05:30Z');
t('stop 20 s after the next minute', testStopAt(at) === Date.parse('2026-11-18T10:06:20Z'));
t('stop on the minute goes to next', testStopAt(Date.parse('2026-11-18T10:05:00Z')) === Date.parse('2026-11-18T10:06:20Z'));
const ds = disabledSaved({ id: 's', query: 'q', status: { x: 1 }, schedule: { enabled: true, cronSchedule: '* * * * *' } });
t('disabledSaved keeps the full body, drops status (T0: partial PATCH → 500)', ds.id === 's' && ds.query === 'q' && !('status' in ds)
  && ds.schedule.enabled === false && ds.schedule.cronSchedule === '* * * * *');
t('metrics sent', compareMetrics({ totalSent: 1, errorCnt: 0 }, { totalSent: 2, errorCnt: 0 }, 1000).state === 'sent');
const f = compareMetrics({ totalSent: 1, errorCnt: 1 }, { totalSent: 1, errorCnt: 3 }, 1000);
t('metrics failed with count', f.state === 'failed' && f.errors === 2);
t('metrics waiting', compareMetrics({}, {}, 1000).state === 'waiting');
t('metrics no-answer', compareMetrics({ totalSent: 1 }, { totalSent: 1 }, TEST_TIMEOUT_MS).state === 'no-answer');
t('metrics sent on sentCount (T0)', compareMetrics({ sentCount: 0 }, { sentCount: 1 }, 1000).state === 'sent');
const fd = compareMetrics({ sentCount: 0, numDropped: 0 }, { sentCount: 0, numDropped: 1 }, 1000);
t('metrics failed on numDropped (T0)', fd.state === 'failed' && fd.errors === 1);

const { nextTargetId, withPrefix } = await import(join(tmp, 'c.mjs'));
t('nextTargetId first free', nextTargetId('slack', ['pulse_slack_1']) === 'pulse_slack_2' && nextTargetId('teams', []) === 'pulse_teams_1');
t('withPrefix keeps prefix', withPrefix('ops') === 'pulse_ops' && withPrefix('pulse_x') === 'pulse_x' && withPrefix('pulse') === 'pulse_' && withPrefix('') === 'pulse_');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
