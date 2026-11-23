// F8 (spec 025 §3): state.tsx opens from the pulse_state snapshot with a live fallback.
// snapshotWins is tested as a table; the provider wiring is checked at source level (the provider needs a browser).
// Run: node scripts/test-snapshotstate.mjs   (also run by `npm test`)
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

let fails = 0;
const ok = (c, m) => { if (c) console.log(`✔ ${m}`); else { fails++; console.log(`✖ ${m}`); } };

// 1. snapshotWins: a snapshot older than the last live result never overwrites the entities.
const out = await build({ entryPoints: [new URL('../src/lib/snapshot.ts', import.meta.url).pathname], bundle: true, write: false, format: 'esm', platform: 'node' });
const N = await import('data:text/javascript;base64,' + Buffer.from(out.outputFiles[0].text).toString('base64'));
const asOf = 1_800_000_000;
ok(N.snapshotWins(undefined, asOf) === true, 'snapshotWins: no live result yet → snapshot used');
ok(N.snapshotWins(asOf * 1000 - 1, asOf) === true, 'snapshotWins: live result before asOf → snapshot used');
ok(N.snapshotWins(asOf * 1000, asOf) === true, 'snapshotWins: live result at asOf → snapshot used');
ok(N.snapshotWins(asOf * 1000 + 1, asOf) === false, 'snapshotWins: live result after asOf → entities kept');

// 2. Wiring in state.tsx.
const src = readFileSync(new URL('../src/state.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
ok(/import\s*\{[^}]*\bsnapshotQuery\b[^}]*\bsnapshotVerdict\b[^}]*\}\s*from\s*['"]\.\/lib\/snapshot['"]/.test(src), 'imports snapshotQuery and snapshotVerdict');
const par = /Promise\.all\(\[\s*runSearch\(snapshotQuery\(cad\), cad\.snapshotEarliest, 'now', 30_000, SNAPSHOT_CAP\)[\s\S]{0,80}?,\s*api[^(]*\(`\/m\/default_search\/search\/saved\/\$\{cad\.snapshotJob\}`\)/;
ok(par.test(src), 'snapshot read and saved-search GET start in parallel (Promise.all)');
ok(/snapshotVerdict\(\{[^}]*saved[^}]*dataset:\s*s\.dataset[^}]*rows[^}]*nowS/.test(src), 'verdict uses the configured dataset');
// The use branch returns before the entity job, and its setters sit inside the snapshotWins guard.
const useBranch = /if \(v\.use\) \{([\s\S]*?)return; \/\/ no entity job/.exec(src)?.[1] ?? '';
const guard = /if \(snapshotWins\(liveAt\.current, v\.asOf\)\) \{([\s\S]*?)\}/.exec(useBranch)?.[1] ?? '';
ok(useBranch !== '' && !/entityQuery/.test(useBranch), 'verdict use → returns with no entity job');
ok(/setEntities\(rows\)/.test(guard) && /setStateSource\('snapshot'\)/.test(guard) && /setStateAsOf\(v\.asOf\)/.test(guard) && /setUpdatedAt/.test(guard),
  'entities and stateSource/stateAsOf/updatedAt are set together, only when the snapshot is not older than live');
ok(!/setStateSource|setStateAsOf|setStateReason|setEntities|setUpdatedAt/.test(useBranch.replace(guard, '')), 'nothing is set outside the guard when the snapshot is older');
ok(/reason = v\.reason; age = snapshotAge\(rows, nowS\(\)\);[\s\S]*?setStateSource\('live'\)[\s\S]*?setStateReason\(reason\)[\s\S]*?setStateAge\(age\)/.test(src) && !/entityQuery/.test(src),
  'verdict not use → no entity query, stateReason = reason, stateAge = snapshot age');
ok(/const refresh = useCallback\(async[^\n]*await run\(s, scopeRef\.current, true, true\)\)?;/.test(src), 'refresh() reads the snapshot (run has no snapshot flag)');
ok(/await run\(s, scopeRef\.current, true, false\)/.test(src), 'open reads the snapshot');
ok(/const cycle = \(\) => void run\([^\n]*'now'\);/.test(src), 'every tick reads the snapshot');
ok(/if \(DEMO\) \{[\s\S]*?return;\s*\}/.test(src) && src.indexOf('if (DEMO)') < src.indexOf('snapshotQuery(cad)'), 'demo returns before any snapshot read');
ok(/stateSource: 'snapshot' \| 'live' \| 'stale'; stateAsOf\?: number; stateReason\?: SnapshotReason/.test(src), 'Ctx type has stateSource, stateAsOf, stateReason');
ok(/stateSource, stateAsOf, stateReason,/.test(src), 'usePulse() value exposes them');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
console.log('snapshotstate OK');
