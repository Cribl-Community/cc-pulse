// installedLoad: installed crons -> load or null (spec 033 F9). Run: node scripts/test-installed-load.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-il-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/cadence.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'c.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const C = await import(join(tmp, 'c.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const st = (id, cron, enabled = true, exists = true) => ({ id, desc: '', cron, enabled, exists });

t('standard', C.installedLoad([st('pulse_state', '*/5 * * * *')]) === 'standard');
t('hourly', C.installedLoad([st('pulse_state', '5 * * * *')]) === 'hourly');
t('daily', C.installedLoad([st('pulse_state', '5 * * * *', false), st('pulse_roll_call', '0 7 * * *')]) === 'daily');
t('nothing installed', C.installedLoad([st('pulse_state', '*/5 * * * *', false, false)]) === null);
t('empty', C.installedLoad([]) === null);
t('disabled', C.installedLoad([st('pulse_state', '*/5 * * * *', false)]) === null);
t('odd cron', C.installedLoad([st('pulse_state', '*/7 * * * *')]) === null);
t('roll call not installed', C.installedLoad([st('pulse_roll_call', '0 7 * * *', true, false)]) === null);

if (fail) process.exit(1);
console.log('installed-load ok');
