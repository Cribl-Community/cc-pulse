import { useState } from 'react';
import type { Rule } from '../components/charts';

export const sameRule = (a: Rule, b: Rule) => a.K === b.K && a.MIN_GAP === b.MIN_GAP && a.MAX_GAP === b.MAX_GAP;

/**
 * Editable copy of the live learning rule. It resets to `live` whenever the live K, MIN_GAP or MAX_GAP change.
 * Uses the "store the previous prop and compare during render" pattern instead of a syncing effect:
 * React re-runs the render immediately with the reset value, so nothing stale reaches the screen.
 */
export function useLiveRule(live: Rule) {
  const [rule, setRule] = useState<Rule>(live);
  const [prevLive, setPrevLive] = useState<Rule>(live);
  if (!sameRule(prevLive, live)) { setPrevLive(live); setRule(live); }
  return { rule, setRule, dirty: !sameRule(rule, live) };
}
