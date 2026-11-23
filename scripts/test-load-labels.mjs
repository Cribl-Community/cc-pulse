// loadLabels: helper wording per load. Run: node scripts/test-load-labels.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ll-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/loadLabels.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'l.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const L = await import(join(tmp, 'l.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const rc = { hour: 7, tz: 'Europe/Paris' };
t('standard', L.refreshHelper('standard', rc).includes('computed every 5 min'));
t('hourly', L.refreshHelper('hourly', rc).includes('(every hour)'));
t('daily', L.refreshHelper('daily', rc).includes('once a day at 07:00 (Europe/Paris)'));
t('rollup daily', L.rollupLine('daily') === 'Rollup: off in Economy');
t('rollup standard', L.rollupLine('standard') === null && L.rollupLine('hourly') === null);
t('items', L.LOAD_ITEMS.map((i) => i.label).join() === 'Standard,Hourly,Economy');
const setup = readFileSync(join(root, 'src/components/SetupAlerts.tsx'), 'utf8');
t('setup load text', /Search load:/.test(setup) && /LOAD_ITEMS/.test(setup) && !/SelectField/.test(setup));
const page = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
t('setup does not save searchLoad', !/saveSettings\(/.test(page));
process.exit(fail ? 1 : 0);