/** Keeps the items whose name contains the query, case-insensitive. An empty query keeps all. */
export function filterGroups<T>(items: T[], query: string, name: (t: T) => string): T[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((t) => name(t).toLowerCase().includes(q)) : items;
}
