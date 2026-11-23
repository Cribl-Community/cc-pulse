// Pure refresh helpers (spec 025 §1): no React, no fetch.
export const REFRESH_CHOICES = ['1m', '2m', '5m', '15m', 'manual'] as const;
export type RefreshChoice = (typeof REFRESH_CHOICES)[number];
export const DEFAULT_REFRESH: RefreshChoice = '5m';
export const GAPS_EVERY_S = 900;

const MS: Record<string, number> = { '1m': 60_000, '2m': 120_000, '5m': 300_000, '15m': 900_000 };

export function refreshMs(choice: string): number | undefined {
  return Object.prototype.hasOwnProperty.call(MS, choice) ? MS[choice] : undefined;
}

const stale = (choice: string, lastAt: number | undefined, nowMs: number): boolean => {
  const ms = refreshMs(choice);
  if (ms === undefined) return false;
  return lastAt === undefined || nowMs - lastAt >= ms;
};

export function tickDecision(a: { choice: string; hidden: boolean; inFlight: boolean; lastAt?: number; nowMs: number }): 'run' | 'skip' {
  if (a.hidden || a.inFlight) return 'skip';
  return stale(a.choice, a.lastAt, a.nowMs) ? 'run' : 'skip';
}

export function onVisible(a: { choice: string; lastAt?: number; nowMs: number }): boolean {
  return stale(a.choice, a.lastAt, a.nowMs);
}

export type HistoryTrigger = 'open' | 'tick' | 'timescope' | 'loadCharts';

/** Do the history queries (activity, fleet heartbeat, gaps) run for this trigger? When the cadence doesn't run them on
 *  a tick (daily), only loadCharts starts them; after that a TimeScope change re-runs them, a tick still doesn't. */
export function historyShouldRun(a: { historyOnTick: boolean; loaded: boolean; trigger: HistoryTrigger }): boolean {
  if (a.historyOnTick || a.trigger === 'loadCharts') return true;
  // 'open' with loaded: a page asked for the history (pageNeedsHistory) before the settings had landed.
  return (a.trigger === 'timescope' || a.trigger === 'open') && a.loaded;
}

/** Spec 033 §5: pages a user opens that read the history (Incidents, Assets, Asset) run its searches as today: opening
 *  the page is the ask. True when the cadence doesn't run history on its own (daily) and nothing has started it yet. */
export function pageNeedsHistory(a: { historyOnTick: boolean; loaded: boolean }): boolean {
  return !a.historyOnTick && !a.loaded;
}

export function pollDelay(attempt: number): number {
  return [250, 500, 1000][attempt] ?? 2000;
}

export function histDue(a: {
  job: string;
  rangeKey: string;
  live: boolean;
  last?: { at: number; rangeKey: string };
  nowS: number;
  span: number;
}): boolean {
  const { last } = a;
  if (!last || last.rangeKey !== a.rangeKey) return true;
  if (a.live === false) return false;
  if (a.job === 'activity' || a.job === 'heartbeat') return Math.floor(a.nowS / a.span) > Math.floor(last.at / a.span);
  if (a.job === 'gaps') return a.nowS - last.at >= GAPS_EVERY_S;
  return false;
}
