// F6: keepLastN 2 on every saved search, pulse_state before its readers, no DELETE.
// Run: node scripts/test-deploy-order.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-do-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const learning = { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 };
const s = { dataset: 'pulse_metrics', destination: 'pulse_lake', rollup: 'off', notify: { targets: ['system_notifications'], email: '', routes: [] }, learning };
const known = [{ id: 'system_notifications', type: 'bulletin_message' }];

const saved = [];
const methods = [];
globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET';
  methods.push(method);
  if (init.body && /search\/saved/.test(String(url))) saved.push(JSON.parse(init.body));
  return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
};

const plan = D.alertsPlan(s, true, undefined, known, { origin: 'https://org.cribl.cloud', base: '/app-ui/pulse' });
const ids = plan.map((x) => x.id);
const state = ids.indexOf('pulse_state');
t('pulse_state is in the plan', state >= 0);
for (const r of ['pulse_alert_missing', 'pulse_alert_source_down', 'pulse_source_digest']) {
  t(`pulse_state comes before ${r}`, state >= 0 && ids.indexOf(r) > state);
  t(`${r} detail says reads pulse_state`, plan.find((x) => x.id === r).detail.includes('reads pulse_state'));
}
t('pulse_state detail does not claim to read itself', !plan.find((x) => x.id === 'pulse_state').detail.includes('reads pulse_state'));

for (const st of plan.filter((x) => x.id.startsWith('pulse_'))) await st.run();
t('saved searches were written', saved.length >= 4);
t('every saved search payload has keepLastN 2', saved.every((b) => b.schedule?.keepLastN === 2));
t('no DELETE request sent', !methods.includes('DELETE'));
const src = readFileSync(join(root, 'src/lib/deploy.ts'), 'utf8');
t('deploy.ts has no DELETE request', !/method:\s*'DELETE'/.test(src));
t('deploy.ts has no keepLastN: 5', !/keepLastN:\s*5/.test(src));

process.exit(fail ? 1 : 0);
