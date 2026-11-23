/* Spec 016: the plan engine behind PlanRunner — pure (no React), so the gate can drive it against a fake Cribl.
   A failed step stops the plan; the caller can then retry it, skip it and carry on, or restart from step 1. */
import { ApiError } from './api';
import type { Step } from './deploy';

export type Status = 'pending' | 'running' | 'done' | 'failed' | 'skipped';
export type StepState = { s: Status; msg?: string; log?: string };
export type PlanState = Record<string, StepState>;

/** The first skipped or failed step that `st` needs, if any. Unknown ids are ignored, so a shared step (the route) can
 *  need a step that only the full plan has (the destination). */
export const blockedBy = (st: Step, steps: Step[], state: PlanState) =>
  steps.find((d) => st.needs?.includes(d.id) && (state[d.id]?.s === 'skipped' || state[d.id]?.s === 'failed'));

/** The state of the steps before index `i`, as the next run starts from it. */
export const stateBefore = (steps: Step[], state: PlanState, i: number): PlanState =>
  Object.fromEntries(steps.slice(0, i).flatMap((st) => (state[st.id] ? [[st.id, state[st.id]]] : [])));

/** Run steps[from..] on top of `seed`. Returns the index of the step that failed, or -1 when the plan got to the end. */
export async function runSteps(steps: Step[], from: number, seed: PlanState, onChange: (s: PlanState) => void): Promise<{ failedAt: number; state: PlanState }> {
  const state: PlanState = { ...seed };
  const put = (id: string, v: StepState) => { state[id] = v; onChange({ ...state }); };
  for (let i = from; i < steps.length; i++) {
    const st = steps[i];
    const dep = blockedBy(st, steps, state);
    if (dep) { put(st.id, { s: 'skipped', msg: `skipped: needs “${dep.title}”` }); continue; }
    put(st.id, { s: 'running' });
    try { put(st.id, { s: 'done', msg: await st.run() }); }
    catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const log = `Step ${st.id}: ${st.title}\n${new Date().toISOString()}\n\n` +
        (e instanceof ApiError ? e.detail : e instanceof Error ? (e.stack ?? msg) : msg);
      put(st.id, { s: 'failed', msg, log });
      return { failedAt: i, state };
    }
  }
  return { failedAt: -1, state };
}

/** Retry: run again from the failed step. */
export const retryFrom = (steps: Step[], state: PlanState, failedAt: number, onChange: (s: PlanState) => void) =>
  runSteps(steps, failedAt, stateBefore(steps, state, failedAt), onChange);

/** Skip: mark the failed step skipped (its error kept) and carry on with the next one. */
export function skipFrom(steps: Step[], state: PlanState, failedAt: number, onChange: (s: PlanState) => void) {
  const st = steps[failedAt];
  const seed = { ...stateBefore(steps, state, failedAt), [st.id]: { ...state[st.id], s: 'skipped' as const, msg: `skipped after an error: ${state[st.id]?.msg ?? ''}` } };
  return runSteps(steps, failedAt + 1, seed, onChange);
}

/** Restart: every step again, from step 1. */
export const restart = (steps: Step[], onChange: (s: PlanState) => void) => runSteps(steps, 0, {}, onChange);

const failState = (st: Step, e: unknown): StepState => {
  const msg = e instanceof Error ? e.message : String(e);
  const log = `Step ${st.id}: ${st.title}\n${new Date().toISOString()}\n\n` +
    (e instanceof ApiError ? e.detail : e instanceof Error ? (e.stack ?? msg) : msg);
  return { s: 'failed', msg, log };
};

/** Runs every step. A failed step is marked failed and the run carries on; blocked steps are skipped. */
export async function runAll(steps: Step[], seed: PlanState, onChange: (s: PlanState) => void): Promise<{ failed: string[]; state: PlanState }> {
  const state: PlanState = { ...seed };
  const failed: string[] = [];
  const put = (id: string, v: StepState) => { state[id] = v; onChange({ ...state }); };
  for (const st of steps) {
    const dep = blockedBy(st, steps, state);
    if (dep) { put(st.id, { s: 'skipped', msg: `skipped: needs “${dep.title}”` }); continue; }
    put(st.id, { s: 'running' });
    try { put(st.id, { s: 'done', msg: await st.run() }); }
    catch (e) { put(st.id, failState(st, e)); failed.push(st.id); }
  }
  return { failed, state };
}

const lanePrefix = (lane: string) => `${lane}/`;

/** Re-runs failed and skipped steps in one lane; done steps of that lane are not run again. */
export async function retryLane(steps: Step[], state: PlanState, lane: string, onChange: (s: PlanState) => void): Promise<{ failed: string[]; state: PlanState }> {
  const next: PlanState = { ...state };
  const failed: string[] = [];
  const put = (id: string, v: StepState) => { next[id] = v; onChange({ ...next }); };
  const prefix = lanePrefix(lane);
  for (const st of steps) {
    if (!st.id.startsWith(prefix)) continue;
    const cur = next[st.id]?.s;
    if (cur === 'done') continue;
    if (cur !== 'failed' && cur !== 'skipped') continue;
    const dep = blockedBy(st, steps, next);
    if (dep) { put(st.id, { s: 'skipped', msg: `skipped: needs “${dep.title}”` }); continue; }
    put(st.id, { s: 'running' });
    try { put(st.id, { s: 'done', msg: await st.run() }); }
    catch (e) { put(st.id, failState(st, e)); failed.push(st.id); }
  }
  return { failed, state: next };
}

/** Marks every not-done step in the lane skipped; runs nothing. */
export function skipLane(steps: Step[], state: PlanState, lane: string, onChange: (s: PlanState) => void): PlanState {
  const next: PlanState = { ...state };
  const prefix = lanePrefix(lane);
  for (const st of steps) {
    if (!st.id.startsWith(prefix)) continue;
    const cur = next[st.id]?.s;
    if (cur === 'done') continue;
    const prev = next[st.id];
    const msg = cur === 'failed' ? `skipped after an error: ${prev?.msg ?? ''}` : `skipped: ${st.title}`;
    next[st.id] = { ...prev, s: 'skipped', msg };
    onChange({ ...next });
  }
  return next;
}
