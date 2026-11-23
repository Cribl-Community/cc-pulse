// Unit tests for src/lib/timescope.ts (spec 014 §1, feature F1).
// Bundles timescope.ts with esbuild into a temp file and checks it against fixed instants.
// Runs itself under TZ=Asia/Kolkata (UTC+5:30) so "local" and "utc" snapping differ in a known way.
// Run: node scripts/test-timescope.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
if (process.env.TZ !== 'Asia/Kolkata') {
  try { execFileSync(process.execPath, [fileURLToPath(import.meta.url)], { stdio: 'inherit', env: { ...process.env, TZ: 'Asia/Kolkata' } }); process.exit(0); }
  catch { process.exit(1); }
}

const src = readFileSync(join(root, 'src/lib/timescope.ts'), 'utf8');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ts-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/timescope.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'timescope.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const T = await import(join(tmp, 'timescope.mjs'));

let fail = 0, n = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t = (msg, fn) => { n++; let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const NOW = 1762698034; // 2025-11-09 14:20:34 UTC = 2025-11-09 19:50:34 IST
const H = 3600, D = 86400, IST = 19800;
const S = (earliest, latest = 'now', tz = 'utc') => ({ earliest, latest, tz });

// purity
t('no imports at all (no React, no fetch, no IO)', () => !/^\s*import\b/m.test(src) && !/\brequire\(/.test(src));
t('no fetch / storage / react', () => !/\bfetch\(|localStorage|sessionStorage|from 'react'/.test(src));

// constants
t('MAX_SPAN_S', () => T.MAX_SPAN_S === 172800);
t('DEFAULT_SCOPE', () => same(T.DEFAULT_SCOPE, { earliest: '-24h', latest: 'now', tz: 'local' }));
t('QUICK', () => same([...T.QUICK], ['1h', '6h', '24h', '48h']));
t('quickScope keeps tz', () => same(T.quickScope('6h', 'utc'), { earliest: '-6h', latest: 'now', tz: 'utc' }) && T.quickScope('48h', 'local').tz === 'local');

// resolve
t('resolve now', () => T.resolve(S('-1h'), NOW).to === NOW);
t('resolve -6h', () => same(T.resolve(S('-6h'), NOW), { from: NOW - 6 * H, to: NOW }));
t('resolve -90m', () => T.resolve(S('-90m'), NOW).from === NOW - 5400);
t('resolve -2d', () => T.resolve(S('-2d'), NOW).from === NOW - 2 * D);
t('resolve -1h@h (utc)', () => T.resolve(S('-1h@h'), NOW).from === Math.floor((NOW - H) / H) * H);
t('resolve -1h@h (local, IST half-hour offset)', () => T.resolve(S('-1h@h', 'now', 'local'), NOW).from === Math.floor((NOW - H + IST) / H) * H - IST);
t('resolve -5m@m', () => T.resolve(S('-5m@m'), NOW).from === Math.floor((NOW - 300) / 60) * 60);
t('resolve @d in utc', () => T.resolve(S('@d'), NOW).from === Math.floor(NOW / D) * D);
t('resolve @d in local', () => T.resolve(S('@d', 'now', 'local'), NOW).from === Math.floor((NOW + IST) / D) * D - IST);
t('resolve -1d@d in utc vs local differ', () => T.resolve(S('-1d@d'), NOW).from === Math.floor((NOW - D) / D) * D
  && T.resolve(S('-1d@d', 'now', 'local'), NOW).from === Math.floor((NOW - D + IST) / D) * D - IST);
t('resolve absolute epochs', () => same(T.resolve(S('1762600000', '1762610000'), NOW), { from: 1762600000, to: 1762610000 }));
t('resolve garbage → undefined', () => T.resolve(S('yesterday'), NOW) === undefined && T.resolve(S('-6x'), NOW) === undefined && T.resolve(S(''), NOW) === undefined);

// validate
t('validate ok for -48h', () => T.validate(S('-48h'), NOW) === undefined);
t('validate ok for default', () => T.validate(T.DEFAULT_SCOPE, NOW) === undefined);
t('validate 48 h cap', () => T.validate(S('-49h'), NOW) === 'Ranges are limited to 48 hours' && T.validate(S(String(NOW - 172801), String(NOW)), NOW) === 'Ranges are limited to 48 hours');
t('validate exactly 172800 ok', () => T.validate(S(String(NOW - 172800), String(NOW)), NOW) === undefined);
t('validate from ≥ to', () => T.validate(S('-1h', '-2h'), NOW) === 'Start must be before end' && T.validate(S('-1h', '-1h'), NOW) === 'Start must be before end');
t('validate no future end', () => { const r = T.validate(S('-1h', String(NOW + 61)), NOW); return typeof r === 'string' && /future/i.test(r); });
t('validate allows 60 s of skew', () => T.validate(S('-1h', String(NOW + 60)), NOW) === undefined);
t('validate garbage', () => typeof T.validate(S('yesterday'), NOW) === 'string');

// previous
t('previous', () => same(T.previous({ from: 100, to: 160 }), { from: 40, to: 100 }));

// spans
const rows = [[H, 60, 120], [6 * H, 120, 600], [24 * H, 300, 1800], [48 * H, 600, 3600]];
t('heartbeatSpan 1h/6h/24h/48h', () => rows.every(([s, hb]) => T.heartbeatSpan(s) === hb && T.heartbeatSpan({ from: NOW - s, to: NOW }) === hb));
t('sparkSpan 1h/6h/24h/48h', () => rows.every(([s, , sp]) => T.sparkSpan(s) === sp && T.sparkSpan({ from: NOW - s, to: NOW }) === sp));

// labels
t("rangeLabel 'Last 1 hour'", () => T.rangeLabel(S('-1h'), NOW) === 'Last 1 hour');
t("rangeLabel 'Last 6 hours'", () => T.rangeLabel(S('-6h'), NOW) === 'Last 6 hours');
t("rangeLabel 'Last 90 minutes'", () => T.rangeLabel(S('-90m'), NOW) === 'Last 90 minutes');
t("rangeLabel 'Last 1 day' / 'Last 2 days'", () => T.rangeLabel(S('-1d'), NOW) === 'Last 1 day' && T.rangeLabel(S('-2d'), NOW) === 'Last 2 days');
t('rangeLabel absolute in utc', () => T.rangeLabel(S('1762600000', '1762610000'), NOW) === '2025-11-08 11:06:40 - 2025-11-08 13:53:20');
t('rangeLabel absolute in local (IST)', () => T.rangeLabel(S('1762600000', '1762610000', 'local'), NOW) === '2025-11-08 16:36:40 - 2025-11-08 19:23:20');
t('rangeLabel snapped range uses absolute format', () => /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d - \d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(T.rangeLabel(S('-1h@h'), NOW)));

// timefmt (F8): the one formatter module
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/timefmt.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'timefmt.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const F = await import(join(tmp, 'timefmt.mjs'));
t('formatClock utc vs local (IST)', () => /^11:06/.test(F.formatClock(1762600000, 'utc')) && /^(16|0?4):36/.test(F.formatClock(1762600000, 'local')));
t('formatClock 0 → dash', () => F.formatClock(0, 'utc') === '—');
t('formatHour utc vs local', () => F.formatHour(1762600000, 'utc') !== F.formatHour(1762600000, 'local'));
t('formatDay crosses midnight in IST', () => F.formatDay(1762640000, 'utc') !== F.formatDay(1762640000, 'local') && /November/.test(F.formatDay(1762640000, 'utc')));
t('formatTs is the one rangeLabel uses', () => F.formatTs(1762600000, 'utc') === '2025-11-08 11:06:40' && F.formatTs(1762600000, 'local') === '2025-11-08 16:36:40');

// delta
t('delta count +20% up bad', () => same(T.delta(12, 10, 'count'), { text: '+20%', dir: 'up', good: false }));
t('delta count -20% down good', () => same(T.delta(8, 10, 'count'), { text: '-20%', dir: 'down', good: true }));
t('delta count flat good', () => { const r = T.delta(10, 10, 'count'); return r.dir === 'flat' && r.good === true && r.text === '0%'; });
t('delta count vs 0 / undefined', () => T.delta(5, 0, 'count') === undefined && T.delta(0, 0, 'count') === undefined && T.delta(5, undefined, 'count') === undefined && T.delta(0.9, undefined, 'ratio') === undefined);
t('delta ratio +0.5 pp good', () => same(T.delta(0.995, 0.99, 'ratio'), { text: '+0.5 pp', dir: 'up', good: true }));
t('delta ratio -0.5 pp bad', () => same(T.delta(0.99, 0.995, 'ratio'), { text: '-0.5 pp', dir: 'down', good: false }));
t('delta ratio flat good', () => { const r = T.delta(0.99, 0.99, 'ratio'); return r.dir === 'flat' && r.good === true; });
t('delta ratio against 0 is fine', () => T.delta(0.5, 0, 'ratio')?.text === '+50.0 pp');

// URL params
const P = (q) => T.fromParams(new URLSearchParams(q), NOW);
t('fromParams reads all three', () => same(P('earliest=-6h&latest=now&tz=utc'), { earliest: '-6h', latest: 'now', tz: 'utc' }));
t('fromParams missing tz → local', () => P('earliest=-6h&latest=now')?.tz === 'local');
t('fromParams missing bound → undefined', () => P('latest=now') === undefined && P('earliest=-6h') === undefined && P('') === undefined);
t('fromParams invalid → undefined', () => P('earliest=yesterday&latest=now') === undefined && P('earliest=-6h&latest=now&tz=mars') === undefined);
t('fromParams over 48 h → undefined', () => P('earliest=-7d&latest=now&tz=local') === undefined && P('earliest=-49h&latest=now') === undefined);
t('toParams', () => T.toParams(S('-6h')).toString() === 'earliest=-6h&latest=now&tz=utc');
t('round-trip', () => [S('-6h'), S('-30m', 'now', 'local'), S('1762600000', '1762610000'), S('-1h@h', 'now', 'local'), T.DEFAULT_SCOPE]
  .every((s) => same(T.fromParams(new URLSearchParams(T.toParams(s).toString()), NOW), s)));

// F11: AskBar inherits the page range
{
  const aiSrc = readFileSync(join(root, 'src/lib/ai.ts'), 'utf8');
  t('ai.ts: no "earliest":"-24h" literal', () => !aiSrc.includes('"earliest":"-24h"'));
  try {
    execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/ai.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'ai.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
    globalThis.window ??= { CRIBL_API_URL: 'http://x/api/v1', CRIBL_BASE_PATH: '' };
    const A = await import(join(tmp, 'ai.mjs'));
    const scope = { earliest: '-6h', latest: '-1h', tz: 'utc' };
    const calls = [];
    const search = async (k, e, l) => { calls.push([k, e, l]); return []; };
    await A.runQueryAction({ kql: 'q' }, scope, search);
    await A.runQueryAction({ kql: 'q', earliest: '-7d' }, scope, search);
    t('query without earliest uses scope earliest/latest', () => calls[0].join() === 'q,-6h,-1h');
    t('query with own earliest overrides, latest defaults to now', () => calls[1].join() === 'q,-7d,now');
    const p = A.systemPrompt({ dataset: 'd' }, 'ctx', { label: 'Last 6 hours', earliest: '-6h', latest: '-1h' });
    t('prompt includes the current range', () => p.includes('Last 6 hours') && p.includes('earliest=-6h') && p.includes('latest=-1h'));
  } catch (e) { t('ai.ts bundle/run: ' + e.message, () => false); }
}

t('rangePhrase: relative range gives "last N unit"', () => T.rangePhrase(S('-6h')) === 'last 6 h' && T.rangePhrase(S('-30m')) === 'last 30 m');
t('rangePhrase: absolute or non-now range gives "in range"', () => T.rangePhrase(S('1762600000', '1762650000')) === 'in range' && T.rangePhrase(S('-6h', '-1h')) === 'in range');
t('withRange joins label and phrase', () => T.withRange('Incidents', S('-6h')) === 'Incidents, last 6 h' && T.withRange('Available', S('1', '2')) === 'Available in range');

console.log(fail ? `timescope:${fail}/${n} failure(s)` : `timescope OK (${n} checks)`);
process.exit(fail ? 1 : 0);
