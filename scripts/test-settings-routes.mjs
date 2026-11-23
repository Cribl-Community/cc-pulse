// Tests for notify.routes normalization in src/lib/settings.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-sr-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/settings.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 's.mjs')}`], { stdio: 'pipe' });
const { normalizeSettings, normalizeRoutes, DEFAULT_SETTINGS } = await import(join(tmp, 's.mjs'));

let fails = 0;
const t = (name, ok) => { if (ok) console.log('✔ ' + name); else { fails++; console.log('✘ ' + name); } };
const R = (o = {}) => ({ name: 'n', when: {}, targets: ['a'], final: false, ...o });

t('default routes empty', JSON.stringify(DEFAULT_SETTINGS.notify.routes) === '[]');
t('no routes -> []', JSON.stringify(normalizeSettings({ notify: { targets: [], email: '' } }).notify.routes) === '[]');
t('undefined settings', normalizeSettings(undefined).notify.routes.length === 0);
t('truncated to 5', normalizeRoutes(Array.from({ length: 8 }, () => R())).length === 5);
t('ids unique r1-r5', normalizeRoutes(Array.from({ length: 5 }, () => R())).map((r) => r.id).join() === 'r1,r2,r3,r4,r5');
{
  const out = normalizeRoutes([R({ id: 'r3' }), R(), R({ id: 'r1' }), R({ id: 'r3' })]);
  t('ids preserved', out[0].id === 'r3' && out[2].id === 'r1');
  t('new gets first free id', out[1].id === 'r2');
  t('duplicate id reassigned', out[3].id === 'r4');
  t('idempotent', JSON.stringify(normalizeRoutes(out)) === JSON.stringify(out));
}
{
  const [r] = normalizeRoutes([R({ when: { kinds: ['missing', 'bogus', 'digest', 'missing'], maxCriticality: 9, team: '  net ', input: ' in ' }, targets: ['x', ' x ', 'y', '', 5], severity: 'info', final: 'true' })]);
  t('kinds filtered', r.when.kinds.join() === 'missing,digest');
  t('crit clamped high', r.when.maxCriticality === 4);
  t('team/input trimmed', r.when.team === 'net' && r.when.input === 'in');
  t('targets deduped', r.targets.join() === 'x,y');
  t('severity kept', r.severity === 'info');
  t('final coerced', r.final === true);
}
{
  const [r] = normalizeRoutes([R({ when: { maxCriticality: -3, kinds: ['nope'], team: '  ' }, severity: 'fatal', final: 'yes' })]);
  t('crit clamped low', r.when.maxCriticality === 1);
  t('all-invalid kinds dropped', r.when.kinds === undefined);
  t('blank team dropped', r.when.team === undefined);
  t('invalid severity dropped', r.severity === undefined);
  t('final non-true -> false', r.final === false);
}
if (fails) process.exit(1);
