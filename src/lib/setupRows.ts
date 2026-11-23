// Pure row model for the Setup fleet table and its summary (spec 039). No React, no DOM.
import { PACK_VERSION, type Deployment } from './deploy';
import { fleetPlan, type Target } from './fleetPlan';
import { packInputKey } from './packSources';
import { DEFAULT_SETTINGS, type AppSettings } from './settings';
import type { FleetData, FleetGroup, FleetSource } from './demo';

export type Choices = {
  /** Selected group keys (the table's selection). */
  selected: string[];
  /** Per-group All / Pick. A group with no entry uses its own mode, then `newDefault`. */
  modes: Record<string, 'all' | 'pick'>;
  /** Per-group picked source ids (own and pack sources). A group with no entry uses the sources marked picked. */
  picks: Record<string, string[]>;
  newDefault: 'all' | 'pick';
  search: boolean;
};

export type Tone = 'warning' | 'success' | 'neutral';
export type Row = {
  key: string;
  name: string;
  workers: number;
  selectable: boolean;
  selected: boolean;
  pulse: { label: string; tone: Tone };
  mode: 'all' | 'pick';
  sources: string;
  watched: number;
  total: number;
  volume: string;
  cpu: string;
  actions: string[];
};
export type Summary = { groups: number; sources: number; alerts: boolean; cpu: number; text: string; steps: number };

/** Worker CPU estimate: 0.04 core per 10k ev/s. */
export const CPU_PER_EVS = 0.04 / 10000;

const all = (g: FleetGroup): FleetSource[] => [...g.sources, ...g.packSources];
const inputKey = (s: FleetSource) => (s.pack ? packInputKey(s.type, s.pack, s.id) : `${s.type}:${s.id}`);

export const formatVolume = (n: number) => {
  const r = Math.round(n);
  if (r < 1000) return `${r} ev/s`;
  const k = Math.round(r / 100) / 10;
  return `${k}k ev/s`;
};
export const formatCpu = (n: number) => {
  if (n > 0 && (n.toFixed(2) === '0.00' || n < 0.01)) return '< 0.01 core';
  return `~${n.toFixed(2)} core`;
};

export function summaryLine(args: { groups: number; sources: number; alerts: boolean; cpu: number }): string {
  const { groups, sources, alerts, cpu } = args;
  return `${groups} worker groups · ${sources} sources${alerts ? ' · alerts' : ''} · ~${cpu.toFixed(2)} core of worker CPU in total`;
}

const tickablePackSource = (s: FleetSource) => !s.locked && !s.staysInPack && s.reach !== 'no';
const ownInputsCount = (sources: FleetSource[]) => sources.filter((s) => !s.locked).length;
const tickablePackCountFrom = (packSources: FleetSource[]) => packSources.filter(tickablePackSource).length;

/** Source count for one deployable group (summary only — row labels keep full list size). */
export function watchedSourceCount(args: {
  mode: 'all' | 'pick';
  pickCount?: number;
  ownInputs: number;
  /** Classified tickable pack sources, or null/undefined when pack sources were never opened. */
  tickablePack?: number | null;
}): number {
  if (args.mode === 'pick') return args.pickCount ?? 0;
  return args.ownInputs + (args.tickablePack == null ? 0 : args.tickablePack);
}

/** The choices that match what the fleet data already says. */
export function defaultChoices(fleet: FleetData): Choices {
  return {
    selected: fleet.groups.filter((g) => g.selected && g.workers > 0).map((g) => g.id),
    modes: Object.fromEntries(fleet.groups.map((g) => [g.id, g.mode === 'all' ? 'all' : 'pick'])),
    picks: Object.fromEntries(fleet.groups.map((g) => [g.id, all(g).filter((s) => s.picked).map((s) => s.id)])),
    newDefault: 'all',
    search: true,
  };
}

const modeOf = (g: FleetGroup, c: Choices): 'all' | 'pick' => c.modes[g.id] ?? (g.mode ? (g.mode === 'all' ? 'all' : 'pick') : c.newDefault);
const watchedOf = (g: FleetGroup, c: Choices): FleetSource[] => {
  if (modeOf(g, c) === 'all') return all(g);
  const ids = new Set(c.picks[g.id] ?? all(g).filter((s) => s.picked).map((s) => s.id));
  return all(g).filter((s) => ids.has(s.id));
};

const watchedEvs = (g: FleetGroup, c: Choices): number => {
  if (modeOf(g, c) === 'pick') return watchedOf(g, c).reduce((n, s) => n + s.evs, 0);
  const own = g.sources.filter((s) => !s.locked).reduce((n, s) => n + s.evs, 0);
  const pack = g.packSources.filter(tickablePackSource).reduce((n, s) => n + s.evs, 0);
  return own + pack;
};

const summarySourcesOf = (g: FleetGroup, c: Choices): number => {
  const mode = modeOf(g, c);
  if (mode === 'pick') return watchedOf(g, c).length;
  return watchedSourceCount({
    mode: 'all',
    ownInputs: ownInputsCount(g.sources),
    tickablePack: tickablePackCountFrom(g.packSources),
  });
};

const targetOf = (g: FleetGroup, c: Choices): Target => {
  const pick = modeOf(g, c) === 'pick';
  const inputs = pick ? watchedOf(g, c).map(inputKey) : [];
  let prev: Deployment | null = null;
  if (g.pulse === PACK_VERSION) {
    const was = g.mode === 'all' ? [] : all(g).filter((s) => s.picked).map(inputKey);
    prev = { group: g.id, inputs: was, filter: '', at: '', pack: PACK_VERSION };
  }
  return { group: g.id, mode: pick ? 'selected' : 'all', inputs, prev, installed: g.pulse };
};

const actionsFor = (g: FleetGroup, c: Choices, settings: AppSettings): string[] => {
  const t = targetOf(g, c);
  if (t.mode === 'selected' && t.inputs.length === 0) return ['pick at least one source'];
  const { lanes } = fleetPlan([t], settings, { alerts: false, enabled: true });
  const lane = lanes.find((l) => l.id === g.id);
  if (!lane || lane.unchanged) return ['up to date'];
  const ids = new Set(lane.steps.map((s) => s.id.split('/').pop()));
  const out: string[] = [];
  if (ids.has('pack')) out.push(g.pulse ? `upgrade pack → ${PACK_VERSION}` : `install pack ${PACK_VERSION}`);
  if (ids.has('dest')) out.push('destination');
  if (ids.has('route')) {
    const added = ids.has('pack') || !t.prev ? 0 : t.inputs.filter((i) => !t.prev!.inputs.includes(i)).length;
    out.push(added > 0 ? `route +${added}` : 'route');
  }
  if (ids.has('commit')) out.push('commit + deploy');
  return out;
};

const pulseTag = (g: FleetGroup): { label: string; tone: Tone } =>
  !g.pulse ? { label: 'not installed', tone: 'neutral' }
  : g.pulse === PACK_VERSION ? { label: `Pulse ${g.pulse}`, tone: 'success' }
  : { label: `Pulse ${g.pulse} · update`, tone: 'warning' };

export function buildRows(fleet: FleetData, c: Choices, settings: AppSettings = DEFAULT_SETTINGS): Row[] {
  return fleet.groups.map((g): Row => {
    const total = all(g).length;
    const mode = modeOf(g, c);
    const watched = watchedOf(g, c);
    const selectable = g.workers > 0;
    const selected = selectable && c.selected.includes(g.id);
    const evs = watched.reduce((n, s) => n + s.evs, 0);
    return {
      key: g.id, name: g.id, workers: g.workers, selectable, selected, pulse: pulseTag(g), mode,
      sources: !selectable ? '—' : mode === 'all' ? `All sources (${total})` : `${watched.length} of ${total}`,
      watched: watched.length, total,
      volume: selectable ? formatVolume(evs) : '—',
      cpu: selectable ? formatCpu(evs * CPU_PER_EVS) : '—',
      actions: !selectable ? ['no workers — nothing to deploy to'] : !selected ? ['not in this deploy'] : actionsFor(g, c, settings),
    };
  });
}

/** The fleetPlan targets of the selected groups (what Show the plan and the confirmation list). */
export function demoTargets(fleet: FleetData, c: Choices): Target[] {
  return fleet.groups
    .filter((g) => g.workers > 0 && c.selected.includes(g.id))
    .filter((g) => modeOf(g, c) === 'all' || watchedOf(g, c).length > 0)
    .map((g) => targetOf(g, c));
}

export function buildSummary(fleet: FleetData, c: Choices, settings: AppSettings = DEFAULT_SETTINGS): Summary {
  const sel = fleet.groups.filter((g) => g.workers > 0 && c.selected.includes(g.id));
  const sources = sel.reduce((n, g) => n + summarySourcesOf(g, c), 0);
  const cpu = sel.reduce((n, g) => n + watchedEvs(g, c) * CPU_PER_EVS, 0);
  const targets = sel.filter((g) => modeOf(g, c) === 'all' || watchedOf(g, c).length > 0).map((g) => targetOf(g, c));
  const steps = fleetPlan(targets, settings, { alerts: c.search, enabled: true }).steps.length;
  const text = summaryLine({ groups: sel.length, sources, alerts: c.search, cpu });
  return { groups: sel.length, sources, alerts: c.search, cpu, text, steps };
}
