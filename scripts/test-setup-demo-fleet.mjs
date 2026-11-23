// Spec 039 F1: setupFleet() demo data and loadFleet() (demo vs API). Run: node scripts/test-setup-demo-fleet.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-fleet-'));
const bundle = (name, entry, dev) => {
  const out = join(tmp, `${name}.mjs`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
    `--define:import.meta.env.DEV=${dev}`, `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
  return out;
};
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };

globalThis.window = { CRIBL_BASE_PATH: '' };
window.parent = window;
let calls = 0;
globalThis.fetch = async (u) => { calls++; return new Response(JSON.stringify({ items: [] }), { status: 200 }); };

const { setupFleet } = await import(bundle('demo', 'src/lib/demo.ts', 'true'));
const d = setupFleet();
const g = Object.fromEntries(d.groups.map((x) => [x.id, x]));
ok(d.groups.map((x) => x.id).join() === 'prod-eu,prod-us,edge-paris,04-2025,lab', 'five groups in order');
const eu = g['prod-eu'];
ok(eu.workers === 6 && eu.pulse === '1.2.0' && eu.mode === 'selected', 'prod-eu: 6 workers, 1.2.0, Pick');
ok(JSON.stringify(eu.sources.map((s) => [s.id, s.type, s.evs, s.picked, !!s.isNew])) ===
  JSON.stringify([['in_syslog', 'syslog', 4200, true, false], ['in_splunk_hec', 'splunk_hec', 1800, true, false], ['in_kafka_app', 'kafka', 9000, true, true], ['in_s3_cloudtrail', 's3', 300, false, false]]), 'prod-eu sources');
ok(eu.packSources.length === 1 && eu.packSources[0].id === 'in_pan_syslog' && eu.packSources[0].pack === 'cc-paloalto' && eu.packSources[0].type === 'syslog' && eu.packSources[0].evs === 2500, 'prod-eu pack source');
ok(g['prod-us'].workers === 8 && !g['prod-us'].pulse && g['prod-us'].mode === 'all' && g['prod-us'].sources.length === 4, 'prod-us');
const ep = g['edge-paris'];
ok(ep.workers === 2 && !ep.pulse && ep.mode === 'selected' && ep.sources.map((s) => s.id).join() === 'in_iot,in_syslog_edge,in_windows_events' && ep.sources.filter((s) => s.picked).length === 1, 'edge-paris: Pick 1 of 3');
ok(g['04-2025'].workers === 2 && g['04-2025'].pulse === '1.3.0' && g['04-2025'].selected === false, '04-2025');
ok(g.lab.workers === 0 && g.lab.sources.length === 0 && g.lab.packSources.length === 0, 'lab');
const s = d.search;
ok(s.dataset && s.targets.length > 0 && typeof s.schedules === 'boolean' && s.saved > 0 && s.lookups > 0 && s.outdated > 0, 'search status present');

const demo = await import(bundle('fleet-demo', 'src/lib/setupFleet.ts', 'true'));
calls = 0;
const r = await demo.loadFleet();
ok(calls === 0 && r.groups.length === 5 && r.groups[0].id === 'prod-eu', 'demo mode: setupFleet data, no fetch');

window.CRIBL_API_URL = 'http://x/api/v1';
const live = await import(bundle('fleet-live', 'src/lib/setupFleet.ts', 'false'));
const seen = [];
globalThis.fetch = async (u) => {
  seen.push(String(u));
  const body = String(u).includes('/master/groups') ? { items: [{ id: 'default', workerCount: 2 }] } : { items: [] };
  return new Response(JSON.stringify(body), { status: 200 });
};
const l = await live.loadFleet();
ok(seen.some((u) => u.includes('/master/groups')) && l.groups.length === 1 && l.groups[0].id === 'default' && l.groups[0].workers === 2, 'live mode: reads the API');
ok(l.groups[0].mode === 'all', 'live group with no deployment record defaults to All');
process.exit(fail ? 1 : 0);
