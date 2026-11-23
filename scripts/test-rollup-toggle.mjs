// R2: the rollup-check effect follows settings.rollup. Off -> auto starts a check and the 15 min timer at once;
// auto -> off clears the timer, and the timer reads the current settings at fire time.
// Runs the effect body and dependency list taken from src/state.tsx under a tiny useEffect that re-runs on a dep change.
// Run: node scripts/test-rollup-toggle.mjs   (also run by `npm test`)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rt-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/settings.ts'), '--bundle', '--format=esm', '--platform=neutral',
  `--outfile=${join(tmp, 'settings.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const { effectiveRollup } = await import(join(tmp, 'settings.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const state = readFileSync(join(root, 'src/state.tsx'), 'utf8');
const from = state.indexOf('the rollup check repeats every 15 min');
const open = state.indexOf('useEffect(() => {', from) + 'useEffect(() => {'.length;
const close = state.indexOf('}, [', open);
const body = state.slice(open, close);
const deps = state.slice(close + 3, state.indexOf(']', close + 3) + 1);
t('effect found', () => from > 0 && body.includes('setInterval') && deps.startsWith('['));
t('settings.rollup is a dependency', () => /\bsettings\.rollup\b/.test(deps));
t('the timer does not close over the settings of its render', () => !/setInterval\([^\n]*checkRollup\(settings\)/.test(body));

// The scope the effect body and its deps read, with call-recording stand-ins for checkRollup / startRollupCheck
// (both guard on effectiveRollup as the real ones do).
const ref = (v) => ({ current: v });
const env = {
  DEMO: false, loaded: true, settings: undefined, effectiveRollup, ROLLUP_CHECK_MS: 900_000,
  rollupCheckKey: ref(undefined), rollupCheckLoad: ref(undefined), rollupSeq: ref(0), verdictRef: ref(undefined), rollupSettings: ref(undefined),
  jobs: [], timers: new Map(), nextId: 1,
};
env.checkRollup = async (s) => { if (effectiveRollup(s) !== 'auto') return; env.jobs.push({ kind: 'check', rollup: s.rollup, load: s.searchLoad }); };
env.startRollupCheck = (s) => {
  if (effectiveRollup(s) !== 'auto') return Promise.resolve();
  env.rollupCheckKey.current = `${s.dataset}|${s.learning.LOOKBACK}`;
  env.jobs.push({ kind: 'start', rollup: s.rollup, load: s.searchLoad });
  return Promise.resolve();
};
env.setInterval = (fn) => { const id = env.nextId++; env.timers.set(id, fn); return id; };
env.clearInterval = (id) => { env.timers.delete(id); };
const names = Object.keys(env).filter((k) => !['jobs', 'timers', 'nextId'].includes(k));
const scoped = (src) => new Function('env', `const { ${names.join(', ')} } = env; ${src}`);
const effect = (e) => scoped(body)(e);
const depsOf = (e) => scoped(`return ${deps};`)(e);

// A render: the ref takes the new settings, and the effect re-runs (after its cleanup) only when a dep changed.
let prevDeps, cleanup;
const render = (settings) => {
  env.settings = settings; env.rollupSettings.current = settings;
  const d = depsOf({ ...env, settings });
  if (prevDeps && d.length === prevDeps.length && d.every((x, i) => Object.is(x, prevDeps[i]))) return;
  cleanup?.(); prevDeps = d;
  cleanup = effect({ ...env, settings });
};
const tick = () => { for (const fn of env.timers.values()) fn(); };
const reset = () => { env.jobs.length = 0; };

const base = { dataset: 'main', learning: { LOOKBACK: '-24h' }, refresh: '5m' };
for (const load of ['standard', 'hourly']) {
  env.timers.clear(); env.rollupCheckKey.current = undefined; env.rollupCheckLoad.current = undefined; prevDeps = undefined; cleanup = undefined; reset();
  render({ ...base, searchLoad: load, rollup: 'off' });
  t(`${load}, opens with Rollup off: no check, no timer`, () => env.jobs.length === 0 && env.timers.size === 0);

  render({ ...base, searchLoad: load, rollup: 'auto' });
  t(`${load}, off -> auto: a check starts at once`, () => env.jobs.length === 1 && env.jobs[0].kind === 'start' && env.jobs[0].rollup === 'auto' || JSON.stringify(env.jobs));
  t(`${load}, off -> auto: one 15 min timer`, () => env.timers.size === 1);
  reset(); tick();
  t(`${load}, auto: the timer re-checks`, () => env.jobs.length === 1 && env.jobs[0].kind === 'check' || JSON.stringify(env.jobs));

  reset();
  render({ ...base, searchLoad: load, rollup: 'off' });
  t(`${load}, auto -> off: the timer is cleared`, () => env.timers.size === 0);
  tick();
  t(`${load}, auto -> off: no _5m job afterwards`, () => env.jobs.length === 0 || JSON.stringify(env.jobs));

  render({ ...base, searchLoad: load, rollup: 'auto' });
  t(`${load}, off -> auto again: checks again`, () => env.jobs.some((j) => j.kind === 'start') && env.timers.size === 1);
  // An unrelated settings change keeps the timer, which must read the settings of now, not of its render.
  render({ ...base, searchLoad: load, rollup: 'auto', refresh: '1m' });
  env.rollupSettings.current = { ...base, searchLoad: load, rollup: 'off' }; // a newer render the effect has not seen yet
  reset(); tick();
  t(`${load}: the timer reads the current settings at fire time`, () => env.jobs.length === 0 || JSON.stringify(env.jobs));
  cleanup?.();
}

// Economy (searchLoad 'daily') never checks, whatever the setting.
env.timers.clear(); prevDeps = undefined; cleanup = undefined; reset();
render({ ...base, searchLoad: 'daily', rollup: 'auto' });
t('economy: no check, no timer', () => env.jobs.length === 0 && env.timers.size === 0);

if (fail) { console.log(`${fail} failure(s)`); process.exit(1); }
console.log('test-rollup-toggle: all passed');
