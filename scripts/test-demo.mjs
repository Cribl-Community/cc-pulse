// Unit tests for src/lib/demo.ts (spec 014 §7, feature F12): the demo generators follow the window and bin spans,
// and the gaps cover the previous period so a 24h demo has an incidents delta.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-demo-'));
const lib = (f) => JSON.stringify(join(root, 'src/lib', f));
const entry = join(tmp, 'entry.ts');
writeFileSync(entry, [
  `export * as D from ${lib('demo.ts')};`, `export * as T from ${lib('timescope.ts')};`, `export * as H from ${lib('history.ts')};`,
  `export * as M from ${lib('model.ts')};`, `export * as I from ${lib('inventory.ts')};`, `export * as S from ${lib('settings.ts')};`,
].join('\n'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'demo.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
globalThis.window ??= { CRIBL_API_URL: 'http://x/api/v1', CRIBL_BASE_PATH: '' };
const { D, T, H, M, I, S } = await import(join(tmp, 'demo.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };
const NOW = Math.floor(Date.now() / 1000), MAX_GAP = S.DEFAULT_SETTINGS.learning.MAX_GAP;
const w1 = { from: NOW - 3600, to: NOW }, w24 = { from: NOW - 86400, to: NOW }, w48 = { from: NOW - 172800, to: NOW };

// Signatures, and no 24h assumptions inside the generators.
const src = readFileSync(join(root, 'src/lib/demo.ts'), 'utf8');
const between = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i + 1); return i < 0 ? '' : src.slice(i, j < 0 ? undefined : j); };
t('activity(win, span) signature', () => /export function activity\(win: Win, span: number\)/.test(src));
t('fleet(win, span) signature', () => /export function fleet\(win: Win, span: number\)/.test(src));
t('gaps(win, maxGap) signature', () => /export function gaps\(win: Win, maxGap: number\)/.test(src));
for (const [n, a, b] of [['activity', 'export function activity', 'export const entitySeries'], ['fleet', 'export function fleet', 'const GAPS'], ['gaps', 'const GAPS', '/** Key Advisor']])
  t(`${n}: no 86400, 288 or '-24h' literal`, () => { const s = between(a, b); return s.length > 0 && !/86400|-24h|\b288\b/.test(s); });

// 1h window: bins at sparkSpan / heartbeatSpan.
const sp1 = T.sparkSpan(w1), hb1 = T.heartbeatSpan(w1);
const lens1 = Object.values(D.activity(w1, sp1)).map((v) => v.length);
t('1h activity: ≤48 bins at sparkSpan, all series the same length', () => (lens1.length > 0 && lens1.every((n) => n === lens1[0] && n <= 48 && n === Math.ceil(3600 / sp1))) || lens1.slice(0, 3));
const fl1 = D.fleet(w1, hb1);
t('1h fleet: ≤300 bins at heartbeatSpan', () => (fl1.length <= 300 && fl1.length === Math.ceil(3600 / hb1) && fl1.every((r, i) => i === 0 || r.b - fl1[i - 1].b === hb1)) || [fl1.length, hb1]);
t('1h fleet: bins lie inside the window', () => fl1.every((r) => r.b >= w1.from - hb1 && r.b <= w1.to));
t('48h fleet: ≤300 bins', () => D.fleet(w48, T.heartbeatSpan(w48)).length <= 300);
t('24h activity has a different shape from 1h', () => Object.values(D.activity(w24, T.sparkSpan(w24)))[0].length * T.sparkSpan(w24) !== lens1[0] * sp1);

// Gaps: every gap ends inside the window; some fall in the previous period and the MAX_GAP padding.
for (const [name, w] of [['1h', w1], ['24h', w24]]) {
  const g = D.gaps(w, MAX_GAP), p = T.previous(w);
  t(`${name} gaps end at or before the window end`, () => g.every((r) => r.gap_end <= w.to && r.gap_end - r.gap_start === r.gap_s));
  t(`${name} gaps include silences in the current window`, () => g.some((r) => r.gap_end > w.from));
  t(`${name} gaps include silences in the previous period`, () => g.some((r) => r.gap_end > p.from && r.gap_start < p.to && r.gap_end <= p.to));
  t(`${name} gaps include one that began in the MAX_GAP padding`, () => g.some((r) => r.gap_start < p.from && r.gap_start >= p.from - MAX_GAP && r.gap_end > p.from));
}

// The demo fleet, built the way state.tsx builds it: a 24h demo has a defined incidents delta.
const L = S.DEFAULT_SETTINGS.learning, rows = D.entities();
const seen = rows.map((r) => ({ asset: String(r.asset), input: String(r.input) }));
const inventory = I.resolveInventory(D.inventory(), D.rules(), seen);
const fleet = M.applyClusters(rows.map((r) => M.toEntity(r, L)), inventory, D.clusters());
for (const [name, w] of [['24h', w24], ['1h', w1]]) {
  const ledger = H.toLedger(D.gaps(w, MAX_GAP)), p = T.previous(w);
  const cur = H.incidentsOf(fleet, ledger, w, NOW), prev = H.incidentsOf(fleet, ledger, p, NOW);
  t(`${name} demo: incidents in the previous period`, () => prev.length > 0 || prev.length);
  t(`${name} demo: incidents delta is defined`, () => T.delta(cur.length, prev.length, 'count') !== undefined || [cur.length, prev.length]);
  t(`${name} demo: availability delta is defined`, () => T.delta(H.fleetAvailability(fleet, ledger, w, NOW), H.fleetAvailability(fleet, ledger, p, NOW), 'ratio') !== undefined);
}
t('24h demo: current and previous incident counts differ (a visible delta)', () => {
  const ledger = H.toLedger(D.gaps(w24, MAX_GAP));
  return H.incidentsOf(fleet, ledger, w24, NOW).length !== H.incidentsOf(fleet, ledger, T.previous(w24), NOW).length;
});

// F3: the rollup setting defaults to 'auto' and normalizes anything invalid to 'auto'.
t('default rollup is auto', () => S.DEFAULT_SETTINGS.rollup === 'auto');
t('normalizeRollup keeps off and auto', () => S.normalizeRollup('off') === 'off' && S.normalizeRollup('auto') === 'auto');
t('normalizeRollup: missing/invalid -> auto', () => [undefined, null, '', 'OFF', 'on', 1, {}].every((v) => S.normalizeRollup(v) === 'auto'));
{
  const fetched = (body) => { globalThis.fetch = async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }); };
  for (const [name, body, want] of [['missing', {}, 'auto'], ['invalid', { rollup: 'bogus' }, 'auto'], ['off', { rollup: 'off' }, 'off']]) {
    fetched(body);
    let got; try { got = (await S.loadSettings()).rollup; } catch (e) { got = `threw ${e.message}`; }
    t(`loadSettings rollup ${name} -> ${want}`, () => got === want || got);
  }
}
if (fail) process.exit(1);
console.log('demo: ok');
