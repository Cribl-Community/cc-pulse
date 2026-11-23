// Unit tests for src/lib/refresh.ts (spec 025 §1).
// Run: node scripts/test-refresh.mjs   (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rf-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/refresh.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'refresh.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const R = await import(join(tmp, 'refresh.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const src = readFileSync(join(root, 'src/lib/refresh.ts'), 'utf8');
t('no imports', () => !/^\s*import\s/m.test(src));
t('constants', () => R.DEFAULT_REFRESH === '5m' && R.GAPS_EVERY_S === 900 && R.REFRESH_CHOICES.join() === '1m,2m,5m,15m,manual');
t('refreshMs', () => R.refreshMs('1m') === 60000 && R.refreshMs('5m') === 300000 && R.refreshMs('manual') === undefined && R.refreshMs('zzz') === undefined);

const base = { choice: '1m', hidden: false, inFlight: false, lastAt: 0, nowMs: 60000 };
t('tick run when stale', () => R.tickDecision(base) === 'run');
t('tick run when lastAt undefined', () => R.tickDecision({ ...base, lastAt: undefined, nowMs: 5 }) === 'run');
t('tick skip hidden', () => R.tickDecision({ ...base, hidden: true }) === 'skip');
t('tick skip in flight', () => R.tickDecision({ ...base, inFlight: true }) === 'skip');
t('tick skip manual', () => R.tickDecision({ ...base, choice: 'manual' }) === 'skip');
t('tick skip not due', () => R.tickDecision({ ...base, nowMs: 59999 }) === 'skip');

t('onVisible stale', () => R.onVisible({ choice: '1m', lastAt: 0, nowMs: 60000 }) === true);
t('onVisible fresh', () => R.onVisible({ choice: '1m', lastAt: 1, nowMs: 60000 }) === false);
t('onVisible manual', () => R.onVisible({ choice: 'manual', lastAt: 0, nowMs: 1e9 }) === false);

t('pollDelay', () => [0, 1, 2, 3, 4].map(R.pollDelay).join() === '250,500,1000,2000,2000');

const h = { job: 'activity', rangeKey: 'a', live: true, last: { at: 1000, rangeKey: 'a' }, nowS: 1010, span: 300 };
t('hist no last', () => R.histDue({ ...h, last: undefined }) === true);
t('hist range change', () => R.histDue({ ...h, rangeKey: 'b' }) === true);
t('hist absolute same key', () => R.histDue({ ...h, live: false, nowS: 99999 }) === false);
t('hist activity same bin', () => R.histDue({ ...h, last: { at: 900, rangeKey: 'a' }, nowS: 1199 }) === false);
t('hist activity next bin', () => R.histDue({ ...h, last: { at: 900, rangeKey: 'a' }, nowS: 1200 }) === true);
t('hist heartbeat next bin', () => R.histDue({ ...h, job: 'heartbeat', last: { at: 900, rangeKey: 'a' }, nowS: 1200 }) === true);
t('hist gaps 899', () => R.histDue({ ...h, job: 'gaps', nowS: 1899 }) === false);
t('hist gaps 900', () => R.histDue({ ...h, job: 'gaps', nowS: 1900 }) === true);

if (fail) { console.log(`${fail} refresh test(s) failed`); process.exit(1); }
console.log('refresh tests passed');
