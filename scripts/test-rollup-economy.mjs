// F4: Economy runs no rollup check; Overview 'behind' uses effectiveRollup. Source inspection.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const state = readFileSync(new URL('../src/state.tsx', import.meta.url), 'utf8');
const ov = readFileSync(new URL('../src/pages/Overview.tsx', import.meta.url), 'utf8');

const fn = (src, start) => src.slice(src.indexOf(start), src.indexOf(start) + 400);
assert.match(fn(state, 'const checkRollup'), /effectiveRollup\(s\) !== 'auto'\) return/, 'checkRollup guarded');
assert.match(fn(state, 'const startRollupCheck'), /effectiveRollup\(s\) !== 'auto'/, 'startRollupCheck guarded');

const eff = state.slice(state.indexOf('the rollup check repeats every 15 min'));
const guard = eff.indexOf("effectiveRollup(settings) !== 'auto'");
const timer = eff.indexOf('setInterval');
assert.ok(guard > 0 && guard < timer, 'timer comes after the Economy guard');
assert.match(eff.slice(guard, timer), /verdictRef\.current = undefined[\s\S]*return;/, 'verdict cleared, early return');
assert.match(state, /rollupVerdict: effectiveRollup\(settings\) === 'auto' \? rollupVerdict : undefined/, 'exposed verdict is cleared in Economy');

assert.match(ov, /rollupBehind = effectiveRollup\(pulse\.settings\) === 'auto'/);
assert.ok(!/settings\.rollup === 'auto'/.test(ov), 'no direct settings.rollup test');
console.log('test-rollup-economy: ok');
