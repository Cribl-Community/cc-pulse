#!/usr/bin/env node
// Tests for src/lib/routeFilter.ts: transpile with the installed typescript package (no bundler needed,
// the module has no imports) and exercise routeFilterFor, defaultSourceMode, OBSERVER_US_PER_EVENT.
import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/lib/routeFilter.ts'), 'utf8');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok(!/^\s*import\b/m.test(src), 'routeFilter.ts has no import statements');

const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ES2020, target: ts.ScriptTarget.ES2020 } }).outputText;
const tmp = join(root, 'node_modules/.tmp-route-filter.mjs');
writeFileSync(tmp, js);
const stamp = Date.now();
const rf = await import(`${tmp}?t=${stamp}`);
unlinkSync(tmp);

// exact match
const f1 = rf.routeFilterFor(['tcp:in_a'], 'FALLBACK');
const test1 = (id) => new Function('__inputId', `return (${f1});`)(id);
ok(test1('tcp:in_a'), 'routeFilterFor matches exact id');
ok(test1('tcp:in_a:x'), 'routeFilterFor matches id with ":" suffix');
ok(!test1('tcp:in_ab'), 'routeFilterFor rejects bare prefix (tcp:in_ab against tcp:in_a)');
ok(!/\[/.test(f1), 'no array literal in output');
ok(!/=>/.test(f1), 'no arrow function in output');

// quote and backslash safety
const trickyId = "weird'id\\with\\stuff";
const f2 = rf.routeFilterFor([trickyId], 'FALLBACK');
const test2 = (id) => new Function('__inputId', `return (${f2});`)(id);
ok(test2(trickyId), 'quote/backslash id matches itself');
ok(test2(trickyId + ':sub'), 'quote/backslash id matches itself with ":" suffix');
ok(!test2('somethingelse'), 'quote/backslash id does not match an unrelated id');

// empty-list fallback
ok(rf.routeFilterFor([], 'FALLBACK') === 'FALLBACK', 'empty inputs list returns the fallback');

// defaultSourceMode
ok(rf.defaultSourceMode(undefined) === 'selected', 'defaultSourceMode(undefined) === selected');
ok(rf.defaultSourceMode({ inputs: [] }) === 'all', 'defaultSourceMode({inputs:[]}) === all');
ok(rf.defaultSourceMode({ inputs: ['a'] }) === 'selected', "defaultSourceMode({inputs:['a']}) === selected");

// constant
ok(rf.OBSERVER_US_PER_EVENT === 2.5, 'OBSERVER_US_PER_EVENT === 2.5');

console.log(fail ? `${fail} failure(s)` : 'routeFilter tests OK');
process.exit(fail ? 1 : 0);
