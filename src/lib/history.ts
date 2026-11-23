import type { Row } from './api';
import type { Win } from './timescope';
import { entityKey, isLive, type Entity } from './model';

/* Availability, incidents and flapping (spec 009), derived from the gap ledger (kql.ts gapsQuery): every silence
   longer than 2 min per entity. Nothing is stored — history is recomputed from the heartbeat each time, with each
   asset's own learned tolerance, so changing a threshold also changes what history "would have alerted". */
export type Gap = { start: number; end: number; secs: number };
export type Ledger = Record<string, Gap[]>;
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);

export function toLedger(rows: Row[]): Ledger {
  const out: Ledger = {};
  for (const r of rows) (out[entityKey(String(r.worker_group), String(r.input), String(r.asset))] ??= []).push({ start: n(r.gap_start), end: n(r.gap_end), secs: n(r.gap_s) });
  for (const k in out) out[k].sort((a, b) => a.start - b.start);
  return out;
}

export type Health = { availability: number; downtime_s: number; incidents: number; longest_s: number };
const nowSec = () => Date.now() / 1000;

/** A silence's over-tolerance part [start+tol, end] clipped to win; undefined when it does not overlap. */
function clip(start: number, end: number, tol: number, win: Win): [number, number] | undefined {
  const a = Math.max(start + tol, win.from), b = Math.min(end, win.to);
  return b > a ? [a, b] : undefined;
}

/** The over-tolerance silences of an asset as [start, end, secs]; the ongoing one ends at nowS. */
const silences = (e: Entity, gaps: Gap[], tol: number, nowS: number) => {
  const l: [number, number, number, boolean][] = gaps.filter((g) => g.secs > tol).map((g): [number, number, number, boolean] => [g.start, g.end, g.secs, false]);
  if (e.raw === 'missing') l.push([e.last_seen, nowS, e.silent_s, true]);
  return l;
};

/** Share of the window the asset was within its tolerance. The ongoing silence counts too. */
export function healthOf(e: Entity, gaps: Gap[] = [], win: Win, nowS: number = nowSec()): Health {
  const tol = e.tolerance_s || 300;
  let down = 0, inc = 0, longest = 0;
  for (const [from, to, secs] of silences(e, gaps, tol, nowS)) {
    const c = clip(from, to, tol, win);
    if (c) { down += c[1] - c[0]; inc += 1; longest = Math.max(longest, secs); }
  }
  const span = win.to - win.from;
  const availability = span > 0 ? Math.min(1, Math.max(0, 1 - down / span)) : 1;
  return { availability, downtime_s: down, incidents: inc, longest_s: longest };
}

/** Fleet availability: average over assets that should be reporting. */
export function fleetAvailability(fleet: Entity[], ledger: Ledger, win: Win, nowS: number = nowSec()) {
  const live = fleet.filter(isLive);
  if (!live.length) return undefined;
  return live.reduce((s, e) => s + healthOf(e, ledger[e.key], win, nowS).availability, 0) / live.length;
}

/* ---------- incident feed ---------- */
export type Incident = { id: string; start: number; end?: number; secs: number; entities: Entity[]; ongoing: boolean };
const TOGETHER_S = 120;
/** Every silence that went past tolerance, newest first. Silences that began within 2 min on the same source merge
 *  into one incident: that is how a shared cause shows up. */
export function incidentsOf(fleet: Entity[], ledger: Ledger, win: Win, nowS: number = nowSec()): Incident[] {
  const raw: { e: Entity; start: number; end?: number; secs: number }[] = [];
  for (const e of fleet) {
    if (!isLive(e) && e.state !== 'maintenance') continue;
    const tol = e.tolerance_s || 300;
    for (const [start, end, secs, live] of silences(e, ledger[e.key] ?? [], tol, nowS)) if (clip(start, end, tol, win)) raw.push({ e, start, end: live ? undefined : end, secs });
  }
  raw.sort((a, b) => a.start - b.start);
  const out: Incident[] = [];
  for (const r of raw) {
    const hit = out.find((i) => i.entities[0].group === r.e.group && i.entities[0].input === r.e.input && Math.abs(i.start - r.start) <= TOGETHER_S && !!i.end === !!r.end);
    if (hit && !hit.entities.some((x) => x.key === r.e.key)) { hit.entities.push(r.e); hit.secs = Math.max(hit.secs, r.secs); if (r.end) hit.end = Math.max(hit.end ?? 0, r.end); }
    else out.push({ id: `${r.e.key}@${r.start}`, start: r.start, end: r.end, secs: r.secs, entities: [r.e], ongoing: !r.end });
  }
  return out.sort((a, b) => (b.end ?? Infinity) - (a.end ?? Infinity) || b.start - a.start);
}

/** Flapping: assets that crossed their tolerance 3+ times in the window — usually a threshold that is too tight. */
export const flappers = (fleet: Entity[], ledger: Ledger, win: Win) =>
  fleet.map((e) => { const tol = e.tolerance_s || 300; return { e, n: (ledger[e.key] ?? []).filter((g) => g.secs > tol && clip(g.start, g.end, tol, win)).length }; }).filter((x) => x.n >= 3).sort((a, b) => b.n - a.n);
