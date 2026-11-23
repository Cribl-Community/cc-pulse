// Thresholds editor (src/lib/liveRule.ts, used by src/pages/Thresholds.tsx): the editable rule resets whenever the live
// K / MIN_GAP / MAX_GAP change, and `dirty` is true only while the edited rule differs from the live one.
// Run: node scripts/test-thresholds.mjs   (bundles the hook with the real React runtime via esbuild; no DOM needed:
// the probe component renders null, so react-dom only attaches event listeners to the fake container)
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rule-'));
const entry = [
  "export { useLiveRule } from './src/lib/liveRule';",
  "export { createElement, act } from 'react';",
  "export { createRoot } from 'react-dom/client';",
].join('\n');
execFileSync(join(root, 'node_modules/.bin/esbuild'), ['--bundle', '--format=esm', '--platform=node', '--loader=ts', '--sourcefile=entry.ts',
  '--define:process.env.NODE_ENV="development"', `--outfile=${join(tmp, 'rule.mjs')}`], { cwd: root, input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
const { useLiveRule, createElement, act, createRoot } = await import(join(tmp, 'rule.mjs'));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window ??= globalThis;   // react-dom reads window.event to pick an update priority
const noop = () => undefined;
const container = { nodeType: 1, nodeName: 'DIV', tagName: 'DIV', addEventListener: noop, removeEventListener: noop,
  ownerDocument: { addEventListener: noop, removeEventListener: noop,
    defaultView: { document: { activeElement: null, body: null }, HTMLIFrameElement: class {} } } };
const reactRoot = createRoot(container);

let last;            // hook result of the latest render
let shown = [];      // rule of every render since the last show()
function Probe({ live }) { last = useLiveRule(live); shown.push(last.rule); return null; }
const show = async (live) => { shown = []; await act(() => reactRoot.render(createElement(Probe, { live }))); };
const edit = (patch) => act(() => last.setRule({ ...last.rule, ...patch }));

let fail = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const eq = (a, b) => a.K === b.K && a.MIN_GAP === b.MIN_GAP && a.MAX_GAP === b.MAX_GAP;

let live = { K: 3, MIN_GAP: 300, MAX_GAP: 7200 };
await show(live);
check(eq(last.rule, live) && !last.dirty, 'starts at the live rule, not dirty');

await edit({ K: 5 });
check(last.rule.K === 5 && last.dirty, 'editing K makes it dirty');
await show({ ...live });
check(last.rule.K === 5 && last.dirty, 'a re-render with equal live values (new object) keeps the edit');
await edit({ K: 3 });
check(eq(last.rule, live) && !last.dirty, 'editing back to the live values is not dirty');
await edit({ MIN_GAP: 600 });
check(last.dirty, 'editing MIN_GAP makes it dirty');
await edit({ MIN_GAP: 300, MAX_GAP: 3600 });
check(last.dirty, 'editing MAX_GAP makes it dirty');
await act(() => last.setRule(live));
check(eq(last.rule, live) && !last.dirty, '"Reset to live" (setRule(live)) clears dirty');

for (const [field, value] of [['K', 4], ['MIN_GAP', 600], ['MAX_GAP', 14400]]) {
  await edit({ K: last.rule.K + 0.5, MIN_GAP: last.rule.MIN_GAP + 60, MAX_GAP: last.rule.MAX_GAP + 900 });
  check(last.dirty, `edited (all three fields) before live ${field} changes`);
  live = { ...live, [field]: value };
  await show(live);
  check(eq(last.rule, live) && !last.dirty, `live ${field} change resets the editor to the live rule`);
  check(eq(shown.at(-1), live), `live ${field} change: the committed render shows the live rule`);
  await show({ ...live });
  check(eq(last.rule, live) && !last.dirty, `live ${field} change: stays reset on the next render`);
}

// Saving: Thresholds.apply() makes the edited rule the live one, so the editor ends equal to live and not dirty.
await edit({ K: 7 });
live = { ...last.rule };
await show(live);
check(eq(last.rule, live) && !last.dirty, 'saving the edited rule (live := rule) leaves it not dirty');

await act(() => reactRoot.unmount());
if (fail) { console.error(`\ntest-thresholds: ${fail} failed`); process.exit(1); }
console.log('\ntest-thresholds: OK');
process.exit(0);   // React's scheduler keeps a MessageChannel open
