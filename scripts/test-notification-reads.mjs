// writeNotification reads the notifications list once per plan step (spec 038 T5).
// Run: node scripts/test-notification-reads.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-nr-'));
const esbuild = await import('esbuild');
const load = async (src, tag) => {
  const out = join(tmp, `${tag}.mjs`);
  await esbuild.build({ entryPoints: [join(root, src)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent',
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false' } });
  return import(out);
};
const calls = [];
const stored = [{ id: 'pulse_roll_call_notification__system_email', targets: ['system_email'], disabled: false }];
globalThis.window = { CRIBL_API_URL: 'http://org/api/v1', CRIBL_BASE_PATH: '', location: { href: 'http://org/' } };
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  calls.push({ method, url: String(url) });
  const body = /\/notifications$/.test(String(url)) && method === 'GET' ? { items: stored } : { items: [] };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};
const [D, St] = [await load('src/lib/deploy.ts', 'd'), await load('src/lib/settings.ts', 's')];

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const note = (id, targets) => ({ id, targets, conf: { savedQueryId: 'x' }, targetConfigs: targets.map((x) => ({ id: x, conf: {} })) });
const isList = (c) => c.method === 'GET' && /\/m\/default_search\/notifications$/.test(c.url);

// known set
const known = new Set(['a']);
calls.length = 0;
await D.writeNotification(note('a', ['system_email']), known);
await D.writeNotification(note('b', ['system_email']), known);
t('known: no GET', !calls.some((c) => c.method === 'GET'));
t('known: PATCH for a member, POST otherwise', calls[0].method === 'PATCH' && calls[1].method === 'POST');
t('known: id added', known.has('b'));

// guard first
for (const targets of [[], ['system_email', 'system_notifications']]) {
  calls.length = 0;
  let threw = false;
  try { await D.writeNotification(note('z', targets), new Set()); } catch { threw = true; }
  t(`${targets.length} targets throws before any fetch`, threw && calls.length === 0);
}

// roll-call step
const s = { ...St.DEFAULT_SETTINGS, searchLoad: 'daily', notify: { ...St.DEFAULT_SETTINGS.notify, targets: ['system_email', 'system_notifications', 'pulse_slack'], email: 'a@b.c' } };
const plan = D.alertsPlan(s, true, undefined, [{ id: 'pulse_slack', type: 'slack' }, { id: 'system_email', type: 'email' }]);
const step = plan.find((x) => x.id === 'pulse_roll_call');
t('roll call step exists', !!step);
calls.length = 0;
await step.run();
const reads = calls.filter(isList).length;
t(`roll call step: at most 2 notification GETs (got ${reads})`, reads <= 2);
t('roll call step wrote notifications', calls.some((c) => c.method === 'POST' || c.method === 'PATCH'));

// whole apply: no DELETE
calls.length = 0;
for (const st of plan) { try { await st.run(); } catch { /* stub org is empty */ } }
t('no DELETE in the stubbed apply', !calls.some((c) => c.method === 'DELETE'));

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
