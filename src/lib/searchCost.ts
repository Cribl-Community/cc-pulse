// Measured cost of Pulse's own searches, from the Search jobs list. Pure: no fetch, no React.
export type SearchJob = Record<string, unknown>;

const DAY_MS = 24 * 3600 * 1000;
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** CPU seconds of one job, or undefined when the job carries no CPU figure. */
export function jobCpuSeconds(j: SearchJob): number | undefined {
  const st = obj(j.stats);
  return num(j.cpuSeconds) ?? num(st.cpuSeconds) ?? num(j.cpuTime) ?? num(st.cpuTime);
}

function startedMs(j: SearchJob): number | undefined {
  return num(j.timeStarted) ?? num(j.timeCreated) ?? num(j.startTime);
}

/** A Pulse job: named pulse_*, or started by the app (its query reads the Pulse dataset or its _5m rollup). */
export function isPulseJob(j: SearchJob, dataset = ''): boolean {
  if ([j.savedQueryId, j.name, j.jobName].some((n) => str(n).startsWith('pulse_'))) return true;
  const q = str(j.query);
  return !!dataset && (q.includes(`dataset="${dataset}"`) || q.includes(`dataset="${dataset}_5m"`) || q.includes(`dataset='${dataset}'`) || q.includes(`dataset='${dataset}_5m'`));
}

/** CPU-hours used by Pulse jobs started in the last 24 h. null when no such job has a CPU figure. */
export function pulseCpuHours(jobs: SearchJob[], now: number, dataset = ''): number | null {
  let sec = 0;
  let seen = false;
  for (const j of jobs) {
    if (!isPulseJob(j, dataset)) continue;
    const t = startedMs(j);
    if (t === undefined || t < now - DAY_MS || t > now) continue;
    const c = jobCpuSeconds(j);
    if (c === undefined) continue;
    sec += c;
    seen = true;
  }
  return seen ? sec / 3600 : null;
}

export const costLine = (hours: number | null): string | null =>
  hours === null ? null : `Pulse searches used ${hours.toFixed(1)} CPU-hours over the last 24 h`;
