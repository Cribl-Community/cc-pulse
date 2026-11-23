import { useEffect } from 'react';
import { cadenceOf, normalizeLoad } from '../lib/cadence';
import { pageNeedsHistory } from '../lib/refresh';
import { usePulse } from '../state';

/** Spec 033 §5: "Pages a user opens (Asset, Groups, Assets) run their searches as today". In Economy the provider
 *  holds the history queries (activity, fleet heartbeat, gap ledger) back until the Overview's Load charts. A page that
 *  reads them (Incidents and Assets: the ledger; Asset: the ledger and the activity sparks) has no Load charts of its
 *  own, so opening it is the ask: it starts them once, through the same loadCharts. Afterwards a TimeScope change
 *  re-runs them and a tick still doesn't. Standard / Hourly: nothing to do, the provider already runs them. */
export function useHistoryOnOpen(): void {
  const { settings, historyLoaded, loadCharts } = usePulse();
  const onTick = cadenceOf(normalizeLoad(settings?.searchLoad), settings?.rollCall).historyOnTick;
  const need = !!loadCharts && pageNeedsHistory({ historyOnTick: onTick, loaded: !!historyLoaded });
  useEffect(() => { if (need) void loadCharts(); }, [need]); // eslint-disable-line
}
