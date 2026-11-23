// F4: the history jobs in state.tsx follow the TimeScope window (source-level checks; the provider needs a browser).
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../src/state.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let bad = 0;
const ok = (c, m) => { if (!c) { bad++; console.log('✘ ' + m); } };
ok(!/-24h/.test(src), "no '-24h' literal");
// Live runSearch calls + one `job` helper called for each of the 3 history jobs ≤ 5 per refresh.
// Spec 025: the source job is gone (sourcesOf(entities)) and a snapshot read is added, so ≤ 3 call sites.
ok((src.match(/\brunSearch\(/g) ?? []).length <= 3 && (src.match(/^\s+job\(/gm) ?? []).length === 3, '≤ 5 searches per refresh');
ok(/sourcesOf\(\s*entities\s*\)/.test(src) && /computeEntities\(/.test(src) && !/entityQuery/.test(src),
  'sources derived from entities; the entity compute lives in lib/computeNow.ts (learning.LOOKBACK)');
ok(/previous\(w\)\.from - s\.learning\.MAX_GAP/.test(src), 'gaps earliest = previous.from - MAX_GAP');
ok(/20_000 \* Math\.ceil\(\(w\.to - gFrom\) \/ 86400\)/.test(src), 'gaps limit = 20000 x ceil(span/86400)');
ok(/sparkSpan\(w\)/.test(src) && /heartbeatSpan\(w\)/.test(src), 'spans come from the window');
ok(/scopeRef\.current\.latest === 'now'/.test(src) || /histDue\(/.test(src), 'timer re-runs history only when latest is now (inline, or via histDue per spec 025)');
ok(/r\.length >= lim/.test(src), 'truncated flag when rows hit the limit');
ok(!/export const ACT_(SPAN|BINS)/.test(src), 'ACT_SPAN/ACT_BINS are not constants');
if (bad) process.exit(1);
console.log('statehistory OK');
