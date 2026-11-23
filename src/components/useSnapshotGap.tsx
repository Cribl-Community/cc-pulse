import { fmtDur } from '../lib/model';
import { SNAPSHOT_GAP_TITLE, reasonMessage, snapshotGap } from '../lib/snapshot';
import { usePulse } from '../state';
import { GAP_POINTER, OverviewButton, type SnapshotGapEmpty } from './SnapshotGap';

/** R1: during a snapshot gap (rejected snapshot, no rows on screen), the empty state every page shows in place of
 *  "No assets yet", "No worker group yet", "has not sent anything" or a Set up Pulse CTA: why the asset state is
 *  missing, how old the last snapshot is, and a pointer to Compute now. Undefined when there is no gap.
 *  Kept apart from SnapshotGap.tsx so that file exports only components (react(only-export-components), check-010). */
export function useSnapshotGap(): SnapshotGapEmpty | undefined {
  const { demo, stateReason, stateSource, stateAge, fleet } = usePulse();
  if (!stateReason || !snapshotGap({ demo, stateReason, stateSource, fleetCount: fleet.length })) return undefined;
  const age = stateAge !== undefined ? `The last snapshot is ${fmtDur(stateAge)} old.` : 'There is no snapshot yet.';
  return { title: SNAPSHOT_GAP_TITLE, description: `${reasonMessage(stateReason)} ${age} ${GAP_POINTER}`, cta: <OverviewButton /> };
}
