// F7: historyShouldRun decides when the history queries run. Run: node scripts/test-history-gate.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-hg-'));
const build = (entry, out) => execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
  `--outfile=${join(tmp, out)}`, '--log-level=error'], { stdio: 'pipe' });
build('src/lib/refresh.ts', 'r.mjs');
build('src/lib/cadence.ts', 'c.mjs');
const { historyShouldRun } = await import(join(tmp, 'r.mjs'));
const { cadenceOf } = await import(join(tmp, 'c.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const run = (load, loaded, trigger) => historyShouldRun({ historyOnTick: cadenceOf(load).historyOnTick, loaded, trigger });

t('daily: open → no', run('daily', false, 'open') === false);
t('daily: tick → no', run('daily', false, 'tick') === false);
t('daily: timescope before load → no', run('daily', false, 'timescope') === false);
t('daily: loadCharts → run', run('daily', false, 'loadCharts') === true);
t('daily: timescope after load → run', run('daily', true, 'timescope') === true);
t('daily: tick after load → no', run('daily', true, 'tick') === false);
for (const load of ['standard', 'hourly'])
  for (const trigger of ['open', 'tick', 'timescope'])
    t(`${load}: ${trigger} → run`, run(load, false, trigger) === true);

const st = readFileSync(join(root, 'src/state.tsx'), 'utf8');
t('state.tsx has no hard-coded pulse_state / 900 for the snapshot', !/saved\/pulse_state/.test(st) && !/maxAgeS: 900/.test(st) && /cadenceOf\(/.test(st));
t('state.tsx exposes loadCharts and historyLoaded', /histLoading, historyLoaded, loadCharts/.test(st));

console.log(fail ? `${fail} failed` : 'history-gate ok');
process.exit(fail ? 1 : 0);
