// Review R1 (spec 038): the Alerts page's PlanRunner must start fresh when the search load changes.
// PlanRunner keeps step status by step id and is not reset on its own. Every Economy plan id is also a
// Standard plan id, so without a remount, Standard → apply → Economy showed the Economy plan as "Applied".
// Run: node scripts/test-alerts-plan-reset.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-apr-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral', '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));
globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const mk = (load) => ({ dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: ['a'], email: '' }, learning,
  searchLoad: load, rollCall: { hour: 7, tz: 'Europe/Paris', allClear: false } });

// PlanRunner's "finished" rule (PlanRunner.tsx), applied to a status map carried over from another plan.
const finished = (steps, status) => steps.length > 0 && steps.every((st) => status[st.id]?.s === 'done' || status[st.id]?.s === 'skipped');
const doneAll = (steps) => Object.fromEntries(steps.map((st) => [st.id, { s: 'done', msg: 'updated' }]));

const plans = Object.fromEntries(['standard', 'hourly', 'daily'].map((l) => [l, D.alertsPlan(mk(l), true, undefined, [])]));
const ids = (l) => new Set(plans[l].map((s) => s.id));

// The hazard the review found: these load pairs share every id, so a status map kept by id reads as "Applied".
t('every Economy step id is also a Standard step id', [...ids('daily')].every((id) => ids('standard').has(id)));
t('kept status: Standard apply then Economy would read as finished', finished(plans.daily, doneAll(plans.standard)));
t('kept status: Economy apply then Standard does not (it has extra steps)', !finished(plans.standard, doneAll(plans.daily)));
t('Standard and Hourly share step ids too', [...ids('hourly')].every((id) => ids('standard').has(id)));

// A fresh status (what a remount gives) leaves the new plan pending.
t('fresh status: Economy plan is not finished', !finished(plans.daily, {}));

// Alerts is configuration-only (spec 041): deploy happens from Setup, not a PlanRunner on this page.
const src = readFileSync(join(root, 'src/pages/Alerts.tsx'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
t('Alerts.tsx contains no PlanRunner', !/<PlanRunner\b/.test(src));
t('Alerts.tsx contains Deploy from Setup', /Deploy from Setup/.test(src));

if (fail) { console.log(`${fail} failure(s)`); process.exit(1); }
console.log('alerts plan reset: all ok');
