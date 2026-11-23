// Measured cost line (spec 033 F10). Run: node scripts/test-search-cost.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-sc-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/searchCost.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 's.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const S = await import(join(tmp, 's.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const now = Date.UTC(2026, 10, 21, 12);
const H = 3600 * 1000;
const job = (name, ageH, cpu) => ({ name, timeStarted: now - ageH * H, ...(cpu === undefined ? {} : { cpuSeconds: cpu }) });

t('pulse_ jobs summed', Math.abs(S.pulseCpuHours([job('pulse_state', 1, 3600), job('pulse_rollup', 2, 1800)], now) - 1.5) < 1e-9);
t('other jobs excluded', S.pulseCpuHours([job('pulse_state', 1, 3600), job('adhoc', 1, 7200)], now) === 1);
t('only other jobs -> null', S.pulseCpuHours([job('adhoc', 1, 7200)], now) === null);
t('jobs older than 24 h excluded', S.pulseCpuHours([job('pulse_state', 1, 3600), job('pulse_state', 25, 7200)], now) === 1);
t('missing CPU -> null', S.pulseCpuHours([job('pulse_state', 1), job('pulse_x', 2)], now) === null);
t('missing CPU on some jobs ignored', S.pulseCpuHours([job('pulse_state', 1), job('pulse_x', 2, 1800)], now) === 0.5);
t('empty -> null', S.pulseCpuHours([], now) === null);
t('app-started job counted', S.pulseCpuHours([{ query: 'dataset="pulse_events" | take 1', timeStarted: now - H, cpuSeconds: 360 }], now, 'pulse_events') === 0.1);
t('format one decimal', S.costLine(1.26) === 'Pulse searches used 1.3 CPU-hours over the last 24 h');
t('format null -> no line', S.costLine(null) === null);
t('zero is a number', S.costLine(0) === 'Pulse searches used 0.0 CPU-hours over the last 24 h');

const al = readFileSync(join(root, 'src/pages/Alerts.tsx'), 'utf8');
t('Alerts shows the line only when set', /\{cost && <Text[^>]*>\{cost\}<\/Text>\}/.test(al));
const pol = readFileSync(join(root, 'config/policies.yml'), 'utf8').split('\n').filter((l) => /object:/.test(l) && !/^\s*#/.test(l));
const jobsGrants = pol.filter((l) => l.includes("'/m/default_search/search/jobs'") && l.includes('GET'));
t('exactly one GET grant on the jobs list', jobsGrants.length === 1);
const jobsSrc = readFileSync(join(root, 'src/lib/searchJobs.ts'), 'utf8');
t('searchJobs sends no write', !/method:/.test(jobsSrc));

if (fail) process.exit(1);
console.log('search-cost ok');
