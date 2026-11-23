#!/usr/bin/env node
// Unit tests for src/lib/groups.ts (spec 013 Section 6, Section 9): the worker group detail page's Sources Drill.
// Pure functions, no React: bundled standalone with esbuild and run directly.
// Run: node scripts/test-groups.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules/.tmp-groups-bundle.mjs');
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/groups.ts'), '--bundle', '--platform=node', '--format=esm',
  '--log-level=error', `--outfile=${out}`], { stdio: 'inherit' });
const mod = await import(`${out}?t=${Date.now()}`);
const bySource = mod.bySource, rankSources = mod.rankSources;
rmSync(out, { force: true });

let fail = 0;
const ok = (name, cond) => { console.log((cond ? 'OK   ' : 'FAIL ') + name); if (!cond) fail++; };

function entity(group, input, asset, state) {
  return { group: group, input: input, asset: asset, state: state, key: group + '|' + input + '|' + asset };
}

const fleet = [
  entity('g', 'tcp:a', 'a1', 'missing'), entity('g', 'tcp:a', 'a2', 'ok'), entity('g', 'tcp:a', 'a3', 'ok'), entity('g', 'tcp:a', 'a4', 'ok'),
  entity('g', 'tcp:b', 'b1', 'missing'), entity('g', 'tcp:b', 'b2', 'missing'),
  entity('g', 'tcp:c', 'c1', 'ok'), entity('g', 'tcp:c', 'c2', 'ok'), entity('g', 'tcp:c', 'c3', 'late'),
  entity('h', 'tcp:a', 'z1', 'missing'),
];

{
  const rows = bySource(fleet.filter(function (x) { return x.group === 'g'; }));
  ok('bySource: 3 sources in group g', rows.length === 3);
  ok('bySource: each row only has its own assets', rows.every(function (r) {
    return r.list.every(function (x) { return x.input === r.input && x.group === r.group; });
  }));
}

{
  const ranked = rankSources(bySource(fleet.filter(function (x) { return x.group === 'g'; })));
  ok('rankSources: 3 rows', ranked.length === 3);
  ok('rankSources: worst (100%) first', ranked[0].input === 'tcp:b' && ranked[0].share === 1);
  ok('rankSources: middle (25%) second', ranked[1].input === 'tcp:a' && Math.abs(ranked[1].share - 0.25) < 1e-9);
  ok('rankSources: best (0%) last', ranked[2].input === 'tcp:c' && ranked[2].share === 0);
  ok('rankSources: strictly descending', ranked.every(function (r, i) { return i === 0 || ranked[i - 1].share >= r.share; }));
}

{
  const tied = [
    entity('g', 'tcp:y', 'y1', 'missing'), entity('g', 'tcp:y', 'y2', 'ok'),
    entity('g', 'tcp:x', 'x1', 'missing'), entity('g', 'tcp:x', 'x2', 'ok'),
  ];
  const ranked = rankSources(bySource(tied));
  ok('rankSources: equal share ties break alphabetically by source', ranked[0].input === 'tcp:x' && ranked[1].input === 'tcp:y');
}

{
  const ranked = rankSources([{ id: 'g|tcp:empty', group: 'g', input: 'tcp:empty', list: [] }]);
  ok('rankSources: empty source has share 0, not NaN', ranked[0].share === 0);
}

console.log(fail ? ('\ntest-groups: ' + fail + ' failed') : '\ntest-groups: OK');
process.exit(fail ? 1 : 0);
