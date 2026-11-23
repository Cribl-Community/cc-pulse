// savedStatus returns extra rows so installedLoad sees the load actually installed (spec 038 T2).
// Run: node scripts/test-saved-status-load.mjs
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ssl-'));
const esbuild = await import('esbuild');
const load = async (src, tag) => {
  const out = join(tmp, `${tag}.mjs`);
  await esbuild.build({ entryPoints: [join(root, src)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent',
    define: { 'import.meta.env.BASE_URL': '"/"', 'import.meta.env.DEV': 'false' } });
  return import(out);
};
const org = { saved: [] };
globalThis.window = { CRIBL_API_URL: 'http://org/api/v1', CRIBL_BASE_PATH: '', location: { href: 'http://org/' } };
globalThis.fetch = async (url) => new Response(JSON.stringify({ items: /\/search\/saved$/.test(String(url)) ? org.saved : [] }), { status: 200, headers: { 'content-type': 'application/json' } });
const [D, K, C, St] = [await load('src/lib/deploy.ts', 'd'), await load('src/lib/kql.ts', 'k'), await load('src/lib/cadence.ts', 'c'), await load('src/lib/settings.ts', 's')];
const B = St.DEFAULT_SETTINGS;
const std = { ...B, searchLoad: 'standard' }, daily = { ...B, searchLoad: 'daily' };

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

org.saved = [{ id: 'pulse_roll_call', schedule: { enabled: true, cronSchedule: '0 6 * * *' } }, { id: 'pulse_state', schedule: { enabled: false, cronSchedule: '2-59/5 * * * *' } }];
const s1 = await D.savedStatus(std);
const rc = s1.find((x) => x.id === 'pulse_roll_call');
t('roll call extra row, exists and enabled', !!rc && rc.extra === true && rc.exists && rc.enabled);
t('main rows are not extra', s1.filter((x) => x.id !== 'pulse_roll_call').every((x) => !x.extra));
t('installedLoad is daily', C.installedLoad(s1) === 'daily');

org.saved = K.savedSearches(std).map((d) => ({ id: d.id, schedule: { enabled: d.enabled !== false, cronSchedule: d.cron } }));
const s2 = await D.savedStatus(daily);
const ps = s2.find((x) => x.id === 'pulse_state');
t('standard extra row for daily settings', !!ps && ps.extra === true && ps.exists && ps.enabled);
t('installedLoad is standard', C.installedLoad(s2) === 'standard');

org.saved = [];
const s3 = await D.savedStatus(std);
t('nothing installed: extra rows do not exist', s3.filter((x) => x.extra).every((x) => !x.exists) && C.installedLoad(s3) === null);

const alerts = readFileSync(join(root, 'src/pages/Alerts.tsx'), 'utf8');
t('Alerts hides extra rows that do not exist', /!r\.extra \|\| r\.exists/.test(alerts));
t('Alerts labels installed extra rows', alerts.includes('installed, the plan disables it'));

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('all ok');
