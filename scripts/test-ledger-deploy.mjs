// F6: writers deploy before alert searches; no needs on writers; no ledger lookups; no Seed step.
// Run: node scripts/test-ledger-deploy.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ld-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const s = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: ['system_notifications'], email: '', routes: [] }, learning };
const known = [{ id: 'system_notifications', type: 'bulletin_message' }];

globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
const plan = D.alertsPlan(s, true, undefined, known, { origin: 'https://org.cribl.cloud', base: '/app-ui/pulse' });
const ids = plan.map((x) => x.id);
const ix = (id) => ids.indexOf(id);
t('pulse_ledger_asset is in the plan', ix('pulse_ledger_asset') >= 0);
t('pulse_ledger_source is in the plan', ix('pulse_ledger_source') >= 0);
t('pulse_ledger_asset before pulse_alert_missing', ix('pulse_ledger_asset') >= 0 && ix('pulse_ledger_asset') < ix('pulse_alert_missing'));
t('pulse_ledger_source before pulse_alert_source_down', ix('pulse_ledger_source') >= 0 && ix('pulse_ledger_source') < ix('pulse_alert_source_down'));
const writers = new Set(['pulse_ledger_asset', 'pulse_ledger_source']);
t('no step needs a writer', plan.every((x) => !(x.needs ?? []).some((n) => writers.has(n))));
t('no pulse_incidents_ lookup', !D.lookupSteps().some((x) => x.id.includes('pulse_incidents_') || x.title.includes('pulse_incidents_')));
t('no Seed step', !plan.concat(D.lookupSteps()).some((x) => /seed/i.test(x.title) || /seed/i.test(x.id)));

process.exit(fail ? 1 : 0);
