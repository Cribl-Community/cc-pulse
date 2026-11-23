/* Pure derivation for the Overview Question cards (spec 013 section 5 and 7). No React, no hooks. */
import { critOf, type AssetInfo, type Inventory } from './inventory';
import { ALARM, type Entity } from './model';

export const UNASSIGNED_TEAM = 'unassigned';

export type LongestSilentMissing = { count: number; top?: Entity };

/** "Who stopped sending?" -- missing now, top = the longest-silent P1 (criticality 1). Falls back to the
 *  longest-silent missing asset of any criticality when there is no P1 missing. */
export function longestSilentMissing(fleet: Entity[], inventory: Inventory): LongestSilentMissing {
  const missing = fleet.filter((e) => e.state === 'missing');
  if (!missing.length) return { count: 0 };
  const byCrit = (e: Entity) => critOf(inventory[e.asset] as AssetInfo | undefined);
  const p1 = missing.filter((e) => byCrit(e) === 1).sort((a, b) => b.silent_s - a.silent_s);
  const top = p1[0] ?? [...missing].sort((a, b) => b.silent_s - a.silent_s)[0];
  return { count: missing.length, top };
}

export type SourceGap = { group: string; input: string; count: number };

/** "Which source is losing senders?" -- the group+input with the most missing or late/delayed senders. */
export function worstSource(fleet: Entity[]): SourceGap | undefined {
  const by = new Map<string, SourceGap>();
  for (const e of fleet) {
    if (!ALARM.includes(e.state)) continue;
    const key = `${e.group}|${e.input}`;
    const cur = by.get(key) ?? { group: e.group, input: e.input, count: 0 };
    cur.count += 1; by.set(key, cur);
  }
  return [...by.values()].sort((a, b) => b.count - a.count)[0];
}

export type TeamGap = { team: string; count: number };

/** "Who owns the gaps?" -- the team with the most open problems (missing/late/delayed). Assets without a
 *  team count toward "unassigned", so the gap is never silently dropped. */
export function worstTeam(fleet: Entity[], inventory: Inventory): TeamGap | undefined {
  const by = new Map<string, number>();
  for (const e of fleet) {
    if (!ALARM.includes(e.state)) continue;
    const team = inventory[e.asset]?.team || UNASSIGNED_TEAM;
    by.set(team, (by.get(team) ?? 0) + 1);
  }
  const rows = [...by.entries()].map(([team, count]) => ({ team, count })).sort((a, b) => b.count - a.count);
  return rows[0];
}
