// Tests for searchLoad, rollCall and effectiveRollup in src/lib/settings.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-sl-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/settings.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 's.mjs')}`], { stdio: 'pipe' });
const { normalizeSettings, effectiveRollup, DEFAULT_SETTINGS } = await import(join(tmp, 's.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };

t('missing searchLoad -> standard', normalizeSettings({}).searchLoad === 'standard');
t('unknown searchLoad -> standard', normalizeSettings({ searchLoad: 'bogus' }).searchLoad === 'standard');
t('valid searchLoad kept', normalizeSettings({ searchLoad: 'daily' }).searchLoad === 'daily');
{
  const n = normalizeSettings({ dataset: 'x', rollup: 'off' });
  t('other fields unchanged', n.dataset === 'x' && n.rollup === 'off' && n.destination === DEFAULT_SETTINGS.destination && n.refresh === DEFAULT_SETTINGS.refresh);
}
{
  const rc = normalizeSettings({}).rollCall;
  t('missing rollCall default', rc.hour === 7 && typeof rc.tz === 'string' && rc.tz.length > 0 && rc.allClear === false);
}
t('hour 25 -> 7', normalizeSettings({ rollCall: { hour: 25, tz: 'UTC', allClear: false } }).rollCall.hour === 7);
t('hour -1 -> 7', normalizeSettings({ rollCall: { hour: -1, tz: 'UTC', allClear: false } }).rollCall.hour === 7);
t('valid rollCall kept', JSON.stringify(normalizeSettings({ rollCall: { hour: 0, tz: 'Europe/Paris', allClear: true } }).rollCall) === '{"hour":0,"tz":"Europe/Paris","allClear":true}');
t('empty tz defaulted', normalizeSettings({ rollCall: { hour: 5, tz: '  ', allClear: false } }).rollCall.tz.length > 0);
t('daily -> off', effectiveRollup({ searchLoad: 'daily', rollup: 'auto' }) === 'off');
t('standard passes rollup', effectiveRollup({ searchLoad: 'standard', rollup: 'auto' }) === 'auto');
t('hourly passes rollup', effectiveRollup({ searchLoad: 'hourly', rollup: 'off' }) === 'off' && effectiveRollup({ searchLoad: 'hourly', rollup: 'auto' }) === 'auto');

if (fails) { console.log(fails + ' failed'); process.exit(1); }
console.log('settings-load ok');
