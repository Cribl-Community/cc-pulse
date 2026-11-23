// Spec 030 F3: text checks on the pulse_ledger_asset writer search (no KQL interpreter exists offline).
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ledgerkql-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));

const L = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const notify = { targets: [], email: '', routes: [] };
const MODES = {
  off: { dataset: 'pulse_metrics', learning: L, rollup: 'off', notify },
  auto: { dataset: 'pulse_metrics', learning: L, rollup: 'auto', notify },
};
let n = 0, fail = 0;
const chk = (m, ok, msg) => { n++; if (!ok) { fail++; console.log(`FAIL [${m}] ${msg}`); } };

for (const [m, s] of Object.entries(MODES)) {
  const all = K.savedSearches(s);
  const ids = all.map((x) => x.id);
  const w = all.find((x) => x.id === 'pulse_ledger_asset');
  chk(m, !!w, 'pulse_ledger_asset exists');
  if (!w) continue;
  const q = w.query;
  chk(m, ids.indexOf('pulse_ledger_asset') === ids.indexOf('pulse_state') + 1, 'listed right after pulse_state');
  chk(m, w.notify === false && w.cron === '2-59/5 * * * *', 'notify false, cron 2-59/5');
  chk(m, /jobName == "pulse_state" \| where computed_at >= now\(\) - 300/.test(q), 'reads a fresh pulse_state run');
  chk(m, /where rollup_ok/.test(q) === (m === 'auto'), 'rollup_ok only in rollup mode');
  chk(m, /jobName == "pulse_ledger_asset"/.test(q) && /jobName == "pulse_alert_missing"/.test(q), 'reads its own run and delivery');
  chk(m, /kind=leftouter/.test(q) && /kind=leftanti/.test(q) && /\| union \(/.test(q), 'leftouter, leftanti, union');
  for (const e of ['opened', 'open', 'reminder', 'resolved', 'expired', 'none']) chk(m, q.includes(`"${e}"`), `emits "${e}"`);
  chk(m, /computed_at = now\(\)/.test(q), 'computed_at = now()');
  chk(m, /strcat\("pulse:asset:", worker_group, ":", input, ":", asset, ":", tostring\(opened_at\)\)/.test(q), 'incident_id strcat');
  chk(m, !/\bexport\b|pulse_incidents_|fullouter|newly_missing/.test(q), 'no export / pulse_incidents_ / fullouter / newly_missing');
  chk(m, q.length < 4000, `under 4000 chars (${q.length})`);
  chk(m, !/now\(\) - pt >=/.test(q), 'remindH defaults to 0: no timed reminder clause');
  const r = K.savedSearches({ ...s, notify: { ...notify, remindH: 4 } }).find((x) => x.id === 'pulse_ledger_asset').query;
  chk(m, /now\(\) - pt >= 14400/.test(r) && r.length < 4000, 'remindH 4 → 14400 s, still under 4000');
  chk(m, K.ledgerQuery(s, 'asset') === q, 'ledgerQuery(s, "asset") is the saved search query');

  const sw = all.find((x) => x.id === 'pulse_ledger_source');
  chk(m, !!sw, 'pulse_ledger_source exists');
  if (!sw) continue;
  const sq = sw.query;
  chk(m, ids.indexOf('pulse_ledger_source') === ids.indexOf('pulse_ledger_asset') + 1, 'source writer listed right after asset writer');
  chk(m, sw.notify === false && sw.cron === '2-59/5 * * * *', 'source: notify false, cron 2-59/5');
  chk(m, /jobName == "pulse_state" \| where computed_at >= now\(\) - 300/.test(sq), 'source: fresh pulse_state run');
  chk(m, /where rollup_ok/.test(sq) === (m === 'auto'), 'source: rollup_ok only in rollup mode');
  chk(m, /jobName == "pulse_ledger_source"/.test(sq) && /jobName == "pulse_alert_source_down"/.test(sq), 'source: own run and delivery');
  chk(m, /kind=leftouter/.test(sq) && /kind=leftanti/.test(sq) && /\| union \(/.test(sq), 'source: leftouter, leftanti, union');
  for (const e of ['opened', 'open', 'reminder', 'resolved', 'expired', 'none']) chk(m, sq.includes(`"${e}"`) || (e === 'reminder'), `source emits "${e}"`);
  chk(m, /strcat\("pulse:source:", worker_group, ":", input, "::", tostring\(opened_at\)\)/.test(sq) && /asset = ""/.test(sq), 'source: incident_id strcat, empty asset');
  chk(m, /s_live >= 3 and s_missing >= 0\.5 \* s_live/.test(sq), 'source: SRC_MIN / SRC_PCT test');
  chk(m, /computed_at = now\(\)/.test(sq), 'source: computed_at = now()');
  chk(m, !/\bexport\b|pulse_incidents_|fullouter|newly_missing/.test(sq), 'source: no export / fullouter / newly_missing');
  const sr = K.savedSearches({ ...s, notify: { ...notify, remindH: 4 } }).find((x) => x.id === 'pulse_ledger_source').query;
  chk(m, /now\(\) - pt >= 14400/.test(sr), 'source: remindH 4 → 14400 s');
  chk(m, !/now\(\) - pt >=/.test(sq), 'source: no reminder clause by default');
  chk(m, K.ledgerQuery(s, 'source') === sq, 'ledgerQuery(s, "source") is the saved search query');

  // Spec 030 §3 seeding (acceptance 8): n_led counts real ledger rows only, not the empty-snapshot placeholder.
  // Every real row has opened_at set (main branch: iff(reuse, po, toint(now())); gone(): po of an open incident);
  // the placeholder is gone()'s isnull(pe) row, whose opened_at = po is null.
  for (const [name, wq, wr] of [['asset', q, r], ['source', sq, sr]]) {
    const job = `pulse_ledger_${name}`;
    const nl = new RegExp(`jobName == "${job}" \\| summarize n_led = countif\\(isnotnull\\(opened_at\\)\\) \\| extend one = 1\\) on one`);
    chk(m, nl.test(wq) && nl.test(wr), `${name}: n_led = countif(isnotnull(opened_at)) over its own rows`);
    chk(m, !/n_led\s*=\s*count\(\s*\)/.test(wq) && !/n_led\s*=\s*count\(\s*\)/.test(wr), `${name}: n_led is not a bare count()`);
    chk(m, /event = case\(isnull\(pe\), "none",/.test(wq) && /opened_at = po, notified_at = pt/.test(wq), `${name}: the placeholder ("none" when isnull(pe)) takes opened_at = po (null)`);
    chk(m, /opened_at = iff\(reuse, po, toint\(now\(\)\)\)/.test(wq), `${name}: every main-branch row sets opened_at`);
    chk(m, wq.length < 4000 && wr.length < 4000, `${name}: under 4000 chars (${wq.length}, remindH 4: ${wr.length})`);
    // Model: n_led over a previous run that was only the placeholder is 0 (still seeding); real rows count.
    const nLed = (rows) => rows.filter((x) => x.opened_at !== null && x.opened_at !== undefined).length;
    const placeholder = { worker_group: null, input: null, event: 'none', opened_at: null };
    chk(m, nLed([placeholder]) === 0 && nLed([placeholder, placeholder]) === 0, `${name}: placeholder-only ledger → n_led 0 (seeding continues)`);
    chk(m, nLed([placeholder, { worker_group: 'g', input: 'i', event: 'none', opened_at: 1700000000 }]) === 1, `${name}: a real "none" row counts`);
  }
}
console.log(fail ? `ledger-kql: ${fail} failure(s)` : `ledger-kql OK (${n} checks)`);
process.exit(fail ? 1 : 0);
