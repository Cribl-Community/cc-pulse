// F3 (spec 035): writeNotification is the only /notifications write site and checks one target before any request.
// Run: node scripts/test-write-notification.mjs
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-wn-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/deploy.ts'), '--bundle', '--format=esm', '--platform=neutral',
  '--main-fields=module,main', `--outfile=${join(tmp, 'd.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const D = await import(join(tmp, 'd.mjs'));

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };

const calls = [];
globalThis.window = { CRIBL_API_URL: 'http://x/api/v1' };
globalThis.fetch = async (url, init = {}) => {
  calls.push({ u: new URL(String(url)).pathname, method: init.method ?? 'GET' });
  return { ok: true, status: 200, text: async () => JSON.stringify({ items: [] }) };
};
const body = (targets, cfgIds, extra = {}) => ({ id: 'n1', disabled: false, condition: 'search', group: 'default_search', targets, metadata: [],
  targetConfigs: cfgIds.map((id) => ({ id, conf: {} })), conf: {}, ...extra });
const rejects = async (b) => { const before = calls.length; try { await D.writeNotification(b); } catch { return calls.length === before; } return false; };

t('0 targets throws, no request', await rejects(body([], [])));
t('2 targets throws, no request', await rejects(body(['a', 'b'], ['a', 'b'])));
t('mismatched targetConfigs id throws, no request', await rejects(body(['a'], ['b'])));
t('missing targetConfigs throws, no request', await rejects(body(['a'], [])));
let ok = true;
try { await D.writeNotification(body(['a'], ['a'])); } catch { ok = false; }
t('one target with matching config is written', ok && calls.some((c) => c.method === 'POST' && c.u.endsWith('/notifications')));
ok = true;
try { await D.writeNotification(body(['a', 'b'], ['a', 'b'], { disabled: true })); } catch { ok = false; }
t('disabled body with multiple targets is accepted', ok);

const text = readFileSync(join(root, 'src/lib/deploy.ts'), 'utf8');
const lines = text.split('\n');
t('only the NOTES constant and the doc comment name /notifications', lines.filter((l) => l.includes('/notifications')).every((l) => l.includes('const NOTES') || l.trim().startsWith('*')));
const start = lines.findIndex((l) => l.includes('export async function writeNotification'));
const end = lines.findIndex((l, i) => i > start && l === '}');
const writes = lines.map((l, i) => [l, i]).filter(([l]) => /api\(`?\$\{NOTES\}|api\(NOTES, \{/.test(l));
t('POST/PATCH to NOTES only inside writeNotification', writes.length > 0 && writes.every(([, i]) => i > start && i < end));
t('no DELETE in deploy.ts', !/DELETE/.test(text));

if (fail) { console.log(`${fail} failed`); process.exit(1); }
