// Unit tests for src/lib/history.ts (spec 014 §4, feature F2): clipping, ongoing silence, bounds, flapping.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-hist-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/history.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'h.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const Hm = await import(join(tmp, 'h.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const near = (a, b) => Math.abs(a - b) < 1e-9;
const NOW = 1762698034, H = 3600;
const E = (asset, o = {}) => ({ key: `g|${asset}|${asset}`, group: 'g', input: asset, asset, state: 'ok', raw: 'ok', silent_s: 0, tolerance_s: 300, last_seen: NOW - 10, ...o });
const G = (s, e) => ({ start: NOW - s, end: NOW - e, secs: s - e });
const w1 = { from: NOW - H, to: NOW };

const a = E('a');
t('straddling silence counts only its clipped part (over part [-3700,-1000] in last hour = 1000..)', () => Hm.healthOf(a, [G(4000, 1000)], w1, NOW).downtime_s === 2600);
t('silence wholly before the window is not an incident', () => Hm.healthOf(a, [G(9000, 8000)], w1, NOW).incidents === 0);
const b = E('b', { raw: 'missing', last_seen: NOW - 2 * H, silent_s: 2 * H });
t('ongoing silence excluded from a window ending before last_seen+tolerance', () => { const h = Hm.healthOf(b, [], { from: NOW - 3 * H, to: NOW - 2 * H + 100 }, NOW); return h.incidents === 0 && h.availability === 1; });
t('availability clamped to [0,1]', () => { const h = Hm.healthOf(b, [G(7000, 10), G(7000, 10)], w1, NOW); return h.availability >= 0 && h.availability <= 1; });
t('previous window consistent with current', () => { const c = Hm.healthOf(b, [], w1, NOW), p = Hm.healthOf(b, [], { from: NOW - 2 * H, to: NOW - H }, NOW); return near(c.downtime_s, H) && near(p.downtime_s, H - 300); });
const c = E('c'), L = { [c.key]: [G(30000, 29000), G(25000, 24000), G(20000, 19000), G(1500, 400)] };
t('flappers: 4 incidents in 48h flap, 2 do not', () => Hm.flappers([c], L, { from: NOW - 48 * H, to: NOW })[0]?.n === 4 && Hm.flappers([c], { [c.key]: L[c.key].slice(0, 2) }, { from: NOW - 48 * H, to: NOW }).length === 0);
t('flappers: a 1h window with one overlapping incident does not flap', () => Hm.flappers([c], L, w1).length === 0);
const three = { [c.key]: [G(3000, 2000), G(1800, 1000), G(900, 100)] };
t('flappers: 3 overlapping incidents in 1h flap', () => Hm.flappers([c], three, w1)[0]?.n === 3);
if (fail) process.exit(1);
console.log('history: ok');
