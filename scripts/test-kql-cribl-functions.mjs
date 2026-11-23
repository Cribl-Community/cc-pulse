#!/usr/bin/env node
// Every saved-search query Pulse writes uses only what Cribl Search runs (probed on the org 2026-11-22):
//  - no array_* functions, strcat_array or pack_array: "Unknown Kusto scalar function 'array_sort_asc'" (the roll call);
//  - next() never sees an empty stream: it fails the job ("Cannot set properties of undefined (setting
//    '__windowHeadFlush_…')"), so every query that calls next() unions the padding row first (routes.ts runSummary).
// The org check itself: node scripts/probe-saved-queries.mjs (runs each query over the last minute).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-kqlfn-'));
let fail = 0;
const t = (msg, ok) => { if (!ok) { fail++; console.log(`FAIL ${msg}`); } };
try {
  const esbuild = await import('esbuild');
  const load = async (src, tag) => {
    const out = join(tmp, `${tag}.mjs`);
    await esbuild.build({ entryPoints: [join(root, src)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent',
      define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false' } });
    return import(out);
  };
  const K = await load('src/lib/kql.ts', 'kql'), R = await load('src/lib/routes.ts', 'routes'), St = await load('src/lib/settings.ts', 'settings');
  const B = St.DEFAULT_SETTINGS;
  const queries = [];
  for (const searchLoad of ['standard', 'hourly', 'daily'])
    for (const rollup of ['auto', 'off'])
      for (const d of K.savedSearches({ ...B, searchLoad, rollup, rollCall: { hour: 6, tz: 'UTC', allClear: false } }))
        queries.push([`${searchLoad}/${rollup} ${d.id}`, d.query]);
  for (const kind of ['missing', 'source_down', 'digest']) for (const again of [false, true]) queries.push([`runSummary ${kind}${again ? ' again' : ''}`, R.runSummary(kind, again)]);
  t('collected the saved searches of every load', queries.length > 40);
  for (const [name, q] of queries) {
    t(`${name}: no array_* / strcat_array / pack_array (Cribl has none)`, !/\barray_[a-z_]+\s*\(|\bstrcat_array\s*\(|\bpack_array\s*\(/.test(q));
    if (/\bnext\s*\(/.test(q)) {
      const pad = q.indexOf('union (print __pad = 1'), first = q.search(/\bnext\s*\(/);
      t(`${name}: next() only after the padding row`, pad >= 0 && pad < first);
      t(`${name}: the padding row is dropped`, /\| where __pad == 0\n\| project-away __pad/.test(q));
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
console.log(fail ? `\n${fail} failed` : 'kql-cribl-functions ok');
process.exit(fail ? 1 : 0);
