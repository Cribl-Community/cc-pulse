// F3 (spec 036): vtSearches emits one derived search per (route condition, slot); onRouteSearch is resultsCount only.
// Run: node scripts/test-slot-searches.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-slot-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/routes.ts'), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, 'r.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const R = await import(join(tmp, 'r.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const types = { system_notifications: 'bulletin_message', pulse_pd: 'pager_duty', pulse_slack: 'slack' };
const nf = (search, routes, targets) => R.notificationsFor(search, routes, { targets, email: '' }, { targetTypes: types });
const P1 = { id: 'r1', name: 'P1', when: { maxCriticality: 1 }, targets: ['pulse_pd'], severity: 'critical', final: true };
const MIX = { id: 'r2', name: 'Ops', when: { team: 'ops' }, targets: ['system_notifications', 'pulse_pd'], final: false };
const FIRING = 'event in ("opened", "reminder")';
const RS = R.runSummary;

/* ── default, no routes: five slot searches, empty condition ── */
for (const parent of ['pulse_alert_missing', 'pulse_alert_source_down']) {
  const kind = parent.endsWith('missing') ? 'missing' : 'source_down';
  const base = `pulse_route_default_${kind}`;
  const ns = nf({ id: parent, desc: 'd' }, [], ['system_notifications']);
  const rs0only = (m) => String(m).includes('resultSet[0]') && !/resultSet\[[1-4]\]/.test(m);
  t(`${parent}: five bodies, all resultSet[0]`, ns.length === 5 && ns.every((n) => n.conf.triggerType === 'resultsCount' && rs0only(n.conf.message)));
  const v = R.vtSearches(parent, base, ns);
  t(`${parent}: five searches`, v.searches.length === 5 && v.notes.length === 5);
  for (let i = 0; i < 5; i++) {
    const sid = i ? `${base}_s${i}` : base;
    const s = v.searches.find((x) => x.id === sid);
    const line = s?.query.split('\n')[0] ?? '';
    t(`${parent}: search ${i} id ${sid}`, !!s && line.includes(`slot == ${i}`) && !line.includes(' and ('));
    // The parent row already carries n_alerts / others / more_s. Recounting after slot == i would
    // project those away and report "Alerts this run: 1" (and drop a source-down "(+N more)" suffix).
    t(`${parent}: search ${i} keeps the parent run summary`, s?.query === line && !/project-away|eventstats|n_alerts = count\(/.test(s?.query ?? ''));
    const n = v.notes.find((x) => x.id === `${parent}_notification${i ? `_s${i}` : ''}`);
    t(`${parent}: note ${i} resultsCount, no slot in conf`, n?.conf.triggerType === 'resultsCount' && n.conf.triggerComparator === '>' && n.conf.triggerCount === 0
      && n.conf.savedQueryId === sid && !String(n.conf.customValue ?? '').includes('slot =='));
  }
}

/* ── route condition on the search first line, in parentheses ── */
{
  const cond = 'toint(criticality) <= 1 and event in ("opened", "reminder")';
  const ns = nf({ id: 'pulse_alert_missing', desc: 'd' }, [P1], ['pulse_pd']);
  const v = R.vtSearches('pulse_alert_missing', 'pulse_route_r1_missing', ns.filter((n) => n.id.startsWith('pulse_alert_missing_route_r1')));
  const s0 = v.searches.find((x) => x.id === 'pulse_route_r1_missing');
  const line = s0?.query.split('\n')[0] ?? '';
  t('P1 slot 0 query has slot and condition in parens', line.includes('slot == 0') && line.includes(`and (${cond})`));
  t('P1 slot 0 query does not recount n_alerts on the one row', s0?.query === line && !s0.query.includes(RS('missing', true)));
  t('P1-only route slot 0 note → pulse_route_r1_missing', v.notes.find((n) => n.id === 'pulse_alert_missing_route_r1__pulse_pd')?.conf.savedQueryId === 'pulse_route_r1_missing');
}

/* ── mixed route: PD reads _firing, bulletin does not carry firing clause ── */
{
  const ns = nf({ id: 'pulse_alert_missing', desc: 'd' }, [MIX], ['system_notifications', 'pulse_pd']);
  const r2 = ns.filter((n) => n.id.startsWith('pulse_alert_missing_route_r2'));
  const v = R.vtSearches('pulse_alert_missing', 'pulse_route_r2_missing', r2);
  const pd0 = v.notes.find((n) => n.id === 'pulse_alert_missing_route_r2__pulse_pd');
  const text0 = v.notes.find((n) => n.id === 'pulse_alert_missing_route_r2__system_notifications');
  t('mixed PD slot 0 → pulse_route_r2_missing_firing', pd0?.conf.savedQueryId === 'pulse_route_r2_missing_firing');
  t('mixed PD slot 1 → pulse_route_r2_missing_firing_s1', v.notes.find((n) => n.id === 'pulse_alert_missing_route_r2__pulse_pd_s1')?.conf.savedQueryId === 'pulse_route_r2_missing_firing_s1');
  const pdQ = v.searches.find((x) => x.id === 'pulse_route_r2_missing_firing')?.query.split('\n')[0] ?? '';
  t('PD search first line has firing event clause', pdQ.includes(FIRING));
  const bullQ = v.searches.find((x) => x.id === 'pulse_route_r2_missing')?.query.split('\n')[0] ?? '';
  t('bulletin search first line has no firing-only clause', bullQ.includes('team == "ops"') && !bullQ.includes(FIRING));
  t('bulletin slot 0 → pulse_route_r2_missing', text0?.conf.savedQueryId === 'pulse_route_r2_missing');
}

/* ── digest: one search per condition, no slot == ── */
{
  const plain = nf({ id: 'pulse_source_digest', desc: 'd' }, [], ['pulse_slack']);
  const v0 = R.vtSearches('pulse_source_digest', 'pulse_route_default_digest', plain);
  t('digest: no condition → no derived search', v0.searches.length === 0 && plain.length === 1);
  const withFinal = nf({ id: 'pulse_source_digest', desc: 'd' }, [P1], ['pulse_slack']).filter((n) => n.id.includes('_notification'));
  const v1 = R.vtSearches('pulse_source_digest', 'pulse_route_default_digest', withFinal);
  t('digest with default condition: one search', v1.searches.length === 1);
  t('digest queries have no slot ==', [...v0.searches, ...v1.searches].every((s) => !s.query.includes('slot ==')));
  t('digest search still recomputes the summary over its rows', v1.searches.length === 1 && v1.searches[0].query.endsWith(RS('digest', true)));
}

/* ── R1: a target ID may itself end in `_s1` (channels ID_RE accepts `pulse_ops_s1`). The slot is read after the
 *    body's own `__<target>`, never by a bare `_sN` suffix match on the ID. ── */
{
  const S = 'pulse_alert_missing';
  const T = 'pulse_ops_s1';
  const ROUTE = { id: 'r1', name: 'Ops', when: { team: 'ops' }, targets: [T], final: false };
  const ns = R.notificationsFor({ id: S, desc: 'd' }, [ROUTE], { targets: ['system_notifications', T], email: '' }, { targetTypes: {} });
  const ids = ns.map((n) => n.id);
  const r0 = ns.find((n) => n.id === `${S}_route_r1__${T}`);
  const r1 = ns.find((n) => n.id === `${S}_route_r1__${T}_s1`);
  t('R1: route slot 0 body targets pulse_ops_s1', !!r0 && r0.targets.join() === T);
  t('R1: route slot 0 → slot 0, base is its own id', R.slotOf(r0) === 0 && R.baseIdOf(r0) === r0.id);
  t('R1: route slot 1 → slot 1, base is the slot 0 id', R.slotOf(r1) === 1 && R.baseIdOf(r1) === r0.id);
  for (let i = 0; i < 5; i++) {
    const n = ns.find((x) => x.id === `${S}_notification__${T}${i ? `_s${i}` : ''}`);
    t(`R1: default __${T} slot ${i}`, !!n && R.slotOf(n) === i && R.baseIdOf(n) === `${S}_notification__${T}`);
  }
  t('R1: target pulse_ops: …__pulse_ops_s1 is its slot 1', R.slotOf({ id: `${S}_route_r1__pulse_ops_s1`, targets: ['pulse_ops'] }) === 1);
  t('R1: target pulse_ops_s1, slot 2: …__pulse_ops_s1_s2', R.slotOf({ id: `${S}_route_r1__${T}_s2`, targets: [T] }) === 2);
  t('R1: first default (no target in the ID) still reads _sN', R.slotOf({ id: `${S}_notification_s3`, targets: ['system_notifications'] }) === 3
    && R.slotOf({ id: `${S}_notification`, targets: [T] }) === 0);
  t('R1: ids unique', new Set(ids).size === ids.length);

  t('R1: stale lists no live id of target pulse_ops_s1', R.staleNotifications(S, [ROUTE], ids).length === 0);
  t('R1: stale leaves the live slot-0 route body', R.staleNotifications(S, [ROUTE], [`${S}_route_r1__${T}`]).length === 0);
  t('R1: stale still lists a removed target pulse_ops next to pulse_ops_s1',
    R.staleNotifications(S, [ROUTE], [`${S}_route_r1__pulse_ops`, `${S}_route_r1__${T}`]).join() === `${S}_route_r1__pulse_ops`);
  t('R1: staleDefaults lists none of the produced ids', R.staleDefaults(S, ids, ids).length === 0);

  const routeNs = ns.filter((n) => R.isRouteNotification(n.id, S, 'r1'));
  t('R1: route bodies: five', routeNs.length === 5);
  const v = R.vtSearches(S, 'pulse_route_r1_missing', routeNs);
  for (let i = 0; i < 5; i++) {
    const id = `${S}_route_r1__${T}${i ? `_s${i}` : ''}`;
    const sid = i ? `pulse_route_r1_missing_s${i}` : 'pulse_route_r1_missing';
    const q = v.searches.find((x) => x.id === sid)?.query ?? '';
    t(`R1: vt route slot ${i} → ${sid} (slot == ${i})`, v.notes.find((n) => n.id === id)?.conf.savedQueryId === sid && q.includes(`slot == ${i}`));
  }
  t('R1: vt route: five distinct searches', v.searches.length === 5 && new Set(v.notes.map((n) => n.conf.savedQueryId)).size === 5);
  const dv = R.vtSearches(S, 'pulse_route_default_missing', ns.filter((n) => n.id.startsWith(`${S}_notification__${T}`)));
  t('R1: vt default __pulse_ops_s1 slot 0 → pulse_route_default_missing',
    dv.notes.find((n) => n.id === `${S}_notification__${T}`)?.conf.savedQueryId === 'pulse_route_default_missing');
  t('R1: vt default __pulse_ops_s1 slot 1 → pulse_route_default_missing_s1',
    dv.notes.find((n) => n.id === `${S}_notification__${T}_s1`)?.conf.savedQueryId === 'pulse_route_default_missing_s1');
}

console.log(fail ? `${fail} failed` : 'all passed');
process.exit(fail ? 1 : 0);