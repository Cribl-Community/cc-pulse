import type { Row } from './api';
import type { Override } from './deploy';
import { windowFor, type Window } from './maintenance';
import { LATE_RATIO, ruleTolerance, type AssetState } from './model';
import type { Learning } from './settings';

/* T3: an override or maintenance change shows on screen at once, with no entity search. The rows held in state.tsx
   are patched in memory with the same state chain the entity KQL uses (kql.ts: tolerance_s, raw_state, signal,
   state), from each row's own fields. Pulse's saved searches pick the change up from the lookups in their next
   cycle (within 5 minutes). Pure: no React, no fetch. */

export type OverrideChange = Override | { input: string; asset: string; remove: true };
/** A change applied on screen at `atS` (s), that a snapshot computed before `atS` does not include yet. */
export type PendingChange =
  | { kind: 'override'; change: OverrideChange; atS: number }
  | { kind: 'windows'; windows: Window[]; overrides: Override[]; atS: number };

export const NEXT_CYCLE = "Pulse's alerts pick the change up in their next cycle (within 5 minutes).";

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const missingVal = (v: unknown) => v === null || v === undefined || v === '';

/** An override row the KQL treats as on: an action, and no `until` in the past. */
const isOn = (o: Override | undefined, nowMs: number): o is Override =>
  !!o && !!o.action && (!o.until || !(Date.parse(o.until) <= nowMs));

/** Overrides are keyed by input + asset (pulse_overrides.csv has no worker group): one change hits every such row. */
export const covers = (r: Row, k: { input: string; asset: string }) => str(r.input) === k.input && str(r.asset) === k.asset;

/** The entity KQL state chain for one row, given the override that is on for it now (if any). The row's own
 *  raw_state and signal are kept when its tolerance does not change (they were computed from the exact silence). */
export function stateOf(r: Row, L: Learning, o: Override | undefined, nowMs: number): Row {
  const ov = isOn(o, nowMs) ? o : undefined;
  const ruleTol = ruleTolerance(num(r.expected_gap_s), L);
  const tol = ov?.action === 'threshold' && num(ov.max_gap_s) > 0 ? num(ov.max_gap_s) : ruleTol;
  const same = !missingVal(r.tolerance_s) && num(r.tolerance_s) === tol && !missingVal(r.raw_state);
  const silent = num(r.silent_min) * 60;
  const raw: AssetState = same ? (str(r.raw_state) as AssetState)
    : num(r.active_min) < L.LEARN_MIN ? 'learning' : silent > tol ? 'missing' : silent > LATE_RATIO * tol ? 'late' : 'ok';
  const signal = same ? str(r.signal)
    : num(r.min_lag_s) < -L.FUTURE_S ? 'clock_skew' : num(r.lag_now_s) > L.LAG_MAX ? 'delayed'
      : raw === 'ok' && !missingVal(r.vol_ratio) && num(r.vol_ratio) < L.VOL_MIN ? 'low_volume' : '';
  const state: AssetState = str(r.maintenance) ? 'maintenance'
    : ov?.action === 'mute' ? 'muted'
      : ov?.action === 'ack' && (raw === 'missing' || raw === 'late') && num(r.last_seen) <= num(ov.ack_seen) + 1 ? 'acked'
        : raw === 'ok' && signal === 'delayed' ? 'delayed' : raw;
  return { ...r, tolerance_s: tol, raw_state: raw, signal, state };
}

/** setOverride succeeded: ack → acked, mute → muted, unmute / reset (remove) → the learned rule from the row's own
 *  fields, threshold → the new tolerance and the state it implies. Rows it doesn't cover are returned as they are. */
export function applyOverride(rows: Row[], change: OverrideChange, L: Learning, nowMs: number): Row[] {
  const o = 'remove' in change ? undefined : change;
  return rows.map((r) => (covers(r, change) ? stateOf(r, L, o, nowMs) : r));
}

/** Maintenance windows saved: each row takes the window covering it now (most specific scope first, as in the KQL),
 *  or none. A row whose window did not change is returned as it is; the others re-run the chain with their override. */
export function applyWindows(rows: Row[], windows: Window[], overrides: Override[], L: Learning, nowMs: number): Row[] {
  const t = Math.floor(nowMs / 1000);
  return rows.map((r) => {
    const w = windowFor(windows, { group: str(r.worker_group), input: str(r.input) }, t);
    const m = w ? w.reason || 'maintenance' : '';
    if (m === str(r.maintenance)) return r;
    return stateOf({ ...r, maintenance: m }, L, overrides.find((o) => covers(r, o)), nowMs);
  });
}

/** Rows from a snapshot computed at `asOfS` (s): changes applied after it are re-applied on top, so an older snapshot
 *  never brings the old state back. Changes the snapshot already includes (atS <= asOfS) are dropped. */
export function reapplyPending(rows: Row[], pending: PendingChange[], asOfS: number, L: Learning, nowMs: number) {
  const keep = pending.filter((p) => p.atS > asOfS);
  const out = keep.reduce((acc, p) => (p.kind === 'override' ? applyOverride(acc, p.change, L, nowMs) : applyWindows(acc, p.windows, p.overrides, L, nowMs)), rows);
  return { rows: out, pending: keep };
}
