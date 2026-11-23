// Deploy / GroupDetail resets (src/lib/changed.ts, used by src/pages/Deploy.tsx and src/pages/Groups.tsx).
// The pages used to reset state in effects; they now reset during render via useChanged(). These probes copy each
// page's reset rule verbatim and check it fires under exactly the conditions the old effect did:
//   Deploy:  useEffect(() => setDsChoice(settings.dataset), [settings.dataset])
//            useEffect(() => { if (group) setPicked([]) }, [group])
//   Groups:  useEffect(() => { if (!all.length) return; setSeries(undefined); setErr(undefined) }, [group, all.length, span])
// Run: node scripts/test-resets.mjs   (bundles with the real React runtime via esbuild; no DOM needed)
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-resets-'));
const entry = [
  "export { useChanged, sameDeps } from './src/lib/changed';",
  "export { createElement, act, useState } from 'react';",
  "export { createRoot } from 'react-dom/client';",
].join('\n');
execFileSync(join(root, 'node_modules/.bin/esbuild'), ['--bundle', '--format=esm', '--platform=node', '--loader=ts', '--sourcefile=entry.ts',
  '--define:process.env.NODE_ENV="development"', `--outfile=${join(tmp, 'resets.mjs')}`], { cwd: root, input: entry, stdio: ['pipe', 'pipe', 'pipe'] });
const { useChanged, sameDeps, createElement, act, useState, createRoot } = await import(join(tmp, 'resets.mjs'));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.window ??= globalThis;
const noop = () => undefined;
const container = () => ({ nodeType: 1, nodeName: 'DIV', tagName: 'DIV', addEventListener: noop, removeEventListener: noop,
  ownerDocument: { addEventListener: noop, removeEventListener: noop,
    defaultView: { document: { activeElement: null, body: null }, HTMLIFrameElement: class {} } } });

let fail = 0;
const check = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

// ---- GroupDetail: series/err cleared when [group, all.length, span] change and all.length > 0 ----
{
  let g;
  function GroupProbe({ group, n, span }) {
    const [series, setSeries] = useState();
    const [err, setErr] = useState();
    const fetchChanged = useChanged([group, n, span], sameDeps);
    if (fetchChanged && n) { setSeries(undefined); setErr(undefined); }
    g = { series, err, setSeries, setErr };
    return null;
  }
  const root = createRoot(container());
  const show = (p) => act(() => root.render(createElement(GroupProbe, p)));
  const load = () => act(() => { g.setSeries({ k: [1] }); g.setErr('boom'); });
  const loaded = () => g.series !== undefined && g.err !== undefined;
  const cleared = () => g.series === undefined && g.err === undefined;

  await show({ group: 'a', n: 5, span: 600 }); await load();
  check(loaded(), 'groups: fetched data is shown');
  await show({ group: 'a', n: 5, span: 600 });
  check(loaded(), 'groups: re-render with the same inputs keeps the data');
  await show({ group: 'a', n: 5, span: 300 });
  check(cleared(), 'groups: span change clears series and err');
  await load(); await show({ group: 'a', n: 6, span: 300 });
  check(cleared(), 'groups: asset count change clears');
  await load(); await show({ group: 'b', n: 6, span: 300 });
  check(cleared(), 'groups: group change clears');
  await load(); await show({ group: 'b', n: 0, span: 300 });
  check(loaded(), 'groups: count dropping to 0 does not clear (old effect returned early)');
  await show({ group: 'b', n: 6, span: 300 });
  check(cleared(), 'groups: 6 → 0 → 6 clears again on the way back (old effect re-ran on 0 → 6)');
  await load(); await show({ group: 'b', n: 0, span: 600 }); await show({ group: 'b', n: 0, span: 300 });
  check(loaded(), 'groups: span change while empty does not clear');
  await show({ group: 'b', n: 6, span: 300 });
  check(cleared(), 'groups: becoming non-empty after empty span changes clears');
  await act(() => root.unmount());
}

// ---- Deploy: dsChoice follows settings.dataset; picked clears when a (truthy) group is chosen ----
{
  let d;
  function DeployProbe({ dataset, group }) {
    const [dsChoice, setDsChoice] = useState(dataset);
    const [picked, setPicked] = useState([]);
    const datasetChanged = useChanged(dataset);
    if (datasetChanged) setDsChoice(dataset);
    const groupChanged = useChanged(group);
    if (groupChanged && group) setPicked([]);
    d = { dsChoice, setDsChoice, picked, setPicked };
    return null;
  }
  const root = createRoot(container());
  const show = (p) => act(() => root.render(createElement(DeployProbe, p)));
  const pick = () => act(() => d.setPicked(['tcp:in_a']));

  await show({ dataset: 'pulse_metrics', group: undefined });
  check(d.dsChoice === 'pulse_metrics' && d.picked.length === 0, 'deploy: starts on the saved dataset, nothing ticked');
  await act(() => d.setDsChoice('__new__')); await show({ dataset: 'pulse_metrics', group: undefined });
  check(d.dsChoice === '__new__', 'deploy: the user\'s dataset choice survives re-renders');
  await show({ dataset: 'pulse_prod', group: undefined });
  check(d.dsChoice === 'pulse_prod', 'deploy: saved dataset change resets the dataset choice');
  await pick(); await show({ dataset: 'pulse_prod', group: 'a' });
  check(d.picked.length === 0, 'deploy: first group selection (undefined → a) clears ticks');
  await pick(); await show({ dataset: 'pulse_prod', group: 'a' });
  check(d.picked.length === 1, 'deploy: same group keeps ticks');
  await show({ dataset: 'pulse_other', group: 'a' });
  check(d.picked.length === 1 && d.dsChoice === 'pulse_other', 'deploy: dataset change does not touch ticks');
  await show({ dataset: 'pulse_other', group: 'b' });
  check(d.picked.length === 0, 'deploy: group change clears ticks');
  await act(() => d.setDsChoice('pulse_x')); await pick(); await show({ dataset: 'pulse_other', group: undefined });
  check(d.picked.length === 1 && d.dsChoice === 'pulse_x', 'deploy: group → undefined keeps ticks (old effect skipped falsy group)');
  await show({ dataset: 'pulse_other', group: 'b' });
  check(d.picked.length === 0, 'deploy: undefined → b (back to the earlier group) clears ticks');
  await act(() => root.unmount());
}

// ---- Groups.tsx keeps both named exports ----
const groupsSrc = readFileSync(join(root, 'src/pages/Groups.tsx'), 'utf8');
check(/export function Groups\(/.test(groupsSrc) && /export function GroupDetail\(/.test(groupsSrc), 'Groups.tsx exports Groups and GroupDetail');

if (fail) { console.error(`\ntest-resets: ${fail} failed`); process.exit(1); }
console.log('\ntest-resets: OK');
process.exit(0);   // React's scheduler keeps a MessageChannel open
