// Review R6: the source ledger writer's crit_min / teams are aggregated over the currently missing assets only, so a
// recovered source has crit_min null (the alert search coalesces it to 3) and no teams. A reused row (resolved,
// reminder, open, a retried event) must keep the values its incident opened with (pc / pm), as the expired branch
// does, so a P1 or team route that received `opened` also matches `resolved` (spec 030 §3).
// No KQL interpreter exists offline: the writer's assignments of crit_min / teams after the previous-ledger join are
// pulled out of the search text and evaluated in JS, then the route condition (routes.ts) is evaluated on the result.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ledgerkeep-'));
const build = (src, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, src), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/kql.ts', 'k.mjs');
build('src/lib/routes.ts', 'r.mjs');
const K = await import(join(tmp, 'k.mjs'));
const R = await import(join(tmp, 'r.mjs'));

const base = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const ALL_EVENTS = ['opened', 'reminder', 'resolved', 'expired'];
let n = 0, fail = 0;
const chk = (m, ok, msg) => { n++; if (!ok) { fail++; console.log(`FAIL [${m}] ${msg}`); } };

/** Split on top-level commas (not inside parentheses or strings). */
function splitTop(s) {
  const out = []; let d = 0, q = false, cur = '';
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === '(') d++;
    if (!q && ch === ')') d--;
    if (!q && d === 0 && ch === ',') { out.push(cur.trim()); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** KQL scalar expression → JS function of a row (iff, toint, coalesce, and/or/==). */
function toFn(e) {
  const js = e.replace(/\biff\(/g, '__iff(').replace(/\btoint\(/g, '__toint(').replace(/\bcoalesce\(/g, '__co(')
    .replace(/ and /g, ' && ').replace(/ or /g, ' || ').replace(/==/g, '===');
  return new Function('r', `const __iff = (c, a, b) => c ? a : b, __toint = (x) => x == null || x === '' ? null : Math.trunc(Number(x)), __co = (...a) => a.find((x) => x != null) ?? null;
    with (r) { return (${js}); }`);
}

/** The main branch's final assignments to `cols`: the `| extend` clauses after the previous-ledger join, before the
 *  union. An unassigned column keeps the entity aggregate (identity). */
function mainAssign(q, cols) {
  const start = q.indexOf('| extend reuse = isnotnull(pe)');
  const end = q.indexOf('\n| union (');
  const seg = q.slice(start, end);
  const fns = Object.fromEntries(cols.map((c) => [c, (r) => r[c]]));
  for (const clause of seg.split(/\n\| extend /).slice(1)) {
    for (const a of splitTop(clause.replace(/\n\s*/g, ' '))) {
      const m = a.match(/^(\w+) = ([\s\S]*)$/);
      if (m && cols.includes(m[1])) fns[m[1]] = toFn(m[2]);
    }
  }
  return fns;
}

/** The alert search's view of a row (groupedColumns in kql.ts) and a route condition evaluated on it. */
const alertView = (row) => ({ ...row, crit_min: row.crit_min ?? 3, teams_j: `,${(row.teams ?? []).join(',')},` });
function routeFn(cond) {
  const js = cond.replace(/\btoint\(/g, 'Number(')
    .replace(/(\w+) contains_cs ("(?:[^"\\]|\\.)*")/g, '$1.includes($2)')
    .replace(/event in \(([^)]*)\)/g, '[$1].includes(event)')
    .replace(/ and /g, ' && ').replace(/==/g, '===');
  return new Function('r', `with (r) { return (${js}); }`);
}

for (const rollup of ['off', 'auto']) for (const remindH of [0, 4]) {
  const m = `${rollup}/remindH ${remindH}`;
  const s = { dataset: 'pulse_metrics', learning: base, rollup, notify: { targets: [], email: '', routes: [], remindH } };
  const q = K.ledgerQuery(s, 'source');
  chk(m, q.length < 4000, `source writer under 4000 chars (${q.length})`);
  chk(m, q.indexOf('| extend reuse = isnotnull(pe)') > 0 && q.indexOf('\n| union (') > 0, 'writer has the reuse step and the union branch');
  chk(m, /crit_min = pc, teams = pm/.test(q), 'expired branch still keeps pc / pm');
  const f = mainAssign(q, ['crit_min', 'teams']);

  // The source recovered: no missing asset, so the aggregates are null / empty. The incident opened at P1 for db, net.
  const recovered = { reuse: true, pe: 'opened', pc: 1, pm: ['db', 'net'], crit_min: null, teams: [] };
  chk(m, f.crit_min(recovered) === 1, `resolved row keeps crit_min 1 (got ${f.crit_min(recovered)})`);
  chk(m, JSON.stringify(f.teams(recovered)) === '["db","net"]', `resolved row keeps teams (got ${JSON.stringify(f.teams(recovered))})`);
  // pc read back from $vt_results as a string still compares as a number.
  chk(m, f.crit_min({ ...recovered, pc: '2' }) === 2, 'a string pc is read as a number');
  // Reminder / open (still down, other assets missing now): the row keeps the incident's opening values.
  const still = { reuse: true, pe: 'opened', pc: 1, pm: ['db'], crit_min: 3, teams: ['web'] };
  chk(m, f.crit_min(still) === 1 && JSON.stringify(f.teams(still)) === '["db"]', 'reminder / open row keeps the opening crit_min and teams');
  // A new incident takes the current aggregates.
  const fresh = { reuse: false, pe: null, pc: null, pm: null, crit_min: 1, teams: ['db', 'net'] };
  chk(m, f.crit_min(fresh) === 1 && JSON.stringify(f.teams(fresh)) === '["db","net"]', 'opened row takes the current aggregates');

  // End to end on a route: the P1 route and the team routes that got `opened` also get `resolved`.
  const opened = alertView({ event: 'opened', crit_min: f.crit_min(fresh), teams: f.teams(fresh) });
  const resolved = alertView({ event: 'resolved', crit_min: f.crit_min(recovered), teams: f.teams(recovered) });
  for (const when of [{ maxCriticality: 1 }, { team: 'db' }, { maxCriticality: 1, team: 'net' }]) {
    const match = routeFn(R.routeCondition(when, 'source_down', ALL_EVENTS));
    chk(m, match(opened), `route ${JSON.stringify(when)} matches opened`);
    chk(m, match(resolved), `route ${JSON.stringify(when)} matches resolved`);
  }
}

console.log(`test-ledger-source-keep: ${n - fail}/${n} passed`);
if (fail) process.exit(1);
