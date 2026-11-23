/* Confirmation copy and lane phases for a fleet run. Type imports only: this module must not load api.ts. */
import type { Step } from './deploy';
import type { Lane, Target } from './fleetPlan';
import type { PlanState } from './plan';

export type ConfirmRow = { where: string; text: string };

const SEP = ' \u00b7 ';

const versionIn = (title: string) => {
  const found = title.match(/\d+\.\d+\.\d+/g);
  return found ? found[found.length - 1] : '';
};

const lookupTail = (id: string) => id.endsWith('/lookup') || id.endsWith('/assets') || id.endsWith('/maint');

/** One row per lane that has steps: what a confirm modal names before anything is written. */
export function confirmRows(lanes: readonly Lane[], targets: readonly Target[], destination: string): ConfirmRow[] {
  const rows: ConfirmRow[] = [];
  for (const lane of lanes) {
    if (!lane.steps.length) continue;
    if (lane.id === 'search') {
      const n = lane.steps.filter((s) => s.title.startsWith('Saved search')).length;
      const m = lane.steps.filter((s) => lookupTail(s.id)).length;
      rows.push({
        where: 'Cribl Search',
        text: `${n} saved searches and their notifications overwritten, ${m} lookups republished`,
      });
      continue;
    }
    if (lane.id === 'shared') {
      // Step titles are `Lake dataset <name>` (deploy.ts): the raw dataset and its <name>_5m rollup.
      const named = (id: string) => {
        const found = lane.steps.find((s) => s.id === id || s.id.endsWith(`/${id}`));
        return found ? found.title.replace(/^Lake dataset\s+/, '') : '';
      };
      const raw = named('dataset');
      const rollup = named('dataset5m');
      const parts: string[] = [];
      if (raw) parts.push(`Lake dataset ${raw} created if missing`);
      if (rollup) parts.push(`5-minute rollup dataset ${rollup} created if missing`);
      rows.push({ where: lane.title || 'Storage', text: parts.join(SEP) });
      continue;
    }
    const target = targets.find((t) => t.group === lane.id);
    const parts: string[] = [];
    for (const step of lane.steps) {
      if (step.id.endsWith('/pack')) {
        const version = versionIn(step.title);
        parts.push(target?.installed
          ? `pack cribl-pulse ${target.installed} \u2192 ${version}`
          : `pack cribl-pulse ${version} installed`);
      } else if (step.id.endsWith('/dest')) {
        parts.push(`destination ${destination} created or updated`);
      } else if (step.id.endsWith('/route')) {
        const scope = target?.mode === 'all' ? 'all sources' : `${target?.inputs.length ?? 0} sources`;
        parts.push(`route pulse_observer added or overwritten (${scope})`);
      }
    }
    rows.push({ where: lane.title || lane.id, text: parts.join(SEP) });
  }
  return rows;
}

const laneStepIds = (lane: Lane, steps: readonly Step[]) => {
  const prefixed = steps.filter((s) => s.id.startsWith(`${lane.id}/`)).map((s) => s.id);
  return prefixed.length ? prefixed : lane.steps.map((s) => s.id);
};

/** Skipped by the runner because a needed step did not finish. Skip lane writes a different message. */
const heldFor = (st: { s?: string; msg?: string } | undefined) =>
  st?.s === 'skipped' && (st.msg ?? '').startsWith('skipped: needs');

function phaseOf(lane: Lane, steps: readonly Step[], status: PlanState): 'unchanged' | 'running' | 'failed' | 'skipped' | 'done' | 'idle' {
  if (lane.unchanged) return 'unchanged';
  const ids = laneStepIds(lane, steps);
  const sts = ids.map((id) => status[id]);
  if (sts.some((s) => s?.s === 'running')) return 'running';
  // A failed Lake step skips this group's dest and route without failing a step of its own.
  // That lane stays failed so Retry can finish it after the dataset exists. A user Skip does not.
  if (sts.some((s) => s?.s === 'failed' || heldFor(s))) return 'failed';
  if (sts.some((s) => s?.s === 'skipped')) return 'skipped';
  if (ids.length > 0 && sts.every((s) => s?.s === 'done')) return 'done';
  return 'idle';
}

/**
 * True once no lane of the run is running or failed: every lane is done, skipped, unchanged, or idle.
 * Nothing is left to Retry, so the lane phases can go and each row shows the rebuilt plan instead.
 */
export function runEnded(lanes: readonly Lane[], steps: readonly Step[], status: PlanState): boolean {
  return lanes.every((lane) => {
    const phase = phaseOf(lane, steps, status);
    return phase !== 'running' && phase !== 'failed';
  });
}

/** One view per lane. `retry` and `skip` are offered only while that lane is failed. */
export function laneViews(lanes: readonly Lane[], steps: readonly Step[], status: PlanState) {
  return lanes.map((lane) => {
    const phase = phaseOf(lane, steps, status);
    const failed = phase === 'failed';
    return {
      id: lane.id,
      name: lane.id === 'search' ? 'search' : lane.id,
      phase,
      retry: failed,
      skip: failed,
    };
  });
}
