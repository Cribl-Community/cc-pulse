/**
 * Spec 019: the one setup state, computed once. Pure: no React, no fetch, no DOM.
 *
 * Precedence, first match wins:
 *   demo → first load not finished (unknown) → at least one asset (ready) → KV list failed (unknown)
 *   → a deployment record (waiting) → not-deployed.
 * Assets win: a fleet with assets is ready even without a record and even when the KV list fails.
 * A live-query error with no record and no asset is still not-deployed.
 */

export type SetupState = 'demo' | 'unknown' | 'not-deployed' | 'waiting' | 'ready';

/** The shape of an app KV `deployments/<group>` record (structurally the `Deployment` of deploy.ts, spec 016). */
export type DeploymentRecord = { group?: string; at?: string; [k: string]: unknown };

export type SetupInput = {
  demo: boolean;
  /** The deployment records (or their KV keys). Anything that isn't an array (null, undefined, an error marker)
   * means the KV key list failed. */
  deployments: readonly unknown[] | null | undefined | Error | string | { error: unknown };
  fleetCount: number;
  /** True until the first load has finished. */
  loading: boolean;
  /** The live-query error, if any. It never changes the state on its own. */
  error?: unknown;
};

export function setupState({ demo, deployments, fleetCount, loading }: SetupInput): SetupState {
  if (demo) return 'demo';
  if (loading) return 'unknown';
  if ((fleetCount ?? 0) > 0) return 'ready';
  if (!Array.isArray(deployments)) return 'unknown';
  if (deployments.length > 0) return 'waiting';
  return 'not-deployed';
}

const stamp = (r: DeploymentRecord | null | undefined): number => {
  const t = r && typeof r.at === 'string' ? Date.parse(r.at) : NaN;
  return Number.isFinite(t) ? t : -Infinity;
};

/** The record with the latest `at` timestamp, or null for an empty list. */
export function newestDeployment<T extends DeploymentRecord>(records: readonly (T | null | undefined)[] | null | undefined): T | null {
  let best: T | null = null;
  for (const r of records ?? []) {
    if (!r) continue;
    if (best === null || stamp(r) > stamp(best)) best = r;
  }
  return best;
}
