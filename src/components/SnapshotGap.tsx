import type { ReactElement } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@capra/core';

/** Spec 034 §4/§5: Compute now lives on the Overview's "Snapshot not used" Alert, the one place that runs the compute.
 *  Other pages point to it; nothing is computed until someone clicks it there. */
export const GAP_POINTER = 'Compute now on the Overview loads it.';

export function OverviewButton() {
  const navigate = useNavigate();
  return <Button variant="primary" onClick={() => navigate('/')}>Go to Overview</Button>;
}

/** What useSnapshotGap() (./useSnapshotGap.tsx) returns. */
export type SnapshotGapEmpty = { title: string; description: string; cta: ReactElement };
