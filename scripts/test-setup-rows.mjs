// Spec 039 F2: setupRows row model. Run: node scripts/test-setup-rows.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rows-'));
const bundle = (entry, name) => {
  const out = join(tmp, `${name}.mjs`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
    '--define:import.meta.env.DEV=true', `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
  return out;
};
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };
globalThis.window = { CRIBL_BASE_PATH: '' };
window.parent = window;

const srcText = readFileSync(join(root, 'src/lib/setupRows.ts'), 'utf8');
ok(!/from ['"]react|document\.|window\./.test(srcText), 'setupRows.ts imports no React or DOM');

const R = await import(bundle('src/lib/setupRows.ts', 'rows'));
const { setupFleet } = await import(bundle('src/lib/demo.ts', 'demo'));
const fleet = setupFleet();
const c = R.defaultChoices(fleet);
const rows = Object.fromEntries(R.buildRows(fleet, c).map((r) => [r.name, r]));

ok(!rows.lab.selectable && rows.lab.actions.join() === 'no workers — nothing to deploy to', 'lab not selectable');
ok(rows['04-2025'].actions.join() === 'not in this deploy', '04-2025 not in this deploy');
ok(rows['prod-eu'].pulse.label === 'Pulse 1.2.0 · update' && rows['prod-eu'].pulse.tone === 'warning', 'prod-eu pulse tag');
ok(rows['prod-eu'].actions.includes('upgrade pack → 1.3.0'), 'prod-eu upgrade pack');
ok(rows['prod-us'].actions.includes('install pack 1.3.0'), 'prod-us install pack');
ok(rows['04-2025'].pulse.tone === 'success' && rows['prod-us'].pulse.label === 'not installed' && rows['prod-us'].pulse.tone === 'neutral', 'other pulse tags');
ok(rows['prod-eu'].sources === '3 of 5', 'prod-eu 3 of 5');
ok(rows['prod-us'].sources === 'All sources (4)', 'prod-us All sources (4)');
ok(/^(?:\d+(?:\.\d)?k|\d+) ev\/s$/.test(rows['prod-eu'].volume) && /^(?:~\d+\.\d{2}|< 0\.01) core$/.test(rows['prod-eu'].cpu), 'volume and cpu text');

const c2 = { ...c, picks: { ...c.picks, 'prod-eu': [...c.picks['prod-eu'], 'in_s3_cloudtrail'] } };
ok(R.buildRows(fleet, c2).find((r) => r.name === 'prod-eu').sources === '4 of 5', 'picking cloudtrail -> 4 of 5');
const c3 = { ...c, modes: { ...c.modes, 'prod-eu': 'all' } };
ok(R.buildRows(fleet, c3).find((r) => r.name === 'prod-eu').sources === 'All sources (5)', 'All mode');

const s = R.buildSummary(fleet, c);
ok(/\d+ worker groups · \d+ sources/.test(s.text) && s.text.includes('alerts') && s.groups === 3 && s.alerts && s.steps > 0, `summary: ${s.text}`);
const s2 = R.buildSummary(fleet, { ...c, search: false });
ok(!s2.text.includes('alerts') && s2.steps < s.steps, 'no alerts without Search');
process.exit(fail ? 1 : 0);
