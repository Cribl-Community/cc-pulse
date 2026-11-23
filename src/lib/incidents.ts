/* Incidents over the range (spec 013 Section 9): pure hourly bucketing by reason for the stacked-bar chart.
   Kept out of the Incidents page so it can be unit-tested without React. */
import type { Entity } from './model';
import type { Incident } from './history';

export const REASONS = ['missing', 'late', 'delayed', 'low_volume'] as const;
export type Reason = typeof REASONS[number];
export const REASON_LABEL: Record<Reason, string> = { missing: 'Missing', late: 'Late', delayed: 'Delayed', low_volume: 'Low volume' };

/** The reason an incident's lead entity counts for in the chart. Low volume and delayed come from the asset's
 *  current signal/state; anything else is a plain silence, which defaults to "missing". */
export function reasonOf(e: Pick<Entity, 'raw' | 'signal'>): Reason {
  if (e.signal === 'low_volume') return 'low_volume';
  if (e.raw === 'delayed') return 'delayed';
  if (e.raw === 'late') return 'late';
  return 'missing';
}

export type HourBucket = { hour: number; start: number; counts: Record<Reason, number>; total: number };

/** 24 (or hours) one-hour buckets, oldest first, each counting incidents whose start falls in that hour by reason.
 *  Incidents outside the window are ignored. */
export function hourlyByReason(incidents: Incident[], now = Date.now() / 1000, hours = 24): HourBucket[] {
  const end = Math.floor(now / 3600) * 3600 + 3600;
  const buckets: HourBucket[] = Array.from({ length: hours }, (_, i) => {
    const start = end - (hours - i) * 3600;
    return { hour: i, start, counts: { missing: 0, late: 0, delayed: 0, low_volume: 0 }, total: 0 };
  });
  for (const inc of incidents) {
    if (inc.start > now || inc.start < buckets[0].start) continue;
    const idx = Math.min(hours - 1, Math.floor((inc.start - buckets[0].start) / 3600));
    if (idx < 0) continue;
    const r = reasonOf(inc.entities[0]);
    buckets[idx].counts[r]++;
    buckets[idx].total++;
  }
  return buckets;
}

/** The largest single-hour total, for scaling the chart; at least 1 so an empty day still draws an axis. */
export const maxHourly = (buckets: HourBucket[]): number => Math.max(1, ...buckets.map((b) => b.total));
