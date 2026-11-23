// Spec 033 §2: every number that follows the search cadence. Pure: no React, no fetch.
type Tz = 'local' | 'utc';

/** 'today' | 'yesterday' | short date ('Nov 19') for asOfS relative to nowS, by calendar day in tz. */
export function rollCallDay(asOfS: number, nowS: number, tz: Tz): string {
  const tzo = tz === 'utc' ? 'UTC' : undefined;
  const dayNum = (s: number): number => {
    const d = new Date(s * 1000);
    return tz === 'utc'
      ? Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86400000)
      : Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
  };
  const diff = dayNum(nowS) - dayNum(asOfS);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return new Date(asOfS * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: tzo });
}

export const LOADS =['standard', 'hourly', 'daily'] as const;
export type SearchLoad = (typeof LOADS)[number];
export type SavedId = 'pulse_rollup' | 'pulse_state' | 'pulse_ledger_asset' | 'pulse_ledger_source'
  | 'pulse_alert_missing' | 'pulse_alert_source_down' | 'pulse_source_digest' | 'pulse_roll_call';
export type Cadence = {
  load: SearchLoad;
  everyS: number;
  crons: Record<SavedId, string | null>;
  tz: string;
  runEvery: number;
  snapshotJob: 'pulse_state' | 'pulse_roll_call';
  snapshotMaxAgeS: number;
  snapshotEarliest: string;
  rollup: { earliest: string; maxLagS: number; tailS: number } | null;
  historyOnTick: boolean;
  runsPerDay: number;
};

/** 034's rule: a reader of pulse_state runs 2 minutes after it (same hour/day fields). */
export function readerCron(stateCron: string): string {
  const [min, ...rest] = stateCron.trim().split(/\s+/);
  let m = min;
  const step = /^(\*|\d+-59)\/(\d+)$/.exec(min);
  if (step) {
    const start = step[1] === '*' ? 0 : parseInt(step[1], 10);
    m = `${start + 2}-59/${step[2]}`;
  } else if (/^\d+$/.test(min)) m = String((parseInt(min, 10) + 2) % 60);
  return [m, ...rest].join(' ');
}

export function cadenceOf(load: SearchLoad, rollCall?: { hour: number; tz: string }): Cadence {
  const everyS = load === 'standard' ? 300 : load === 'hourly' ? 3600 : 86400;
  const h = rollCall?.hour ?? 6;
  const stateCron = load === 'standard' ? '*/5 * * * *' : '5 * * * *';
  const writers = readerCron(stateCron);
  const alerts = readerCron(writers);
  const crons: Record<SavedId, string | null> = load === 'daily'
    ? { pulse_rollup: null, pulse_state: null, pulse_ledger_asset: null, pulse_ledger_source: null, pulse_alert_missing: null,
        pulse_alert_source_down: null, pulse_source_digest: null, pulse_roll_call: `0 ${h} * * *` }
    : {
        pulse_rollup: load === 'standard' ? '3-59/5 * * * *' : '3 * * * *',
        pulse_state: stateCron,
        pulse_ledger_asset: writers,
        pulse_ledger_source: writers,
        pulse_alert_missing: alerts,
        pulse_alert_source_down: alerts,
        pulse_source_digest: load === 'standard' ? '7 * * * *' : `7 ${h} * * *`,
        pulse_roll_call: null,
      };
  const daily = load === 'daily';
  return {
    load,
    everyS,
    crons,
    tz: load === 'standard' ? 'UTC' : rollCall?.tz ?? 'UTC',
    runEvery: everyS + 60,
    snapshotJob: daily ? 'pulse_roll_call' : 'pulse_state',
    snapshotMaxAgeS: daily ? 86400 + 3600 : everyS + 600,
    snapshotEarliest: load === 'standard' ? '-1h' : load === 'hourly' ? '-2h' : '-26h',
    rollup: daily ? null : { earliest: `-${(2 * everyS + 600) / 60}m`, maxLagS: everyS + 1200, tailS: everyS + 1500 },
    historyOnTick: !daily,
    runsPerDay: load === 'standard' ? 1752 : load === 'hourly' ? 145 : 1,
  };
}

export const normalizeLoad = (v: unknown): SearchLoad =>
  (LOADS as readonly unknown[]).includes(v) ? (v as SearchLoad) : 'standard';

/** The load the installed schedules (savedStatus) are on, or null when they are unknown. */
export function installedLoad(status: { id: string; enabled: boolean; cron: string; exists: boolean }[]): SearchLoad | null {
  const by = (id: string) => status.find((x) => x.id === id);
  const rc = by('pulse_roll_call');
  if (rc?.exists && rc.enabled) return 'daily';
  const st = by('pulse_state');
  if (!st?.exists || !st.enabled) return null;
  const cron = st.cron.trim();
  if (cron === cadenceOf('standard').crons.pulse_state) return 'standard';
  if (cron === cadenceOf('hourly').crons.pulse_state) return 'hourly';
  return null;
}
