// Tests for the cadence-aware snapshotQuery / snapshotVerdict in src/lib/snapshot.ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-snl-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/snapshot.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 's.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const S = await import(join(tmp, 's.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

const std = 'dataset="$vt_results" | where jobName == "pulse_state"';
t('standard byte-identical', S.snapshotQuery('standard') === std && S.snapshotQuery() === std);
t('daily reads pulse_roll_call, -26h', S.snapshotQuery('daily').includes('jobName == "pulse_roll_call"') && S.snapshotEarliest('daily') === '-26h' && S.snapshotJobOf('daily') === 'pulse_roll_call');
t('hourly -2h, pulse_state', S.snapshotQuery('hourly') === std && S.snapshotEarliest('hourly') === '-2h');
t('standard earliest -1h', S.snapshotEarliest('standard') === '-1h');
t('cadence object accepted', S.snapshotQuery({ snapshotJob: 'pulse_roll_call', snapshotEarliest: '-26h' }).includes('pulse_roll_call'));

const saved = { query: 'dataset="d" | extend computed_at = now()', schedule: { enabled: true } };
const v = (age, maxAgeS) => { const r = S.snapshotVerdict({ saved, dataset: 'd', rows: [{ computed_at: 1_000_000 }], nowS: 1_000_000 + age, maxAgeS }); return r.use ? 'use' : r.reason; };
t('maxAgeS 90000: 24h use', v(24 * 3600, 90000) === 'use');
t('maxAgeS 90000: 26h stale', v(26 * 3600, 90000) === 'stale');
t('default 900: 800 use, 1000 stale', v(800) === 'use' && v(1000) === 'stale');

// R1: the real pulse_roll_call query (it carries the previous roll call forward from $vt_results) is a usable snapshot.
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/kql.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'k.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const K = await import(join(tmp, 'k.mjs'));
const settings = { dataset: 'd', learning: { LOOKBACK: '-24h', GRACE_S: 0, MIN_GAP: 60, K: 4, MAX_GAP: 3600, LEARN_MIN: 30, FUTURE_S: 60, LAG_MAX: 600, VOL_MIN: 0.3 },
  notify: {}, rollup: 'auto', searchLoad: 'daily', rollCall: { hour: 6, tz: 'UTC', allClear: false } };
const rc = K.savedSearches(settings).find((x) => x.id === 'pulse_roll_call');
t('roll call query reads $vt_results (the carry-forward)', !!rc && rc.query.includes('dataset="$vt_results"'));
const rcVerdict = (q, age = 24 * 3600, dataset = 'd') => {
  const r = S.snapshotVerdict({ saved: { query: q, schedule: { enabled: true } }, dataset, rows: [{ computed_at: 1_000_000 }], nowS: 1_000_000 + age, maxAgeS: 90000 });
  return r.use ? 'use' : r.reason;
};
t('Economy: the real roll call is used as the snapshot (24 h old)', rcVerdict(rc.query) === 'use');
t('Economy: the real roll call 26 h old is stale, not other-dataset', rcVerdict(rc.query, 26 * 3600) === 'stale');
t('Economy: roll call built for another dataset is other-dataset', rcVerdict(rc.query, 3600, 'other') === 'other-dataset');
t('$vt_results plus a foreign dataset is still other-dataset',
  rcVerdict('dataset="d" | union (dataset="$vt_results" | where jobName == "x") | union (dataset="e")') === 'other-dataset');
t('$vt_results alone with a dataset set is other-dataset', rcVerdict('dataset="$vt_results" | where jobName == "x"') === 'other-dataset');

process.exit(fails ? 1 : 0);
