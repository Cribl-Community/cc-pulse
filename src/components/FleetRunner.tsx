import { useState, type ReactNode } from 'react';
import { Alert, Button, Modal, Table, Text } from '@capra/core';
import type { Step } from '../lib/deploy';
import type { Lane } from '../lib/fleetPlan';
import { laneViews, runEnded } from '../lib/fleetRun';
import { cols, rowsOf, vis } from '../lib/table';
import { retryLane, runAll, skipLane, type PlanState } from '../lib/plan';

const CONFIRM_COLS = ['where', 'text'] as const;
const FAIL_BODY = 'A failed group stops on its own; the others carry on. Stream keeps every commit, so a group can be reverted from its commit history.';

/** Title for the deploy confirmation from lanes that actually have steps (not unticked / unchanged). */
function deployConfirmTitle(lanes: Lane[]): string {
  const groups = lanes.filter((l) => l.id !== 'search' && l.id !== 'shared' && l.steps.length > 0).length;
  const search = lanes.some((l) => l.id === 'search' && l.steps.length > 0);
  if (groups > 0 && search) {
    return `Deploy Pulse to ${groups} worker group${groups === 1 ? '' : 's'} and Cribl Search?`;
  }
  if (groups > 0) return `Deploy Pulse to ${groups} worker group${groups === 1 ? '' : 's'}?`;
  if (search) return 'Deploy Cribl Search?';
  return 'Deploy everything?';
}

type Views = ReturnType<typeof laneViews>;
type Actions = {
  retry: (laneId: string) => Promise<void>;
  skip: (laneId: string) => void;
  /** A run or a retry is in progress: start nothing else (Deploy everything, Retry, Skip) until it settles. */
  busy: boolean;
};

/** One confirmation for a fleet plan, then per-lane progress with Retry and Skip on a failed lane. */
export function FleetRunner({
  lanes, steps, rows, open, onClose, onDone, onSettle, onPhase, status: seed = {}, demo = false, children,
}: {
  /** Demo data: the confirmation shows a disabled Deploy and never runs anything. */
  demo?: boolean;
  lanes: Lane[];
  steps: Step[];
  rows: { where: string; text: string }[];
  open: boolean;
  onClose: () => void;
  onDone?: () => void;
  /** Rebuilds the plan after a run that left nothing to Retry. The lane phases clear once it resolves (kept if it rejects). */
  onSettle?: () => Promise<unknown>;
  onPhase?: (state: PlanState) => void;
  /** Initial plan state, so a lane that is already failed can offer Retry and Skip on the first render. */
  status?: PlanState;
  children: (views: Views, actions: Actions) => ReactNode;
}) {
  const [state, setState] = useState<PlanState>(seed);
  // Step functions from the confirmed run. refresh() after onDone rebuilds the steps prop.
  const [confirmed, setConfirmed] = useState<Step[] | null>(null);
  // True while a Deploy everything run or a lane retry is in progress.
  const [busy, setBusy] = useState(false);
  const views = laneViews(lanes, steps, state);
  const ran = confirmed ?? steps;

  const publish = (next: PlanState) => { setState(next); onPhase?.(next); };

  /**
   * After onDone. Once no lane is failed (nothing left to Retry) and onSettle has rebuilt the plan,
   * the lane phases go, so each row shows what the rebuilt plan says (up to date, pack, dest, route).
   * Only this run's final state is cleared: a run started meanwhile published a new object.
   */
  function settle(runLanes: Lane[], runSteps: Step[], final: PlanState) {
    setState(final);
    onDone?.();
    if (!runEnded(runLanes, runSteps, final)) return;
    void Promise.resolve(onSettle?.()).then(() => {
      setState((cur) => (cur === final ? {} : cur));
      setConfirmed((cur) => (cur === runSteps ? null : cur));
    }, () => undefined);
  }

  /**
   * One run at a time: a run or a retry holds `busy` until it settles. The buttons are disabled
   * while it is set, and a call from this render while busy does nothing. A click's setBusy(true)
   * is flushed before the next click, so a double click cannot start two.
   */
  async function exclusive(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    try {
      await work();
    } finally {
      setBusy(false);
    }
  }

  function confirm() {
    // Close even when no step is recorded, and do not leave that run latched: the next
    // Deploy everything on this page has to be able to open the modal again.
    onClose();
    return exclusive(async () => {
      // Every confirm starts from nothing: an empty plan never reaches runAll's onChange, so the
      // previous run's phases (and its Retry/Skip) would otherwise stay on screen.
      setState({});
      setConfirmed(steps);
      const result = await runAll(steps, {}, publish);
      onPhase?.(result.state);
      settle(lanes, steps, result.state);
    });
  }
  function retry(laneId: string) {
    return exclusive(async () => {
      const result = await retryLane(ran, state, laneId, publish);
      onPhase?.(result.state);
      settle(lanes, ran, result.state);
    });
  }
  function skip(laneId: string) {
    if (busy) return;
    const next = skipLane(ran, state, laneId, publish);
    onPhase?.(next);
    settle(lanes, ran, next);
  }

  return (
    <>
      {children(views, { retry, skip, busy })}
      {views.map((view) => view.retry ? (
        <span key={view.id}>
          <Button variant="primary" disabled={busy} onClick={() => { void retry(view.id); }}>{`Retry ${view.name}`}</Button>
          <Button variant="secondary" disabled={busy} onClick={() => skip(view.id)}>{`Skip ${view.name}`}</Button>
        </span>
      ) : null)}
      <Modal isOpen={open} title={deployConfirmTitle(lanes)} confirmButtonText="Deploy" cancelButtonText="Cancel"
        footer={demo ? (
          <div className="row">
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled>Deploy</Button>
          </div>
        ) : undefined}
        onConfirm={() => confirm()} onClose={onClose}>
        <Text>These changes are written to Cribl configuration. Each group is committed and deployed to its workers.</Text>
        <Table density="compact" appearance="flat" aria-label="Deploy confirmation"
          items={rowsOf(rows.map((row, i) => ({ id: i, where: row.where, text: row.text })), [...CONFIRM_COLS])}
          visibleColumns={vis([...CONFIRM_COLS])}
          columns={cols([
            { id: 'where', label: 'Where' },
            { id: 'text', label: 'What changes' },
          ])} />
        <Alert appearance="warning" title="Overwrites are not undone automatically">{FAIL_BODY}</Alert>
        {demo && <Text>Demo data {'—'} open Pulse in Cribl to deploy.</Text>}
      </Modal>
    </>
  );
}
