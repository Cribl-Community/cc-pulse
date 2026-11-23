#!/usr/bin/env node
// Tests for the spec 013 §8 heartbeat restyle (src/components/vitals.tsx + App.css).
// Bundles vitals.tsx with esbuild, swapping React's hooks for a tiny cell runtime (scripts/fixtures/react-shim) and
// @capra/theme/visualizations for a spy (scripts/fixtures/chart-theme-spy.mjs), so FleetHeartbeat can be called as a
// function, receive a theme message through the real installThemeBridge, re-run, and unmount — no DOM needed.
// Run: node scripts/test-heartbeat.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'node_modules/.tmp-hb-entry.mjs');
const out = join(root, 'node_modules/.tmp-hb-bundle.mjs');
writeFileSync(entry, [
  "export * as vitals from '../src/components/vitals.tsx';",
  "export { calls } from '../scripts/fixtures/chart-theme-spy.mjs';",
].join('\n'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
  '--loader:.css=empty', '--log-level=error', '--define:window.CRIBL_API_URL="http://pulse.test/api/v1"', '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env={"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  '--alias:react=./scripts/fixtures/react-shim', '--resolve-extensions=.tsx,.ts,.jsx,.js,.mjs,.css,.json','--alias:@capra/theme/visualizations=./scripts/fixtures/chart-theme-spy.mjs',
  `--outfile=${out}`, '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'], { stdio: 'inherit', cwd: root });
let mod;
try { mod = await import(`${out}?t=${Date.now()}`); } finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }
const { vitals, calls } = mod;

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
function* walk(node) {
  if (Array.isArray(node)) { for (const n of node) yield* walk(n); return; }
  if (!node || typeof node !== 'object' || !('props' in node)) return;
  yield node;
  for (const v of Object.values(node.props ?? {})) yield* walk(v);
}
const byClass = (tree, c) => [...walk(tree)].filter((n) => n.props?.className === c);

// A fake host frame: window with a parent and message listeners, and a body whose class list the bridge toggles.
const listeners = new Set(), parent = {}, classes = new Set();
globalThis.window = { parent, addEventListener: (t, f) => t === 'message' && listeners.add(f), removeEventListener: (t, f) => t === 'message' && listeners.delete(f) };
globalThis.document = { body: { classList: { contains: (c) => classes.has(c), toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)) } } };
const post = (theme) => { for (const f of [...listeners]) f({ source: parent, data: { type: 'CRIBL_APP_LAYOUT', theme } }); };

const H = globalThis.__hooks;
const points = Array.from({ length: 12 }, (_, i) => ({ t: 1_700_000_000 + i * 300, events: 100 + (i % 3) * 20, assets: i === 6 || i === 7 ? 90 : 100 }));
const render = () => { H.i = 0; return vitals.FleetHeartbeat({ points }); };

// 1. First render: light mode, palette categorical.observable10, bridge subscribed.
let tree = render();
ok(calls.length >= 1 && calls.at(-1).palette === 'categorical.observable10', "getChartTheme called with palette 'categorical.observable10'");
ok(calls.at(-1).mode === 'light', 'initial mode is light (body has no .dark)');
ok(listeners.size === 1, 'FleetHeartbeat subscribes through installThemeBridge on mount');
const [ecg] = byClass(tree, 'ecg'), [fill] = byClass(tree, 'ecg-fill'), [now] = byClass(tree, 'ecg-now');
ok(ecg?.props.strokeWidth === 1.5, 'trace stroke width is 1.5');
ok(ecg?.props.stroke === '#light1', 'trace stroke is the first palette colour');
ok(fill?.props.fill === '#light1' && fill?.props.fillOpacity === 0.1, 'area fill is the same colour at 10 % opacity');
ok(ecg && !('pathLength' in ecg.props), 'trace has no draw-in pathLength');
ok(now?.props.fill === '#light1' && !now.props.style, "'now' dot is a static circle in the trace colour");
ok(byClass(tree, 'ecg-now-ring').length === 0, "no pulsing 'now' ring");
ok(byClass(tree, 'ecg-assets').length === 1 && !byClass(tree, 'ecg-assets')[0].props.stroke, "'assets reporting' stays a CSS-styled (dashed neutral) line");
ok(byClass(tree, 'ecg-drop').length >= 1, 'fewer-assets band is drawn');

// 2. A theme change through the bridge updates the mode passed to getChartTheme.
post('dark');
const before = calls.length;
tree = render();
ok(calls.length > before && calls.at(-1).mode === 'dark' && calls.at(-1).palette === 'categorical.observable10', 'bridge theme change → getChartTheme({ mode: "dark" })');
ok(byClass(tree, 'ecg')[0]?.props.stroke === '#dark01', 'trace recolours to the dark palette');
post('light'); tree = render();
ok(calls.at(-1).mode === 'light' && byClass(tree, 'ecg')[0]?.props.stroke === '#light1', 'and back to light');
const n = calls.length; render();
ok(calls.length === n, 'getChartTheme is memoised on mode (no call when mode is unchanged)');

// 3. Unmount unsubscribes.
for (const c of H.cleanups.splice(0)) c();
ok(listeners.size === 0, 'unmount removes the bridge listener');

// 4. Styles: no glow, no draw-in, no pings.
const css = readFileSync(join(root, 'src/App.css'), 'utf8');
ok(!/drop-shadow/.test(css), 'App.css has no drop-shadow');
ok(!/@keyframes\s+ping/.test(css), 'App.css has no @keyframes ping*');
ok(!/ecg-draw/.test(css), 'App.css has no ecg-draw');
const rule = (sel) => [...css.matchAll(new RegExp(`(^|[},\\s])${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`, 'gm'))].map((m) => m[2]).join(';');
ok(!/animation/.test(rule('.ecg-now')) && !/ecg-now-ring/.test(css), "'now' dot has no animation");
ok(!/\.tile[^{]*\{[^}]*animation/.test(css), 'tiles have no ping animation');
ok(!/animation/.test(rule('.ecg')) && !/animation/.test(rule('.ecg-fill')), 'trace and fill have no animation');
ok(/\.ecg-drop\s*\{[^}]*color\.background\.danger\.subtle/.test(css), 'fewer-assets bands use color.background.danger.subtle');
ok(/\.ecg-ann\s*\{[^}]*color\.foreground\.danger/.test(css), 'annotation text stays foreground.danger');
ok(/\.c-axis\s*\{[^}]*token\(/.test(css) && /\.c-grid\s*\{[^}]*token\(/.test(css), 'axes and gridlines keep token() CSS');
const src = readFileSync(join(root, 'src/components/vitals.tsx'), 'utf8');
ok(!/style=\{[^}]*animation/.test(src), 'vitals.tsx sets no inline animation');

if (fail) { console.error(`\n${fail} heartbeat check(s) failed`); process.exit(1); }
console.log('\nheartbeat: all checks passed');
