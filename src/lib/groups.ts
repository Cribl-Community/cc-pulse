/* Pure helpers for the worker group detail page (spec 013 §6, §9): grouping entities by source and
 * ranking those sources by missing share (the fraction of a source's assets currently missing),
 * descending. Kept out of src/pages/Groups.tsx so they can be unit-tested without React. */
import type { Entity } from './model';

export type SrcRow = { id: string; group: string; input: string; list: Entity[] };

/** Every distinct (group, input) pair present in `list`, each with its own assets. */
export function bySource(list: Entity[]): SrcRow[] {
  return [...new Set(list.map((e) => `${e.group}|${e.input}`))].sort()
    .map((k) => { const [group, input] = k.split('|'); return { id: k, group, input, list: list.filter((e) => e.group === group && e.input === input) }; });
}

export type RankedSrc = SrcRow & { missing: number; share: number };

/** Sources ranked by missing share (missing assets ÷ all assets on that source), worst first.
 *  Ties break by the raw missing count, then alphabetically so the order is stable. */
export function rankSources(rows: SrcRow[]): RankedSrc[] {
  return rows
    .map((r) => { const missing = r.list.filter((e) => e.state === 'missing').length; return { ...r, missing, share: r.list.length ? missing / r.list.length : 0 }; })
    .sort((a, b) => b.share - a.share || b.missing - a.missing || a.input.localeCompare(b.input));
}
