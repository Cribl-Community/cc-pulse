#!/usr/bin/env node
// Unit tests for the Overview Question card derivation in src/lib/questions.ts (spec 013 Section 5/7).
// Pure functions, no React: bundled standalone with esbuild and run directly.
// Run: node scripts/test-questions.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules/.tmp-questions-bundle.mjs');
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/questions.ts'), '--bundle', '--platform=node', '--format=esm',
  '--log-level=error', '--define:window.CRIBL_API_URL="http://pulse.test/api/v1"', `--outfile=${out}`], { stdio: 'inherit' });
const { longestSilentMissing, worstSource, worstTeam, UNASSIGNED_TEAM } = await import(`${out}?t=${Date.now()}`);
rmSync(out, { force: true });

let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.log('FAIL', name); } };

const e = (over) => ({ key: '', group: 'g1', input: 'in1', asset: 'a', state: 'ok', raw: 'ok', signal: '',
  silent_s: 0, tolerance_s: 100, gap_s: 10, active_min: 100, events: 1, events_1h: 1, vol_ratio: 1,
  max_lag_s: 0, lag_now_s: 0, min_lag_s: 0, key_src: '', maintenance: '', cluster: '', last_seen: 0, last_seen_utc: '', overridden: false, ...over });

// longestSilentMissing: picks the longest-silent P1 among several missing assets, ignoring lower criticality
// even if it has been silent longer.
{
  const fleet = [
    e({ asset: 'p2-long', state: 'missing', silent_s: 9000 }),
    e({ asset: 'p1-short', state: 'missing', silent_s: 500 }),
    e({ asset: 'p1-long', state: 'missing', silent_s: 4000 }),
    e({ asset: 'ok1', state: 'ok' }),
  ];
  const inventory = { 'p2-long': { criticality: 2 }, 'p1-short': { criticality: 1 }, 'p1-long': { criticality: 1 } };
  const r = longestSilentMissing(fleet, inventory);
  ok('longestSilentMissing count', r.count === 3);
  ok('longestSilentMissing picks longest-silent P1', r.top?.asset === 'p1-long');
}
// Falls back to the longest-silent missing asset of any criticality when there is no P1.
{
  const fleet = [e({ asset: 'p2-a', state: 'missing', silent_s: 200 }), e({ asset: 'p2-b', state: 'missing', silent_s: 900 })];
  const inventory = { 'p2-a': { criticality: 2 }, 'p2-b': { criticality: 2 } };
  const r = longestSilentMissing(fleet, inventory);
  ok('longestSilentMissing falls back without a P1', r.top?.asset === 'p2-b');
}
// No missing assets at all.
{
  const r = longestSilentMissing([e({ state: 'ok' })], {});
  ok('longestSilentMissing empty', r.count === 0 && r.top === undefined);
}

// worstSource: the source (group|input) with the most missing or late/delayed senders wins, healthy ones don't count.
{
  const fleet = [
    e({ asset: 'a1', group: 'g1', input: 'tcp:in_a', state: 'missing' }),
    e({ asset: 'a2', group: 'g1', input: 'tcp:in_a', state: 'late' }),
    e({ asset: 'a3', group: 'g1', input: 'tcp:in_a', state: 'ok' }),
    e({ asset: 'b1', group: 'g2', input: 'tcp:in_b', state: 'missing' }),
  ];
  const r = worstSource(fleet);
  ok('worstSource picks the source with the most alarm senders', r?.group === 'g1' && r?.input === 'tcp:in_a' && r?.count === 2);
}
{ ok('worstSource undefined when nothing is wrong', worstSource([e({ state: 'ok' })]) === undefined); }

// worstTeam: the team with the most open problems wins; assets without a team count as "unassigned".
{
  const fleet = [
    e({ asset: 'x1', state: 'missing' }),
    e({ asset: 'x2', state: 'late' }),
    e({ asset: 'x3', state: 'missing' }),
    e({ asset: 'x4', state: 'delayed' }),
    e({ asset: 'x5', state: 'missing' }),
    e({ asset: 'ok1', state: 'ok' }),
  ];
  const inventory = { x1: { team: 'network' }, x2: { team: 'network' } };
  const r = worstTeam(fleet, inventory);
  ok('worstTeam counts unassigned as a team', r?.team === UNASSIGNED_TEAM && r?.count === 3);
}
{
  const fleet = [e({ asset: 'x1', state: 'missing' }), e({ asset: 'x2', state: 'missing' }), e({ asset: 'x3', state: 'missing' })];
  const inventory = { x1: { team: 'network' }, x2: { team: 'network' }, x3: { team: 'network' } };
  const r = worstTeam(fleet, inventory);
  ok('worstTeam picks the biggest named team', r?.team === 'network' && r?.count === 3);
}
{ ok('worstTeam undefined with no problems', worstTeam([e({ state: 'ok' })], {}) === undefined); }

console.log(fail ? `${fail} failure(s)` : 'question derivation OK (10 checks)');
process.exit(fail ? 1 : 0);
