// rollCallDay helper + Overview roll-call line (spec 038 T4). Run: node scripts/test-rollcall-day.mjs
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rcd-'));
const esbuild = await import('esbuild');
const out = join(tmp, 'c.mjs');
await esbuild.build({ entryPoints: [join(root, 'src/lib/cadence.ts')], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent' });
const { rollCallDay } = await import(out);

let fail = 0;
const t = (msg, ok) => { if (ok !== true) { fail++; console.log('FAIL ' + msg); } else console.log('ok ' + msg); };
const u = (s) => Date.parse(s) / 1000;

t('same UTC day is today', rollCallDay(u('2026-11-22T01:00:00Z'), u('2026-11-22T23:00:00Z'), 'utc') === 'today');
t('previous day is yesterday', rollCallDay(u('2026-11-21T10:00:00Z'), u('2026-11-22T10:00:00Z'), 'utc') === 'yesterday');
t('just across midnight is yesterday', rollCallDay(u('2026-11-21T23:59:59Z'), u('2026-11-22T00:00:01Z'), 'utc') === 'yesterday');
const far = rollCallDay(u('2026-11-19T12:00:00Z'), u('2026-11-22T12:00:00Z'), 'utc');
t('three days before is a short date: ' + far, far === 'Nov 19');

const ov = readFileSync(join(root, 'src/pages/Overview.tsx'), 'utf8');
const line = ov.split('\n').find((l) => l.includes('Roll call as of')) ?? '';
t('Overview template calls rollCallDay', line.includes('rollCallDay('));
t("Overview template has no literal 'today'", !/today/.test(line));

process.exit(fail ? 1 : 0);
