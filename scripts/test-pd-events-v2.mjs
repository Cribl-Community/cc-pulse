// Tests the PagerDuty Events v2 preset. Run: node scripts/test-pd-events-v2.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-pd-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/channels.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'c.mjs')}`], { stdio: 'pipe' });
const { targetBody, validChannel } = await import(join(tmp, 'c.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

const key = 'k'.repeat(32);
const b = targetBody('pagerduty_v2', { id: 'pulse_pd_1', routingKey: key });
t('url', b.url === 'https://events.pagerduty.com/v2/enqueue' && b.type === 'webhook' && b.format === 'custom');
const run = (e, wrap) => JSON.parse(new Function('__e', 'return ' + b.srcExpression)(wrap ? { message: JSON.stringify(e) } : e));
const base = { incident_id: 'inc-1', summary: 'P1 net: fw01', severity: 'critical', asset: 'fw01', input: 'in_syslog' };
for (const [event, state, action] of [['opened', 'firing', 'trigger'], ['reminder', 'firing', 'trigger'], ['resolved', 'resolved', 'resolve'], ['expired', 'resolved', 'resolve']]) {
  for (const wrap of [false, true]) {
    const o = run({ ...base, event, state }, wrap);
    t(`${event} -> ${action} (wrapped ${wrap})`, o.event_action === action && o.dedup_key === 'inc-1' && o.routing_key === key
      && o.payload.summary === base.summary && o.payload.severity === 'critical' && o.payload.source === 'fw01');
  }
}
t('source falls back to input', run({ ...base, asset: '', event: 'opened', state: 'firing' }).payload.source === 'in_syslog');
t('plain pagerduty unchanged', JSON.stringify(targetBody('pagerduty', { id: 'a', routingKey: key, severity: 'error' })) === JSON.stringify({ id: 'a', type: 'pager_duty', routingKey: key, severity: 'error' }));
t('valid key', validChannel('pagerduty_v2', { id: 'pulse_pd_1', routingKey: key }, []) === null);
t('short key rejected', validChannel('pagerduty_v2', { id: 'pulse_pd_1', routingKey: 'x' }, []) !== null);

const testMsg = run({ message: 'Pulse test notification' }, false);
t('plain test notification', testMsg.event_action === 'trigger' && testMsg.dedup_key === 'pulse:test'
  && testMsg.payload.summary === 'Pulse test notification' && testMsg.payload.severity === 'info'
  && testMsg.payload.source === 'pulse' && testMsg.routing_key === key);

const digest = { kind: 'digest', summary: 'hourly digest', worker_group: 'wg1', input: 'in_syslog' };
const d1 = run({ ...digest, at: 't1' }, false);
const d2 = run({ ...digest, at: 't2' }, false);
t('digest dedup key', d1.event_action === 'trigger' && d1.dedup_key === 'pulse:digest:wg1:in_syslog'
  && d1.dedup_key === d2.dedup_key && d1.payload.source === 'pulse' && d1.payload.severity === 'info');
t('digest summary and wrapped', run(digest, true).payload.summary === 'hourly digest');
t('digest with incident_id uses incident mapping', run({ ...digest, incident_id: 'inc-digest', event: 'opened', state: 'firing', severity: 'warning' }, false).dedup_key === 'inc-digest');

if (fails) process.exit(1);
console.log('pd events v2 tests passed');
