// Parity test: the pack's Code function (pulse_heartbeat) and src/lib/identity.ts must resolve every fixture alike.
// Run: node scripts/test-identity.mjs   (bundles identity.ts with esbuild into a temp file, no other deps)
import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import YAML from 'yaml';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const conf = YAML.parse(readFileSync(join(root, 'bundle/stream-pack/default/pipelines/pulse_heartbeat/conf.yml'), 'utf8'));
const code = conf.functions.find((f) => f.id === 'code').conf.code;
const vars = YAML.parse(readFileSync(join(root, 'bundle/stream-pack/default/vars.yml'), 'utf8'));
const tmp = mkdtempSync(join(tmpdir(), 'pulse-id-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/identity.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'identity.mjs')}`], { stdio: 'pipe' });
const id = await import(join(tmp, 'identity.mjs'));

const baseVars = { PULSE_WEAK_HOSTS: JSON.parse(vars.PULSE_WEAK_HOSTS.value), PULSE_ASSET_CASE: 'keep', PULSE_SOURCE_LABEL: '(source)' };
const pack = (e, keys = {}, extra = {}) => { const ev = { ...e }; const C = { vars: { ...baseVars, PULSE_KEYS: keys, ...extra } };
  new Function('__e', 'C', code)(ev, C); return { asset: ev.__pa, src: ev.__pas }; };

const F = [
  [{ _raw: 'a dev.name=x9 b', __inputId: 'tcp:dot' }, { 'tcp:dot': 'kv:dev.name' }, 'x9', 'kv:dev.name'],
  [{ host: 'sender-01', _raw: 'x', __inputId: 'http:in_a:cribl' }, {}, 'sender-01', 'host'],
  [{ host: 'localhost', _raw: '<13>Nov  6 07:27:00 fw-par-edge-01 sshd: hi', __inputId: 'tcp:in_raw', __srcIpPort: '10.0.0.9:5514' }, {}, 'fw-par-edge-01', 'syslog'],
  [{ _raw: '<34>1 2026-11-06T07:27:00Z mymachine.example.com su - ID47 - hi', __inputId: 'tcp:in_raw' }, {}, 'mymachine.example.com', 'syslog'],
  [{ host: 'localhost', _raw: '1,2026/11/06 07:27:01,007200001234,TRAFFIC,end', __inputId: 'datagen:pantraffic' }, { 'datagen:pantraffic': 'csv:2 | ip' }, '007200001234', 'csv:2'],
  [{ _raw: 'date=2026-11-06 devname="FGT-PAR-01" type="traffic"', __inputId: 'tcp:in_fgt', __srcIpPort: '[2001:db8::7]:5514' }, {}, 'FGT-PAR-01', 'kv:devname'],
  [{ _raw: 'hello', __inputId: 'tcp:in_fgt', __srcIpPort: '[2001:db8::7]:5514' }, {}, '2001:db8::7', 'ip'],
  [{ _raw: '{"msg":"hi"}', __inputId: 'http:in_api:cribl' }, {}, '(source)', 'none'],
  [{ host: { name: 'web01' }, _raw: '', __inputId: 'http:in_elastic:cribl' }, {}, 'web01', 'field:host.name'],
  [{ _raw: '{"device":{"id":"sensor-9"}}', __inputId: 'http:in_iot:cribl' }, { in_iot: 'json:device.id' }, 'sensor-9', 'json:device.id'],
  [{ _raw: 'id=abc node=n-17 x', host: 'relay-1', __inputId: 'tcp:in_relay' }, { 'tcp:in_relay': 'regex:node=(\\S+) | host' }, 'n-17', 'regex:node=(\\S+) | host'],
  [{ host: 'relay-1', __inputId: 'tcp:in_one' }, { 'tcp:in_one': 'none' }, '(source)', 'none'],
];
let fail = 0;
for (const [e, keys, want, wantSrc] of F) {
  const spec = keys[e.__inputId] || keys[e.__inputId.split(':').slice(0, 2).join(':')] || keys[e.__inputId.split(':')[1]] || 'auto';
  const p = pack(e, keys), a = id.resolve(e, spec);
  const ok = p.asset === want && a.asset === want && p.src === a.src && (wantSrc === undefined || p.src === wantSrc || wantSrc.startsWith('regex'));
  if (!ok) { fail++; console.log('FAIL', JSON.stringify(e).slice(0, 80), { want, pack: p, app: a }); }
}
const short = pack({ host: 'WEB01.corp.local', __inputId: 'x:y' }, {}, { PULSE_ASSET_CASE: 'short' });
if (short.asset !== 'web01') { fail++; console.log('FAIL short', short); }
const cands = id.candidates([0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ raw: `1,2026/11/06 07:27:0${i},00720000${1000 + (i % 3)},TRAFFIC,end,2561,${Date.now() + i}`, fields: { host: 'localhost' } })));
if (cands[0]?.spec !== 'csv:2') { fail++; console.log('FAIL advisor top', cands.slice(0, 3)); }
console.log(fail ? `${fail} failure(s)` : `identity parity OK (${F.length + 2} checks)`);

// `npm test` runs only this file, so it also runs every other scripts/test-*.mjs, in name order.
// A new suite needs no registration here: name it scripts/test-<name>.mjs and it runs.
for (const f of readdirSync(join(root, 'scripts')).filter((n) => /^test-.+\.mjs$/.test(n) && n !== 'test-identity.mjs').sort()) {
  try { execFileSync(process.execPath, [join(root, 'scripts', f)], { stdio: 'inherit' }); }
  catch { fail++; console.log(`✘ ${f} failed`); }
}
process.exit(fail ? 1 : 0);
