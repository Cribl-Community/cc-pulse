// R5: what live loadFleet() reads. `loadFleet({ groups: false })` (the live Setup page's first paint and
// Refresh) reads only the Search status: no group, pack, input or record reads, which loadRows() already
// makes. `loadFleet()` with groups never lists pack inputs (031: read only when a group's sources open).
// R6: the lookups count reads `/m/default_search/system/lookups` (declared in policies.yml), not /search/lookups.
// Run: node scripts/test-setup-fleet-reads.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-fleet-reads-'));
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };

const bundle = (name, entry, dev) => {
  const out = join(tmp, `${name}.mjs`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, entry), '--bundle', '--format=esm', '--platform=neutral',
    `--define:import.meta.env.DEV=${dev}`, `--outfile=${out}`, '--log-level=error'], { stdio: 'pipe' });
  return out;
};

// R6: the lookups API (api.ts publishLookup) and the only lookups path declared in config/policies.yml.
const LOOKUPS = '/m/default_search/system/lookups';

globalThis.window = { CRIBL_BASE_PATH: '', CRIBL_API_URL: 'http://x/api/v1' };
window.parent = window;
const GROUPS = Array.from({ length: 10 }, (_, i) => ({ id: `g${i}`, workerCount: 2 }));
let seen = [];
globalThis.fetch = async (u) => {
  const url = String(u);
  seen.push(url);
  let body = { items: [] };
  if (url.includes('/master/groups')) body = { items: GROUPS };
  else if (/\/m\/g\d+\/packs/.test(url)) body = { items: [{ id: 'cribl-pulse', version: '1.3.0' }, { id: 'cc-paloalto' }, { id: 'cc-aws' }] };
  else if (/\/m\/g\d+\/system\/inputs/.test(url)) body = { items: [{ id: 'in_syslog', type: 'syslog' }] };
  else if (url.endsWith(LOOKUPS)) body = { items: [{ id: 'pulse_assets.csv' }, { id: 'pulse_maintenance.csv' }, { id: 'pulse_overrides.csv' }, { id: 'someone_else.csv' }] };
  // Anything else under /lookups (e.g. the old /search/lookups) is not the lookups API: a policiesOnly 403.
  else if (url.includes('lookups')) return new Response('{"message":"Forbidden"}', { status: 403 });
  return new Response(JSON.stringify(body), { status: 200 });
};
const policies = readFileSync(join(root, 'config/policies.yml'), 'utf8');
ok(policies.includes(`object: '${LOOKUPS}'`) && /actions: \[[^\]]*'GET'/.test(policies.split('\n').find((l) => l.includes(`object: '${LOOKUPS}'`)) ?? ''),
  `config/policies.yml declares GET ${LOOKUPS}`);

try {
  const live = await import(bundle('fleet-live', 'src/lib/setupFleet.ts', 'false'));
  const isGroupRead = (u) => /\/master\/groups|\/m\/g\d+\/|kvstore\/deployments\//.test(u);
  const isPackInputs = (u) => /\/p\/[^/]+\/system\/inputs/.test(u);

  seen = [];
  const s = await live.loadFleet({ groups: false });
  ok(Array.isArray(s.groups) && s.groups.length === 0 && s.search && typeof s.search.saved === 'number', 'groups: false returns no groups and the Search status');
  ok(!seen.some(isGroupRead), `groups: false makes no group, pack, input or record reads (${seen.filter(isGroupRead).length})`);
  ok(seen.some((u) => u.endsWith(LOOKUPS)), `groups: false still reads the lookups at ${LOOKUPS}`);
  const lookupReads = seen.filter((u) => u.includes('lookups'));
  ok(lookupReads.length > 0 && lookupReads.every((u) => u.endsWith(LOOKUPS)), `every lookups read uses ${LOOKUPS}, none /search/lookups (${lookupReads.join(', ')})`);
  ok(s.search.lookups === 3, `the lookups count is the app's 3 lookups, not 0 (${s.search.lookups})`);
  ok(seen.length < 10, `groups: false on 10 groups sends a handful of requests, not ~100 (${seen.length})`);

  seen = [];
  const full = await live.loadFleet();
  ok(full.groups.length === 10 && full.groups.every((g) => g.packSources.length === 0), 'loadFleet() still returns the groups, with no eager pack sources');
  ok(!seen.some(isPackInputs), `loadFleet() lists no pack inputs (${seen.filter(isPackInputs).length})`);

  const demo = await import(bundle('fleet-demo', 'src/lib/setupFleet.ts', 'true'));
  delete window.CRIBL_API_URL; // a set CRIBL_API_URL means live; demo is plain `npm run dev`
  seen = [];
  const d = await demo.loadFleet({ groups: false });
  ok(seen.length === 0 && d.groups.length === 5, 'demo ignores groups: false: the demo fleet, no fetch');
} catch (e) {
  fail++;
  console.log('✘ threw', e?.message || e);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(fail ? `test-setup-fleet-reads: ${fail} failure(s)` : 'test-setup-fleet-reads: all passed');
process.exit(fail ? 1 : 0);
