import { api } from './api';
import type { SearchJob } from './searchCost';

/** Reads the Search jobs list (GET only), a few pages at most. */
export async function listSearchJobs(): Promise<SearchJob[]> {
  const out: SearchJob[] = [];
  const size = 500;
  for (let page = 0; page < 5; page++) {
    const r = await api<{ items?: SearchJob[] }>(`/m/default_search/search/jobs?limit=${size}&offset=${page * size}`);
    const items = r.items ?? [];
    out.push(...items);
    if (items.length < size) break;
  }
  return out;
}
