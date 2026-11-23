// Lifecycle text tests (F8). Run: node scripts/test-routes-texts.mjs
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-rtt-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/routes.ts'), '--bundle', '--format=esm', `--outfile=${join(tmp, 'r.mjs')}`], { stdio: 'pipe' });
const { lifecycleText, formatDuration } = await import(join(tmp, 'r.mjs'));

let fails = 0;
const eq = (name, a, b) => { if (a === b) console.log('✔ ' + name); else { fails++; console.log(`✘ ${name}\n  got:  ${a}\n  want: ${b}`); } };

const open = Date.UTC(2026, 10, 20, 10, 0, 0) / 1000;
eq('resolved asset', lifecycleText('resolved', { asset: 'fw01', input: 'in_syslog', criticality: 1, team: 'network', openedAt: open, nowS: open + 47 * 60 }),
  'Resolved: fw01 is sending to in_syslog again after 47 min (P1 · network). Incident started 2026-11-20T10:00:00Z.');
eq('resolved source-down', lifecycleText('resolved', { input: 'in_syslog', criticality: 2, team: 'network', openedAt: open, nowS: open + 3 * 3600 }),
  'Resolved: in_syslog is sending again after 3 h (P2 · network). Incident started 2026-11-20T10:00:00Z.');
eq('reminder asset', lifecycleText('reminder', { asset: 'fw01', input: 'in_syslog', silentS: 4 * 3600 }), 'Reminder: fw01 still silent after 4 h.');
eq('reminder source-down', lifecycleText('reminder', { input: 'in_syslog', silentS: 30 * 60 }), 'Reminder: in_syslog still silent after 30 min.');
eq('closed asset', lifecycleText('expired', { asset: 'fw01', input: 'in_syslog', windowH: 24 }), 'Closed: fw01 left the 24 h window; Pulse stopped tracking it.');
eq('closed source-down', lifecycleText('expired', { input: 'in_syslog', windowH: 24 }), 'Closed: in_syslog left the 24 h window; Pulse stopped tracking it.');
eq('duration 90 min', formatDuration(5400), '1.5 h');

if (fails) process.exit(1);
console.log('routes text tests passed');
