#!/usr/bin/env node
// Unit tests for the "Incidents over 24 h" hourly bucketing in src/lib/incidents.ts (spec 013 Section 9).
// Pure functions, no React: bundled standalone with esbuild and run directly.
// Run: node scripts/test-incidents.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'node_modules/.tmp-incidents-bundle.mjs');
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/incidents.ts'), '--bundle', '--platform=node', '--format=esm',
  '--log-level=error', `--outfile=${out}`], { stdio: 'inherit' });
const { reasonOf, hourlyByReason, maxHourly, REASONS } = await import(`${out}?t=${Date.now()}`);
rmSync(out, { force: true });

let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.log('FAIL', name); } };

const ent = (over) => ({ raw: 'missing', signal: '', ...over });
const inc = (start, over) => ({ id: String(start), start, secs: 1000, ongoing: false, entities: [ent(over)] });

// reasonOf: signal wins over state, then raw state, then the plain-silence default.
ok('reasonOf low_volume signal wins', reasonOf(ent({ signal: 'low_volume', raw: 'ok' })) === 'low_volume');
ok('reasonOf delayed raw', reasonOf(ent({ raw: 'delayed' })) === 'delayed');
ok('reasonOf late raw', reasonOf(ent({ raw: 'late' })) === 'late');
ok('reasonOf missing default', reasonOf(ent({ raw: 'missing' })) === 'missing');
ok('reasonOf ok falls back to missing', reasonOf(ent({ raw: 'ok' })) === 'missing');

const hourStart = Math.floor(1_700_000_000 / 3600) * 3600; // arbitrary fixed hour boundary
const now = hourStart + 3599; // a moment just before the hour turns over, so "current hour" incidents are never in the future

// hourlyByReason: 24 buckets, oldest first; each incident lands in the hour its start falls in.
{
  const incidents = [
    inc(hourStart - 23 * 3600 + 10, { raw: 'missing' }),      // oldest bucket (index 0)
    inc(hourStart + 300, { raw: 'late' }),                    // current hour (index 23)
    inc(hourStart + 400, { signal: 'low_volume' }),           // also current hour, different reason
    inc(hourStart - 50 * 3600, { raw: 'missing' }),           // outside the 24 h window: dropped
  ];
  const buckets = hourlyByReason(incidents, now);
  ok('hourlyByReason returns 24 buckets', buckets.length === 24);
  ok('hourlyByReason is oldest first', buckets[0].start < buckets[23].start);
  ok('hourlyByReason counts the oldest incident in bucket 0', buckets[0].counts.missing === 1 && buckets[0].total === 1);
  ok('hourlyByReason stacks two reasons into the last bucket', buckets[23].counts.late === 1 && buckets[23].counts.low_volume === 1 && buckets[23].total === 2);
  ok('hourlyByReason drops incidents outside the window', buckets.reduce((s, b) => s + b.total, 0) === 3);
  ok('hourlyByReason has all 4 reason series on every bucket', buckets.every((b) => REASONS.every((r) => typeof b.counts[r] === 'number')));
}

// hourlyByReason with no incidents: 24 empty buckets, never throws.
{
  const buckets = hourlyByReason([], now);
  ok('hourlyByReason empty has 24 buckets', buckets.length === 24);
  ok('hourlyByReason empty totals are zero', buckets.every((b) => b.total === 0));
  ok('maxHourly is at least 1 for an empty day', maxHourly(buckets) === 1);
}

// maxHourly: the largest single-hour total.
{
  const buckets = hourlyByReason([inc(hourStart - 1800, {}), inc(hourStart - 1700, { raw: 'late' }), inc(hourStart - 1600, { raw: 'delayed' })], now);
  ok('maxHourly picks the busiest hour', maxHourly(buckets) === 3);
}

// Future incidents (clock skew) are ignored rather than crashing the bucketing.
{
  const buckets = hourlyByReason([inc(now + 5000, {})], now);
  ok('hourlyByReason ignores incidents in the future', buckets.every((b) => b.total === 0));
}

if (fail) { console.log(`${fail} incidents bucketing test(s) failed`); process.exit(1); }
console.log('incidents bucketing: all tests passed');
