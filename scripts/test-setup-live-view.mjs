// F2: shared volume, CPU, and summary formatters (setupRows + live summary).
// Run: node scripts/test-setup-live-view.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-live-view-'));
const bundle = (entry, name) => {
  const out = join(tmp, `${name}.mjs`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [
    join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
    '--define:import.meta.env.DEV=true', `--outfile=${out}`, '--log-level=error',
  ], { stdio: 'pipe' });
  return out;
};

let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };

const R = await import(bundle('src/lib/setupRows.ts', 'rows'));
const { setupFleet } = await import(bundle('src/lib/demo.ts', 'demo'));

ok(R.formatVolume(15000) === '15k ev/s', 'formatVolume 15k');
ok(R.formatVolume(1800) === '1.8k ev/s', 'formatVolume 1.8k');
ok(R.formatVolume(1500) === '1.5k ev/s', 'formatVolume 1.5k');
ok(R.formatVolume(1234) === '1.2k ev/s', 'formatVolume 1.2k');
ok(R.formatVolume(1000) === '1k ev/s', 'formatVolume 1k');
ok(R.formatVolume(400) === '400 ev/s', 'formatVolume under 1k');
ok(R.formatVolume(0) === '0 ev/s', 'formatVolume zero');
const cpu04 = R.formatCpu(0.04);
ok(cpu04 === '~0.04 core', 'formatCpu singular core');
ok(!cpu04.includes('cores'), 'formatCpu never says cores');
ok(R.formatCpu(0) === '~0.00 core', 'formatCpu zero');
ok(R.formatCpu(0.004) === '< 0.01 core', 'formatCpu rounds to 0.00');

ok(R.watchedSourceCount({ mode: 'all', ownInputs: 2, tickablePack: null }) === 2, 'All unclassified packs: own only');
ok(R.watchedSourceCount({ mode: 'all', ownInputs: 2, tickablePack: 3 }) === 5, 'All classified tickable pack');
ok(R.watchedSourceCount({ mode: 'pick', pickCount: 1 }) === 1, 'Pick returns pick count');
ok(R.watchedSourceCount({ mode: 'all', ownInputs: 2, tickablePack: 0 }) === 2, 'All with empty tickable pack');

const withAlerts = R.summaryLine({ groups: 2, sources: 4, alerts: true, cpu: 0.5 });
ok(withAlerts.includes(' · alerts · '), 'summaryLine alerts segment');
const noAlerts = R.summaryLine({ groups: 2, sources: 4, alerts: false, cpu: 0.5 });
ok(!noAlerts.includes('alerts'), 'summaryLine without alerts');

const fleet = setupFleet();
const c = R.defaultChoices(fleet);
const s = R.buildSummary(fleet, c);
ok(s.groups === 3 && s.alerts && s.text.includes('alerts'), `demo fleet summary: ${s.text}`);

const staysFleet = {
  groups: [{
    id: 'g1', workers: 2, mode: 'all', selected: true,
    sources: [{ id: 'in_a', type: 'syslog', evs: 100, picked: true }],
    packSources: [{ id: 'in_pack', type: 'syslog', evs: 50, picked: false, pack: 'p', staysInPack: true }],
  }],
  search: fleet.search,
};
const staysChoices = { ...c, selected: ['g1'], modes: { g1: 'all' }, picks: { g1: [] } };
const row = R.buildRows(staysFleet, staysChoices)[0];
ok(row.sources === 'All sources (2)', 'row label counts stays-in-pack in All sources (n)');
const staysSummary = R.buildSummary(staysFleet, staysChoices);
ok(staysSummary.sources === 1, 'summary source count excludes stays-in-pack');

const twoAll = {
  groups: [
    { id: 'a', workers: 2, mode: 'all', selected: true, sources: [
      { id: 'i1', type: 'syslog', evs: 10_000, picked: true },
      { id: 'i2', type: 'tcp', evs: 10_000, picked: true },
    ], packSources: [] },
    { id: 'b', workers: 2, mode: 'all', selected: true, sources: [
      { id: 'i3', type: 'syslog', evs: 10_000, picked: true },
      { id: 'i4', type: 'tcp', evs: 10_000, picked: true },
    ], packSources: [] },
  ],
  search: fleet.search,
};
const twoChoices = { selected: ['a', 'b'], modes: { a: 'all', b: 'all' }, picks: { a: [], b: [] }, newDefault: 'all', search: true };
const twoSum = R.buildSummary(twoAll, twoChoices);
ok(/^2 worker groups · 4 sources · alerts · ~\d+\.\d{2} core of worker CPU in total$/.test(twoSum.text), `two All groups summary: ${twoSum.text}`);
const twoSumOff = R.buildSummary(twoAll, { ...twoChoices, search: false });
ok(!twoSumOff.text.includes('alerts'), 'no alerts when Search off');

process.exit(fail ? 1 : 0);