import { runSearch, type Row } from './api';
import { entityQuery } from './kql';
import type { AppSettings } from './settings';

/** The on-demand entity compute: ONE execution of `entityQuery` over learning.LOOKBACK, returning the entity rows.
 *  Only a user action (computeNow in the state context) calls it; a refresh never does. */
export function computeNow(s: AppSettings, run: typeof runSearch = runSearch): Promise<Row[]> {
  return run(entityQuery(s), s.learning.LOOKBACK);
}
