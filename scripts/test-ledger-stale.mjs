// Review R3: an empty pulse_state snapshot (late or skipped run, or the rollup lagging: rollup_ok is one flag for the
// whole run) must not expire the open incidents, and must not empty the ledger (two empty runs would make the next run
// seed again). Text checks on both writer searches (no KQL interpreter exists offline).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ledgerstale-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));

const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
let n = 0, fail = 0;
const chk = (m, ok, msg) => { n++; if (!ok) { fail++; console.log(`FAIL [${m}] ${msg}`); } };
const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

for (const rollup of ['off', 'auto']) for (const remindH of [0, 4]) for (const kind of ['asset', 'source']) {
  const m = `${rollup}/remindH ${remindH}/${kind}`;
  const s = { dataset: 'pulse_metrics', learning: L, rollup, notify: { targets: [], email: '', routes: [], remindH } };
  const q = K.ledgerQuery(s, kind);
  const snap = `dataset="$vt_results" | where jobName == "pulse_state" | where computed_at >= now() - 300${rollup === 'auto' ? '\n| where rollup_ok' : ''}`;
  const start = q.indexOf(`| union (${snap} | summarize n_snap = count()`);
  chk(m, start > 0, 'the expired branch starts from the snapshot row count (rollup_ok applied in rollup mode)');
  if (start < 0) continue;
  const end = q.indexOf(kind === 'asset' ? '\n| extend incident_id' : '\n| extend asset = ""', start);
  chk(m, end > start, 'the branch ends before incident_id');
  const b = q.slice(start, end);
  // The count row is the left side, so the branch has a row even when the snapshot and the ledger are both empty.
  chk(m, /summarize n_snap = count\(\) \| extend one = 1\n\s*\| join kind=leftouter \(dataset="\$vt_results" \| where jobName == "pulse_ledger_/.test(b),
    'the open incidents are leftouter-joined onto the count row (on one)');
  chk(m, b.includes(`jobName == "pulse_ledger_${kind}"`), `reads pulse_ledger_${kind}`);
  chk(m, new RegExp(`kind=leftanti \\(${esc(snap)}`).test(b), 'leftanti against the same freshness-filtered snapshot');
  chk(m, /\| extend up = n_snap > 0/.test(b), 'up = the snapshot has rows');
  // Gone entities expire only when the snapshot has rows.
  chk(m, b.includes('up, iff(pe in ("resolved", "expired"), pe, "expired")'), 'expired only under up');
  chk(m, q.replaceAll('pe in ("resolved", "expired")', '').split('"expired"').length === 2, 'no other place emits "expired"');
  chk(m, !/event = iff\(pe in \("resolved", "expired"\), pe, "expired"\)/.test(q), 'no unconditional expired (the old form)');
  // Empty snapshot: every open incident carried forward (open, or its pending event), plus one "none" row.
  chk(m, /\| where up == false or \(isnotnull\(pe\) and \(pend == false or pe != "opened"\)\)/.test(b), 'empty snapshot keeps every open incident; else the pending-opened drop of gone entities');
  chk(m, /event = case\(isnull\(pe\), "none", up, .*, pend, pe, "open"\)/.test(b), 'not up: pending event kept, else "open"; no incident → one "none" row');
  chk(m, /opened_at = po, notified_at = pt, last_seen_at_open = pl\)$/.test(b), 'carried rows keep opened_at (same incident_id) and notified_at');
  chk(m, kind === 'source' || q.length < 4000, `asset writer under 4000 chars (${q.length})`);
}
console.log(fail ? `ledger-stale: ${fail} failure(s)` : `ledger-stale OK (${n} checks)`);
process.exit(fail ? 1 : 0);
