// Review R4: Settings → Alerts "Grace before alerting" (learning.GRACE_S) must hold back the asset writer's opening
// test: an asset opens only once silent_s > tolerance_s + GRACE_S, so a blip that recovers sooner never opens (and
// never resolves: no notification pair, no PagerDuty page). Resolution is not delayed by grace.
// No KQL interpreter exists offline: the writer's `elig` / `miss` expressions are pulled out of the search text and
// evaluated in JS on sample pulse_state rows.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ledgergrace-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));

const base = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
let n = 0, fail = 0;
const chk = (m, ok, msg) => { n++; if (!ok) { fail++; console.log(`FAIL [${m}] ${msg}`); } };

/** The KQL boolean expression assigned to `name` in the writer's `| extend miss = …, elig = …, one = 1` line, as JS. */
function expr(q, name) {
  const line = q.split('\n').find((l) => l.startsWith('| extend miss = '));
  if (!line) return null;
  const m = line.match(new RegExp(`${name} = (.*?)(?:, (?:elig|one) = )`));
  if (!m) return null;
  const js = m[1]
    .replace(/\(raw_state in \("ok", "late"\)\)/g, '(raw_state == "ok" or raw_state == "late")')
    .replace(/todouble\(/g, 'Number(').replace(/ and /g, ' && ').replace(/ or /g, ' || ').replace(/==/g, '===');
  return new Function('r', `with (r) { return (${js}); }`);
}

// One pulse_state row: tolerance 300 s, silent `sil` seconds at computed_at (body(): silent_s = now() - last_seen - 60).
const NOW = 1_800_000_000;
const row = (sil, tol = 300) => {
  const raw_state = sil > tol ? 'missing' : sil > 0.6 * tol ? 'late' : 'ok';
  return { lv: true, collective: false, covered: false, tolerance_s: tol, computed_at: NOW, last_seen: NOW - 60 - sil, raw_state, state: raw_state };
};

for (const rollup of ['off', 'auto']) for (const remindH of [0, 4]) for (const GRACE_S of [0, 300, 900]) {
  const m = `${rollup}/remindH ${remindH}/grace ${GRACE_S}`;
  const s = { dataset: 'pulse_metrics', learning: { ...base, GRACE_S }, rollup, notify: { targets: [], email: '', routes: [], remindH } };
  const q = K.ledgerQuery(s, 'asset');
  chk(m, q.length < 4000, `asset writer under 4000 chars (${q.length})`);
  chk(m, /iff\(miss and elig, iff\(n_led > 0, "opened", "open"\), "none"\)/.test(q), 'opening test is still `miss and elig`');
  const elig = expr(q, 'elig'), miss = expr(q, 'miss');
  chk(m, !!elig && !!miss, 'elig and miss found in the writer');
  if (!elig || !miss) continue;
  // Past tolerance but inside the grace window: missing, not yet eligible to open.
  const blip = row(300 + GRACE_S / 2 + 1);
  chk(m, blip.raw_state === 'missing', 'fixture: blip row is raw missing');
  chk(m, elig(blip) === (GRACE_S === 0), GRACE_S ? 'a blip inside the grace window does not open' : 'with no grace, missing opens at once');
  // Past tolerance + grace: opens.
  chk(m, elig(row(300 + GRACE_S + 30)) === true, 'silent past tolerance + grace opens');
  chk(m, elig(row(300 + GRACE_S)) === false, 'exactly tolerance + grace does not open yet (strict >, as newly_missing)');
  chk(m, elig(row(300 + GRACE_S + 1)) === true, 'one second past tolerance + grace opens');
  // Not missing: never eligible; collective/covered still suppress past grace.
  chk(m, elig(row(100)) === false, 'an ok asset does not open');
  chk(m, elig({ ...row(300 + GRACE_S + 30), collective: true }) === false, 'collective silence still suppresses');
  chk(m, elig({ ...row(300 + GRACE_S + 30), covered: true }) === false, 'cluster coverage still suppresses');
  // Review R5: eligibility is today's filter (newly_missing required state == "missing"): suppressions gate opening.
  // An asset acked while late or missing, or one still acked after a collective / covered phase ends, never opens;
  // nor does a muted, maintenance or learning one, whatever its raw_state.
  const past = row(300 + GRACE_S + 30);
  chk(m, elig({ ...past, state: 'acked' }) === false, 'an acked missing asset does not open');
  chk(m, elig({ ...past, state: 'acked', collective: false, covered: false }) === false, 'still acked after a collective / covered phase ends: does not open');
  chk(m, elig({ ...past, state: 'muted', lv: false }) === false, 'a muted missing asset does not open');
  chk(m, elig({ ...past, state: 'maintenance', lv: false }) === false, 'an asset in maintenance does not open');
  chk(m, elig({ ...past, state: 'learning', raw_state: 'learning', lv: false }) === false, 'a learning asset does not open');
  chk(m, elig(past) === true, 'state missing, live, not suppressed: opens');
  // An acked asset is still "missing" for resolution: an open incident stays open quietly until data returns.
  chk(m, miss({ ...past, state: 'acked' }) === true, 'acked does not resolve an open incident');
  // Grace never delays resolution: miss ignores it (an open incident resolves as soon as the asset is back).
  chk(m, miss(blip) === true && miss(row(100)) === false, 'miss (resolution) does not depend on grace');
  // silent_s = computed_at - last_seen - 60 (body()), so the writer compares computed_at - last_seen with GRACE_S + 60.
  chk(m, GRACE_S === 0 || q.includes(`computed_at - last_seen > todouble(tolerance_s) + ${GRACE_S + 60}`), 'grace seconds appear in the writer');
}
console.log(fail ? `ledger-grace: ${fail} failure(s)` : `ledger-grace OK (${n} checks)`);
process.exit(fail ? 1 : 0);
