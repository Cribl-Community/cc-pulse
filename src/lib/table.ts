import type { ReactNode } from 'react';
/* Capra's Table derives column keys from the item type; Pulse rows are dynamic search results, so we
   relax the generic here (one place) instead of declaring a type per query. */
type Col = { id: string; label: string; allowsSorting?: boolean; render?: (v: any, item: any) => ReactNode }; // eslint-disable-line
export const cols = (c: Col[]) => c as any; // eslint-disable-line
/** Capra's Table shows "--" (and skips `render`) when item[columnId] is null/undefined/"". Computed columns
 *  (owner, sparkline…) have no field of their own, so pass the visible ids and they get a placeholder value. */
export const rowsOf = <T,>(r: T[], ids?: string[]) => (ids
  ? r.map((x) => { const o = { ...(x as object) } as Record<string, unknown>; for (const id of ids) if (o[id] === null || o[id] === undefined || o[id] === '') o[id] = '​'; return o; })
  : r) as any[]; // eslint-disable-line
export const vis = (v: string[]) => v as any; // eslint-disable-line
