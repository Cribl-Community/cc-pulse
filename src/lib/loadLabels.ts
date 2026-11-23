// Spec 033: helper wording that follows the Search load. Pure.
import type { SearchLoad } from './cadence';

export const LOAD_ITEMS = [
  { id: 'standard', label: 'Standard' },
  { id: 'hourly', label: 'Hourly' },
  { id: 'daily', label: 'Economy' },
];

const pad = (h: number) => String(h).padStart(2, '0');

export function refreshHelper(load: SearchLoad, rollCall?: { hour: number; tz: string }): string {
  const when = load === 'standard' ? 'computed every 5 min'
    : load === 'hourly' ? 'every hour'
    : `once a day at ${pad(rollCall?.hour ?? 6)}:00 (${rollCall?.tz ?? 'UTC'})`;
  return `Each refresh reads the Pulse snapshot (${when}). Refresh on a page runs the full live query.`;
}

export function rollupLine(load: SearchLoad): string | null {
  return load === 'daily' ? 'Rollup: off in Economy' : null;
}
