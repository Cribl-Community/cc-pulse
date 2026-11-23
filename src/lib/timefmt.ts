// The one formatter for absolute timestamps (spec 014 §2): every time-bound page formats through here so tz is honoured.
import { formatTs, type Tz } from './timescope';
export type { Tz };
const zone = (tz: Tz) => (tz === 'utc' ? 'UTC' : undefined);
const L = (t: number, tz: Tz, o: Intl.DateTimeFormatOptions) => new Date(t * 1000).toLocaleString([], { ...o, timeZone: zone(tz) });

/** HH:mm for epoch seconds t (0 gives an em dash). */
export const formatClock = (t: number, tz: Tz): string => (t ? L(t, tz, { hour: '2-digit', minute: '2-digit' }) : '—');
/** Hour only, for hourly bucket labels. */
export const formatHour = (t: number, tz: Tz): string => L(t, tz, { hour: '2-digit' });
/** Long day heading, e.g. Monday, 9 November. */
export const formatDay = (t: number, tz: Tz): string => L(t, tz, { weekday: 'long', day: 'numeric', month: 'long' });
/** YYYY-MM-DD HH:mm:ss (also what rangeLabel uses; defined in timescope.ts to keep that module import-free). */
export { formatTs };
