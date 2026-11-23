// Spec 014 §1 — the TimeScope model. Pure: no React, no fetch, no IO.
// A scope is what the user picked (strings, as they appear in the URL); a Win is that scope resolved to epoch seconds.

export type Tz = 'local' | 'utc';
export interface TimeScope { earliest: string; latest: string; tz: Tz }
export interface Win { from: number; to: number }

/** The longest range Pulse queries: 48 hours. */
export const MAX_SPAN_S = 172800;
/** How far past "now" an end may sit (clock skew). */
const FUTURE_SLACK_S = 60;

export const DEFAULT_SCOPE: TimeScope = { earliest: '-24h', latest: 'now', tz: 'local' };

export const QUICK = ['1h', '6h', '24h', '48h'] as const;
export type Quick = (typeof QUICK)[number];

/** A quick range ending now, keeping the current time zone. */
export function quickScope(q: Quick | string, tz: Tz = 'local'): TimeScope {
  return { earliest: `-${q}`, latest: 'now', tz };
}

const UNIT_S: Record<string, number> = { m: 60, h: 3600, d: 86400 };
const REL = /^(now|-(\d+)([mhd]))?(?:@([mhd]))?$/;
const ABS = /^\d+$/;

/** Rounds `t` down to the start of its minute, hour or day in `tz`. */
function snap(t: number, unit: string, tz: Tz): number {
  if (unit === 'm') return Math.floor(t / 60) * 60;
  if (tz === 'utc') return Math.floor(t / UNIT_S[unit]) * UNIT_S[unit];
  const d = new Date(t * 1000);
  if (unit === 'h') d.setMinutes(0, 0, 0);
  else d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

/** Resolves one bound (`now`, `-6h`, `-1h@h`, `@d`, `1762600000`) to epoch seconds, or undefined when it can't be parsed. */
export function resolveBound(v: string, nowS: number, tz: Tz): number | undefined {
  const s = String(v ?? '').trim();
  if (ABS.test(s)) return Number(s);
  if (!s) return undefined;
  const m = REL.exec(s);
  if (!m) return undefined;
  let t = Math.floor(nowS);
  if (m[2] !== undefined) t -= Number(m[2]) * UNIT_S[m[3]];
  if (m[4]) t = snap(t, m[4], tz);
  return t;
}

/** Resolves a scope to a window, or undefined when either bound can't be parsed. */
export function resolve(scope: TimeScope, nowS: number): Win | undefined {
  const from = resolveBound(scope.earliest, nowS, scope.tz);
  const to = resolveBound(scope.latest, nowS, scope.tz);
  return from === undefined || to === undefined ? undefined : { from, to };
}

/** undefined when the scope is usable, otherwise the reason it isn't. */
export function validate(scope: TimeScope, nowS: number): string | undefined {
  if (scope.tz !== 'local' && scope.tz !== 'utc') return 'Unknown time zone';
  const w = resolve(scope, nowS);
  if (!w) return 'Enter a valid time, like -6h, now or an epoch';
  if (w.from >= w.to) return 'Start must be before end';
  if (w.to > nowS + FUTURE_SLACK_S) return "End can't be in the future";
  if (w.to - w.from > MAX_SPAN_S) return 'Ranges are limited to 48 hours';
  return undefined;
}

/** The period of the same length immediately before `win`. */
export function previous(win: Win): Win {
  return { from: 2 * win.from - win.to, to: win.from };
}

const LADDER = [60, 120, 300, 600, 900, 1800, 3600];
const spanOf = (w: Win | number) => (typeof w === 'number' ? w : w.to - w.from);
function pick(w: Win | number, budget: number): number {
  const s = Math.max(0, spanOf(w));
  return LADDER.find((b) => Math.ceil(s / b) <= budget) ?? LADDER[LADDER.length - 1];
}
/** Bin span for the fleet heartbeat: at most 300 bins. Takes a window or its length in seconds. */
export const heartbeatSpan = (w: Win | number): number => pick(w, 300);
/** Bin span for sparklines, swimlanes and asset activity: at most 48 bins. Takes a window or its length in seconds. */
export const sparkSpan = (w: Win | number): number => pick(w, 48);

/** YYYY-MM-DD HH:mm:ss for epoch seconds t in tz. Re-exported by lib/timefmt.ts, the app's one timestamp formatter module. */
export const formatTs = (t: number, tz: Tz): string =>
  new Date(t * 1000 - (tz === 'utc' ? 0 : new Date(t * 1000).getTimezoneOffset() * 60000)).toISOString().slice(0, 19).replace('T', ' ');

const UNIT_NAME: Record<string, string> = { m: 'minute', h: 'hour', d: 'day' };
/** 'Last 6 hours' for a relative range ending now, otherwise 'YYYY-MM-DD HH:mm:ss - YYYY-MM-DD HH:mm:ss' in the scope's tz. */
export function rangeLabel(scope: TimeScope, nowS: number): string {
  const m = /^-(\d+)([mhd])$/.exec(scope.earliest.trim());
  if (m && scope.latest.trim() === 'now') {
    const n = Number(m[1]);
    return `Last ${n} ${UNIT_NAME[m[2]]}${n === 1 ? '' : 's'}`;
  }
  const w = resolve(scope, nowS);
  if (!w) return `${scope.earliest} - ${scope.latest}`;
  return `${formatTs(w.from, scope.tz)} - ${formatTs(w.to, scope.tz)}`;
}

/** Short range phrase for labels: 'last 6 h' for a relative range ending now, otherwise 'in range'. */
export function rangePhrase(scope: TimeScope): string {
  const m = /^-(\d+)([mhd])$/.exec(scope.earliest.trim());
  return m && scope.latest.trim() === 'now' ? `last ${m[1]} ${m[2]}` : 'in range';
}

/** 'Incidents, last 6 h' or 'Incidents in range'. */
export function withRange(label: string, scope: TimeScope): string {
  const p = rangePhrase(scope);
  return p === 'in range' ? `${label} ${p}` : `${label}, ${p}`;
}

export interface Delta { text: string; dir: 'up' | 'down' | 'flat'; good: boolean }
/**
 * Change from `prev` to `cur`. `count` (incidents): signed integer %, fewer is good.
 * `ratio` (availability, 0..1): signed percentage points to one decimal, more is good. Flat is good.
 * undefined when there is nothing honest to compare (unknown prev, or a count against 0).
 */
export function delta(cur: number | undefined, prev: number | undefined, kind: 'count' | 'ratio'): Delta | undefined {
  if (typeof cur !== 'number' || typeof prev !== 'number' || !Number.isFinite(cur) || !Number.isFinite(prev)) return undefined;
  if (kind === 'count') {
    if (prev === 0) return undefined;
    const pct = Math.round(((cur - prev) / prev) * 100);
    if (pct === 0) return { text: '0%', dir: 'flat', good: true };
    return { text: `${pct > 0 ? '+' : '-'}${Math.abs(pct)}%`, dir: pct > 0 ? 'up' : 'down', good: pct < 0 };
  }
  const tenths = Math.round((cur - prev) * 1000);
  if (tenths === 0) return { text: '0.0 pp', dir: 'flat', good: true };
  return { text: `${tenths > 0 ? '+' : '-'}${(Math.abs(tenths) / 10).toFixed(1)} pp`, dir: tenths > 0 ? 'up' : 'down', good: tenths > 0 };
}

/** The comparison a delta is against, named by the window length (ranges cap at 48 h): 'vs previous 6 h', 'vs previous 30 min'. */
export function deltaHint(win: Win): string {
  const s = Math.max(0, Math.round(win.to - win.from));
  if (s >= 3600 && s % 3600 === 0) return `vs previous ${s / 3600} h`;
  if (s >= 3600) return `vs previous ${(s / 3600).toFixed(1)} h`;
  return `vs previous ${Math.max(1, Math.round(s / 60))} min`;
}

/** What the pages read from the pulse state to decide whether a delta is honest. */
export interface DeltaGate { histLoading?: boolean; ledger?: unknown; truncated?: { gaps?: boolean } }
/** true when the delta Tags must stay empty: no ledger yet, history still loading, or a truncated gap ledger. */
export function deltaHidden(p: DeltaGate): boolean {
  return !p.ledger || !!p.histLoading || !!p.truncated?.gaps;
}

/** Reads `?earliest=&latest=&tz=`. undefined when a bound is missing or invalid, or the range fails validation. */
export function fromParams(p: URLSearchParams, nowS: number = Date.now() / 1000): TimeScope | undefined {
  const earliest = p.get('earliest');
  const latest = p.get('latest');
  if (!earliest || !latest) return undefined;
  const tzRaw = p.get('tz');
  if (tzRaw !== null && tzRaw !== 'local' && tzRaw !== 'utc') return undefined;
  const scope: TimeScope = { earliest, latest, tz: tzRaw ?? 'local' };
  return validate(scope, nowS) === undefined ? scope : undefined;
}

/** Writes a scope as `?earliest=&latest=&tz=`. */
export function toParams(scope: TimeScope): URLSearchParams {
  return new URLSearchParams({ earliest: scope.earliest, latest: scope.latest, tz: scope.tz });
}
