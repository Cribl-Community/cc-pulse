// pulse_alert_missing: n_alerts, others and sanitized columns. Run: node scripts/test-kql-missing.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-kql-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const s = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: [], email: '' }, learning };
const q = K.savedSearches(s).find((x) => x.id === 'pulse_alert_missing').query;

t('n_alerts is the row count of the run (eventstats, one pass)', /\| eventstats n_alerts = countif\(__pad == 0\)/.test(q));
// Review fix: the alert pipeline is evaluated once — only core's own two leftouter joins, no join of core onto itself.
// Spec 030 F5: the only join is the leftanti against the alert's own earlier runs.
t('core evaluated once (no self-join)', (q.match(/\bjoin\b/g) ?? []).length === 1 && /join kind=leftanti/.test(q) && !/join kind=inner/.test(q));
t('others = the next 9 assets after the final sort', /\| sort by __pad asc, criticality asc, asset asc\n\| extend others = /.test(q) && q.includes('next(asset, 9, "")') && !q.includes('next(asset, 10'));
t('others trimmed to 160 chars', /extend others = substring\(.*, 0, 160\)/.test(q));
for (const c of ['severity', 'asset_s', 'asset_u', 'input_s', 'worker_group_s', 'team_s', 'others_s', 'more_s'])
  t(`column ${c}`, new RegExp(`\\b${c} = `).test(q));
t('sanitizer replaces quote, backslash, control chars', q.includes(String.raw`@'["\\<>|\x00-\x1f]'`));
t('other searches have no n_alerts', K.savedSearches(s).filter((x) => x.id !== 'pulse_alert_missing').every((x) => !x.query.includes('n_alerts')));

// Review finding: Cribl KQL's function index documents no array functions; the org probe never ran on these.
const UNDOCUMENTED = /\b(make_set|make_list|set_has_element|array_slice|set_difference|strcat_array|pack_array|array_length)\(/;
for (const x of K.savedSearches(s)) t(`${x.id}: only documented Cribl KQL functions`, !UNDOCUMENTED.test(x.query));

for (const id of ['pulse_alert_source_down', 'pulse_source_digest']) {
  // The alert reads the ledger writer's columns (spec 030 F5): crit_min / teams are computed by the writer.
  const qq = K.savedSearches(s).find((x) => x.id === id).query;
  const wq = K.savedSearches(s).find((x) => x.id === (id === 'pulse_alert_source_down' ? 'pulse_ledger_source' : id)).query;
  t(`${id}: crit_min is the min criticality of missing assets`, /crit_min\s?=\s?min\(crit_n\)/.test(wq) && qq.includes('crit_min = coalesce(crit_min, 3)'));
  t(`${id}: teams is the set of missing assets' teams`, /teams\s?=\s?values\(team_n\)/.test(wq));
  t(`${id}: teams_j = ",a,b," for exact team matching`, qq.includes('teams_j = strcat(",", teams_l, ",")'));
  t(`${id}: more_s lists the next inputs`, qq.includes('next(input, 5, "")') && /more_s = iff\(n_rows > 1/.test(qq));
}
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/routes.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'r.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const RT = await import(join(tmp, 'r.mjs'));
t('routeCondition missing unchanged', RT.routeCondition({ maxCriticality: 2, team: 'a' }) === 'toint(criticality) <= 2 and team == "a"');
t('routeCondition source_down uses crit_min and teams_j', RT.routeCondition({ maxCriticality: 2, team: 'a' }, 'source_down') === 'toint(crit_min) <= 2 and teams_j contains_cs ",a,"');
t('routeCondition digest uses crit_min and teams', RT.routeCondition({ maxCriticality: 1, input: 'x' }, 'digest') === 'toint(crit_min) <= 1 and input == "x"');


// Review fix (blocking): every column a template reads is one the kind's query assigns (`name =` / `name=`).
const ID = { missing: 'pulse_alert_missing', source_down: 'pulse_alert_source_down', digest: 'pulse_source_digest' };
for (const [kind, id] of Object.entries(ID)) {
  const qq = K.savedSearches(s).find((x) => x.id === id).query;
  const assigned = new Set([...qq.matchAll(/\b([a-z_]+)\s*=(?!=)/g)].map((m) => m[1]));
  const need = [...RT.ALERT_COLUMNS[kind].strings, ...RT.ALERT_COLUMNS[kind].numbers];
  const tpl = [RT.alertEvent(0, kind), RT.slackMessage(kind, { origin: 'https://o' }), RT.textMessage(kind, { origin: 'https://o' })].join(' ');
  const read = [...new Set([...tpl.matchAll(/\{\{resultSet\[0\]\.(\w+)\}\}/g)].map((m) => m[1]))];
  const missingCols = [...need, ...read].filter((c) => !assigned.has(c));
  t(`${kind}: the query emits every column its templates read${missingCols.length ? ` (missing: ${missingCols.join(', ')})` : ''}`, missingCols.length === 0);
  const cond = RT.routeCondition({ maxCriticality: 1, team: 'x', input: 'i' }, kind);
  const condCols = [...cond.matchAll(/\b(crit_min|criticality|teams_j|team|input)\b/g)].map((m) => m[1]).filter((c) => c !== 'input');
  t(`${kind}: routeCondition reads emitted columns (${condCols.join(', ')})`, condCols.every((c) => assigned.has(c)));
}

// Review 3 fix (major): an empty criticality / team from the inventory lookup is defaulted like a null one.
for (const id of ['pulse_alert_missing', 'pulse_alert_source_down', 'pulse_source_digest']) {
  const qq = K.savedSearches(s).find((x) => x.id === (id === 'pulse_alert_source_down' ? 'pulse_ledger_source' : id)).query;
  t(`${id}: empty criticality → "3" (isempty, not coalesce)`, qq.includes('iff(isempty(tostring(criticality)), "3", tostring(criticality))') && !/coalesce\((tostring\()?criticality\)?, "3"\)/.test(qq));
  t(`${id}: empty team → "unassigned"`, qq.includes('iff(isempty(tostring(team)), "unassigned", tostring(team))') && !qq.includes('coalesce(tostring(team)'));
}

if (fail) process.exit(1);
