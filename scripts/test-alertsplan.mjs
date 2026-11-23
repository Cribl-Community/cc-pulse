// Alerts plan: notification targets, step details, stop-test step. Run: node scripts/test-alertsplan.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ap-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const mk = (targets, email) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets, email }, learning });
const known = [{ id: 'pulse_slack_ops', type: 'slack' }];

const run = async (s, existing, ids) => {
  const calls = [];
  globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ u, method: init.method ?? 'GET', body });
    const items = u.endsWith('/search/saved') ? existing.map((id) => ({ id, schedule: { enabled: true, cronSchedule: '* * * * *' } })) : [];
    return { ok: true, status: 200, text: async () => JSON.stringify({ items }) };
  };
  const out = [];
  for (const id of ids) out.push(await D.alertsPlan(s, true, undefined, known).find((x) => x.id === id).run());
  return { calls, out };
};

// Spec 029: the default route's targets are split by message format (Slack → <search>_notification_slack), so the
// targets are collected across the search's default notifications, in write order.
const defaultTargets = (calls, search) => calls.filter((c) => c.method !== 'GET' && /^.*_notification(__.+)?$/.test(c.body?.id ?? '') && !/_s[1-4]$/.test(c.body.id) && c.body.id.startsWith(`${search}_notification`))
  .flatMap((c) => c.body.targets).sort();
const s = mk(['pulse_slack_ops', 'system_email'], 'a@b.c');
const { calls } = await run(s, [], ['pulse_alert_missing']);
t('targets stable and without duplicates', JSON.stringify(defaultTargets(calls, 'pulse_alert_missing')) === JSON.stringify(['pulse_slack_ops', 'system_email']));
t('the Slack target gets its own _notification__pulse_slack_ops', calls.some((c) => c.body?.id === 'pulse_alert_missing_notification__pulse_slack_ops' && c.body.targets.join() === 'pulse_slack_ops'));
const c2 = (await run(mk(['pulse_slack_ops'], 'a@b.c'), [], ['pulse_source_digest'])).calls;
t('system_email appended when recipients set', JSON.stringify(defaultTargets(c2, 'pulse_source_digest')) === JSON.stringify(['pulse_slack_ops', 'system_email']));
const c3 = (await run(mk(['pulse_slack_ops'], ''), [], ['pulse_alert_source_down'])).calls;
t('no system_email without recipients', JSON.stringify(defaultTargets(c3, 'pulse_alert_source_down')) === JSON.stringify(['pulse_slack_ops']));

const plan = D.alertsPlan(mk(['pulse_slack_ops'], 'a@b.c'), true, undefined, known);
const miss = plan.find((x) => x.id === 'pulse_alert_missing');
t('detail names target and type label', miss.detail.includes('pulse_slack_ops (Slack)') && miss.detail.includes('system_email'));
t('stop step is last', plan[plan.length - 1].id === 'stop_test');

const on = await run(s, ['pulse_notify_test'], ['stop_test']);
const p = on.calls.find((c) => c.method === 'PATCH');
t('stop step disables the schedule', !!p && p.u.endsWith('/search/saved/pulse_notify_test') && p.body.schedule.enabled === false);
const off = await run(s, [], ['stop_test']);
t('stop step skipped when absent', !off.calls.some((c) => c.method !== 'GET') && /skipped/.test(off.out[0]));

if (fail) process.exit(1);
