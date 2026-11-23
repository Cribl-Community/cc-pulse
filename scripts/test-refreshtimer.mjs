// F7 (spec 025 §1): the refresh timer in state.tsx. Source-level checks (the provider needs a browser);
// the 'manual' / in-flight decision table itself is covered by test-refresh.mjs.
// Run: node scripts/test-refreshtimer.mjs   (also run by `npm test`)
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../src/state.tsx', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
let fails = 0;
const ok = (c, m) => { if (c) console.log(`✔ ${m}`); else { fails++; console.log(`✖ ${m}`); } };

ok(!/120_000|120000/.test(src), 'no 120_000 interval');
ok(/import\s*\{[^}]*\btickDecision\b[^}]*\}\s*from\s*['"]\.\/lib\/refresh['"]/.test(src) && /import\s*\{[^}]*\bonVisible\b[^}]*\}\s*from\s*['"]\.\/lib\/refresh['"]/.test(src), 'imports tickDecision and onVisible');
ok(/tickDecision\(\{[^}]*choice:\s*settings\.refresh[^}]*hidden:\s*document\.hidden[^}]*inFlight[^}]*lastAt[^}]*\}\)\s*===\s*'run'/.test(src), 'tick uses settings.refresh, document.hidden, in-flight and last refresh; runs only on run');
ok(/setInterval\([\s\S]*?,\s*CHECK_MS\)/.test(src) && /CHECK_MS\s*=\s*15_000/.test(src), '15 s check interval');
ok(/onVisible\(\{[^}]*settings\.refresh/.test(src), 'visibility handler calls onVisible');
ok(/addEventListener\('visibilitychange',\s*onVis\)/.test(src) && /removeEventListener\('visibilitychange',\s*onVis\)/.test(src) && /clearInterval\(t\)/.test(src), 'visibilitychange listener added and removed on cleanup');
ok(/liveBusy\s*=\s*useRef/.test(src) && /histBusy\s*=\s*useRef/.test(src), 'live and history in-flight refs exist');
ok(/liveBusy\.current\s*>\s*0\s*\|\|\s*histBusy\.current\s*>\s*0/.test(src), 'tick is skipped while either flag is set');
ok(/histBusy\.current\+\+/.test(src) && /histBusy\.current--/.test(src) && /liveBusy\.current\+\+/.test(src) && /liveBusy\.current--/.test(src), 'flags are counters, so overlapping runs never clear them early');
ok((src.match(/lastRefresh\.current\s*=\s*Date\.now\(\)/g) ?? []).length >= 3, 'last refresh set by live cycles, demo cycles and the demo initial load');
ok(/const refresh = useCallback\(async[^\n]*await run\(s, scopeRef\.current, true, true\)/.test(src), 'explicit refresh() still runs immediately (unguarded)');

if (fails) { console.log(`${fails} failed`); process.exit(1); }
