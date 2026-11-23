// Unit tests for src/lib/scopeLoad.ts (spec 014 §6, feature F3): URL → KV → default load order, URL writes, KV persistence.
// Run: node scripts/test-scopeload.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-sl-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/scopeLoad.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'scopeLoad.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const L = await import(join(tmp, 'scopeLoad.mjs'));

let fail = 0, n = 0;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const t = async (msg, fn) => { n++; let r; try { r = await fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const NOW = 1762698034;
const DEF = { earliest: '-24h', latest: 'now', tz: 'local' };
const KV6 = { earliest: '-6h', latest: 'now', tz: 'utc' };
const R = (search, kv) => L.resolveInitialScope(search, kv, NOW);

await t('key is ui/timescope', () => L.SCOPE_KEY === 'ui/timescope');
await t('valid URL wins over KV, no toast', () => { const r = R('?earliest=-1h&latest=now&tz=utc', KV6); return r.source === 'url' && same(r.scope, { earliest: '-1h', latest: 'now', tz: 'utc' }) && r.toast === undefined; });
await t('URL absolute epoch range is used', () => { const r = R(`?earliest=${NOW - 7200}&latest=${NOW - 3600}&tz=local`, undefined); return r.source === 'url' && r.scope.earliest === String(NOW - 7200); });
await t('invalid URL → KV, with toast naming the KV range', () => { const r = R('?earliest=banana&latest=now', KV6); return r.source === 'kv' && same(r.scope, KV6) && r.toast === "The link's time range isn't supported (max 48 h) — showing Last 6 hours"; });
await t('invalid URL tz → falls back with toast', () => { const r = R('?earliest=-1h&latest=now&tz=mars', undefined); return r.source === 'default' && typeof r.toast === 'string'; });
await t('URL with only one bound → falls back with toast', () => { const r = R('?earliest=-1h', undefined); return r.source === 'default' && /isn't supported/.test(r.toast ?? ''); });
await t('over-48h URL → default, flagged toast', () => { const r = R('?earliest=-7d&latest=now', undefined); return r.source === 'default' && same(r.scope, DEF) && r.toast === "The link's time range isn't supported (max 48 h) — showing Last 24 hours"; });
await t('49h URL → KV, flagged toast', () => { const r = R('?earliest=-49h&latest=now&tz=utc', KV6); return r.source === 'kv' && same(r.scope, KV6) && !!r.toast; });
await t('48h URL is fine', () => R('?earliest=-48h&latest=now', undefined).source === 'url');
await t('no URL params → KV, no toast', () => { const r = R('?asset=web-1', KV6); return r.source === 'kv' && same(r.scope, KV6) && r.toast === undefined; });
await t('missing KV entry (undefined) → default, no toast', () => { const r = R('', undefined); return r.source === 'default' && same(r.scope, DEF) && r.toast === undefined; });
await t('missing KV entry (null / empty string) → default', () => R('', null).source === 'default' && R('', '').source === 'default');
await t('malformed KV → default', () => R('', { earliest: 5 }).source === 'default' && R('', 'garbage').source === 'default');
await t('KV over 48h → default', () => R('', { earliest: '-3d', latest: 'now', tz: 'utc' }).source === 'default');
await t('KV without tz defaults to local', () => same(R('', { earliest: '-6h', latest: 'now' }).scope, { earliest: '-6h', latest: 'now', tz: 'local' }));
await t('resolveInitialScope is deterministic (pure)', () => same(R('?earliest=-7d&latest=now', KV6), R('?earliest=-7d&latest=now', KV6)));

await t('scopeSearch sets the params and keeps others', () => { const p = new URLSearchParams(L.scopeSearch('?asset=web-1&earliest=-1h', KV6)); return p.get('asset') === 'web-1' && p.get('earliest') === '-6h' && p.get('latest') === 'now' && p.get('tz') === 'utc'; });
await t('scopeSearch writes absolute bounds as whole epoch seconds', () => { const p = new URLSearchParams(L.scopeSearch('', { earliest: '1762600000', latest: '1762603600', tz: 'local' })); return p.get('earliest') === '1762600000' && p.get('latest') === '1762603600' && L.resolveInitialScope(`?${p}`, undefined, NOW).source === 'url'; });
await t('scopeSearch round-trips through the load order', () => same(R(L.scopeSearch('', KV6), undefined).scope, KV6));

let unhandled = 0;
process.on('unhandledRejection', () => { unhandled++; });
await t('persistScope writes ui/timescope synchronously and returns without awaiting', () => {
  const calls = []; let resolved = false;
  const put = (k, v) => { calls.push([k, v]); return new Promise((res) => setTimeout(() => { resolved = true; res(); }, 20)); };
  const ret = L.persistScope(KV6, put);
  return ret === undefined && !resolved && same(calls, [['ui/timescope', KV6]]);
});
await t('a rejected KV write does not throw', () => { L.persistScope(KV6, () => Promise.reject(new Error('KV write failed (500)'))); return true; });
await new Promise((r) => setTimeout(r, 50));
await t('a rejected KV write leaves no unhandled rejection', () => unhandled === 0 || `${unhandled} unhandled`);

console.log(fail ? `test-scopeload: ${fail}/${n} FAILED` : `test-scopeload: ${n} checks OK`);
process.exit(fail ? 1 : 0);
