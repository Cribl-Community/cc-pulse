import { QUICK, quickScope, resolveBound, validate, type TimeScope } from './timescope';

/** Quick Selections rail: three groups, no seconds, no All time. */
export const RAIL: { group: string; tokens: string[] }[] = [
  { group: 'Minutes', tokens: ['-5m', '-15m', '-30m'] },
  { group: 'Hours', tokens: ['-1h', '-3h', '-6h', '-12h', '-24h'] },
  { group: 'Days', tokens: ['-2d'] },
];

/** A rail row's scope: that token to now, keeping the time zone. */
export const railScope = (token: string, tz: TimeScope['tz']): TimeScope => ({ earliest: token, latest: 'now', tz });

/** The tab a value belongs on: relative unless a bound is an absolute epoch. */
export const pickerTab = (s: TimeScope): 'relative' | 'range' => (/^\d+$/.test(s.earliest.trim()) || /^\d+$/.test(s.latest.trim()) ? 'range' : 'relative');

/** Validation of the Relative tab, with the reason assigned to the field it concerns. */
export function relativeErrors(earliest: string, latest: string, tz: TimeScope['tz'], nowS: number): { earliest?: string; latest?: string } {
  const reason = validate({ earliest, latest, tz }, nowS);
  if (!reason) return {};
  const bad = (v: string) => resolveBound(v, nowS, tz) === undefined;
  return (bad(latest) && !bad(earliest)) || reason === "End can't be in the future" ? { latest: reason } : { earliest: reason };
}

/** The quick range matching a scope exactly (ending now), or undefined for a custom range. */
export const activeQuick = (s: TimeScope): string | undefined => QUICK.find((q) => s.latest === 'now' && s.earliest === '-' + q);

/** A quick-range click: applies at once, keeping the time zone; never opens a picker. */
export const applyQuick = (q: string, scope: TimeScope, setScope: (s: TimeScope) => void): void => setScope(quickScope(q, scope.tz));

/** Wall-clock fields (month 1-12) as shown by the date fields. */
export interface Wall { year: number; month: number; day: number; hour: number; minute: number }

/** Wall-clock time in tz to epoch seconds. */
export function wallToEpoch(w: Wall, tz: TimeScope['tz']): number {
  const ms = tz === 'utc' ? Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute) : new Date(w.year, w.month - 1, w.day, w.hour, w.minute).getTime();
  return Math.floor(ms / 1000);
}

/** Epoch seconds to wall-clock fields in tz. */
export function epochToWall(t: number, tz: TimeScope['tz']): Wall {
  const d = new Date(t * 1000);
  return tz === 'utc'
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
    : { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

/** The ± choices of the Around tab, label and seconds. */
export const AROUND: [string, number][] = [['5m', 300], ['15m', 900], ['1h', 3600], ['6h', 21600], ['12h', 43200], ['24h', 86400]];

/** Around window [t−d, t+d] with the end clamped to now. */
export const aroundWindow = (t: number, d: number, nowS: number): { from: number; to: number } => ({ from: t - d, to: Math.min(t + d, nowS) });

/** An absolute scope of epoch-second strings. */
export const absoluteScope = (from: number, to: number, tz: TimeScope['tz']): TimeScope => ({ earliest: String(from), latest: String(to), tz });

/** Shared Apply validation for the absolute tabs: the reason, undefined when usable, null when nothing is picked yet. */
export function absoluteReason(w: { from: number; to: number } | null, tz: TimeScope['tz'], nowS: number): string | undefined | null {
  return w ? validate(absoluteScope(w.from, w.to, tz), nowS) : null;
}

/** Resolved zone for the footer: IANA name, short name (e.g. CET) and UTC offset. */
export function zoneInfo(tz: 'local' | 'utc', at: number = Date.now()) {
  if (tz === 'utc') return { iana: 'UTC', short: 'UTC', label: 'UTC', offset: 'UTC+00:00' };
  const iana = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const part = (loc: string, style: 'short' | 'longOffset') =>
    new Intl.DateTimeFormat(loc, { timeZone: iana, timeZoneName: style }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
  let short = part('en-US', 'short');
  if (/^GMT[+-]/.test(short)) { const b = part('en-GB', 'short'); if (b && !/^GMT[+-]/.test(b)) short = b; }
  const off = part('en-US', 'longOffset').replace('GMT', '');
  return { iana, short, label: `${iana} (${short})`, offset: 'UTC' + (off || '+00:00') };
}

