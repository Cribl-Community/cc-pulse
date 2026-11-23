// Spec 031 F2: listPackInputs / listPackRoutes paths and the two GET policy grants.
// Run: node scripts/test-pack-readers.mjs   (`npm test` picks this up automatically)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fail = 0;
const t = (msg, fn) => { if (!fn()) { fail++; console.log(`FAIL ${msg}`); } };

const api = readFileSync(join(root, 'src/lib/api.ts'), 'utf8');
const pol = readFileSync(join(root, 'config/policies.yml'), 'utf8');

t('listPackInputs GETs pack system/inputs', () => /\/m\/\$\{group\}\/p\/\$\{pack\}\/system\/inputs/.test(api));
t('listPackRoutes GETs pack routes', () => /\/m\/\$\{group\}\/p\/\$\{pack\}\/routes/.test(api));
t('listPackInputs drops disabled', () => /\.filter\(\(i\) => !i\.disabled\)/.test(api));
t('listPackRoutes flattens inner routes', () => /\.flatMap\(\(t\) => t\.routes/.test(api));

t("policy object '/m/*/p/*/system/inputs' GET only", () =>
  /object: '\/m\/\*\/p\/\*\/system\/inputs', actions: \['GET'\]/.test(pol));
t("policy object '/m/*/p/*/routes' GET only", () =>
  /object: '\/m\/\*\/p\/\*\/routes', actions: \['GET'\]/.test(pol));
t('policies comment mentions spec 031 and /m/*/p/*', () =>
  /Spec 031:.*\/m\/\*\/p\/\*/.test(pol));

const addedObjects = (pol.match(/object: '\/m\/\*\/p\/\*\/(system\/inputs|routes)'/g) || []).length;
t('exactly two new pack reader policy objects', () => addedObjects === 2);

if (fail) { console.log(`test-pack-readers: ${fail} failed`); process.exit(1); }
console.log('test-pack-readers: ok');