import {
  alertsPlan,
  deployPlan,
  routeOnly,
  routePlan,
  sourceDelta,
  type Deployment,
  type RollupContext,
  type Step,
} from './deploy';
import type { AppSettings } from './settings';

export type Target = {
  group: string;
  mode: 'all' | 'selected';
  inputs: string[];
  full?: boolean;
  prev?: Deployment | null;
  installed?: string;
};

export type FleetOpts = {
  alerts: boolean;
  enabled: boolean;
  rollupCtx?: RollupContext;
  link?: { origin?: string; base?: string };
};

export type Lane = { id: string; title: string; steps: Step[]; unchanged?: string };

const LAKE_IDS = new Set(['dataset', 'dataset5m']);
const INVALID_REASON = 'pick at least one source, or choose All';

const inputsFor = (t: Target) => (t.mode === 'all' ? [] : t.inputs);

const prefixStep = (step: Step, laneId: string, ids: Set<string>): Step => {
  const id = `${laneId}/${step.id}`;
  let needs = step.needs?.map((n) => `${laneId}/${n}`);
  if (step.id === 'dest') needs = ['shared/dataset'];
  else if (step.id === 'route') needs = [`${laneId}/pack`, `${laneId}/dest`];
  else if (step.id === 'commit') {
    // runAll keeps going after a failure. Commit has to wait for this lane's pack, destination,
    // and route, or a failed one is still committed and Retry records the group without that repair.
    const gate = ['pack', 'dest', 'route'].map((n) => `${laneId}/${n}`).filter((n) => ids.has(n));
    if (gate.length) needs = gate;
  }
  return { ...step, id, needs };
};

const prefixSteps = (steps: Step[], laneId: string): Step[] => {
  const ids = new Set(steps.map((s) => `${laneId}/${s.id}`));
  return steps.map((s) => prefixStep(s, laneId, ids));
};

const withoutLake = (steps: Step[]) => steps.filter((s) => !LAKE_IDS.has(s.id));

const groupPlan = (t: Target, s: AppSettings): Step[] | 'unchanged' => {
  const group = t.group;
  const inputs = inputsFor(t);
  const dataset = s.dataset;
  const destination = s.destination;
  if (t.full) return withoutLake(deployPlan(group, inputs, s));
  if (routeOnly(t.prev, t.installed, s, dataset, destination)) {
    if (sourceDelta(t.prev?.inputs, inputs).same) return 'unchanged';
    return routePlan(group, inputs, s);
  }
  return withoutLake(deployPlan(group, inputs, s));
};

const sharedLakeSteps = (s: AppSettings): Step[] =>
  prefixSteps(
    deployPlan('_', [], s).filter((x) => LAKE_IDS.has(x.id)),
    'shared',
  );

/** Builds the multi-group deploy plan: shared Lake, per-group lanes, optional Search. */
export function fleetPlan(
  targets: Target[],
  settings: AppSettings,
  opts: FleetOpts,
): { lanes: Lane[]; steps: Step[]; invalid: { group: string; reason: string }[] } {
  const invalid: { group: string; reason: string }[] = [];
  const groupLanes: Lane[] = [];
  let needShared = false;

  for (const t of targets) {
    if (t.mode === 'selected' && t.inputs.length === 0) {
      invalid.push({ group: t.group, reason: INVALID_REASON });
      continue;
    }
    const built = groupPlan(t, settings);
    if (built === 'unchanged') {
      groupLanes.push({ id: t.group, title: t.group, steps: [], unchanged: 'up to date' });
      continue;
    }
    const steps = prefixSteps(built, t.group);
    if (steps.some((x) => x.id.endsWith('/dest'))) needShared = true;
    groupLanes.push({ id: t.group, title: t.group, steps });
  }

  const searchLane: Lane | undefined = opts.alerts
    ? {
        id: 'search',
        title: 'Cribl Search',
        steps: alertsPlan(settings, opts.enabled, opts.rollupCtx, [], opts.link ?? {}).map((step) => ({
          ...step,
          id: `search/${step.id}`,
          needs: ['shared/dataset'],
        })),
      }
    : undefined;

  if (searchLane) needShared = true;

  const sharedLane: Lane = {
    id: 'shared',
    title: 'Storage',
    steps: needShared ? sharedLakeSteps(settings) : [],
  };

  const lanes = [sharedLane, ...groupLanes, ...(searchLane ? [searchLane] : [])];
  const steps = lanes.flatMap((l) => l.steps);
  return { lanes, steps, invalid };
}