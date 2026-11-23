/* Thin Cribl API layer. Inside the app iframe the platform proxy injects auth; every path used here
   must be declared in config/policies.yml (policiesOnly mode). */

import { apiBase } from './host';
import { pollDelay } from './refresh';
const pretty = (s: string) => { try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; } };

export class ApiError extends Error {
  status: number; path: string; method: string; body: string;
  constructor(status: number, path: string, msg: string, method = 'GET', body = '') {
    super(msg); this.status = status; this.path = path; this.method = method; this.body = body;
  }
  /** Full request/response text for the UI's "details" panel. */
  get detail() { return `${this.method} ${apiBase()}${this.path}\nHTTP ${this.status}\n\n${pretty(this.body)}`; }
}

export async function api<T = unknown>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const { json, ...rest } = init;
  const res = await fetch(apiBase() + path, {
    ...rest,
    headers: { ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(rest.headers ?? {}) },
    body: json !== undefined ? JSON.stringify(json) : rest.body,
  });
  const text = await res.text();
  if (!res.ok) {
    const hint = res.status === 403 ? ` — add "${init.method ?? 'GET'} ${path.split('?')[0]}" to config/policies.yml` : '';
    const reason = (() => { try { return (JSON.parse(text) as { message?: string }).message ?? text; } catch { return text; } })();
    throw new ApiError(res.status, path, `${res.status} ${path.split('?')[0]}${hint}: ${reason.slice(0, 300)}`, init.method ?? 'GET', text);
  }
  try { return JSON.parse(text) as T; } catch { return text as unknown as T; }
}

export const items = <T>(r: { items?: T[] }) => r.items ?? [];

/* ---------- KV store (app scoped). PUT must be text/plain with a JSON-stringified body. ---------- */
export async function kvGet<T>(key: string, fallback: T): Promise<T> {
  try {
    const res = await fetch(`${apiBase()}/kvstore/${key}`);
    if (!res.ok) return fallback;
    let v: unknown = await res.text();
    for (let i = 0; i < 3 && typeof v === 'string'; i++) { try { v = JSON.parse(v as string); } catch { break; } }
    const obj = v as { items?: { value?: unknown }[] };
    if (obj && Array.isArray(obj.items)) v = obj.items[0]?.value;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch { /* raw */ } }
    return (v ?? fallback) as T;
  } catch { return fallback; }
}
/** List KV keys under a prefix (a read). Items may be strings or `{ key }` objects. Throws on failure. */
export async function kvKeys(prefix: string): Promise<string[]> {
  const res = await fetch(`${apiBase()}/kvstore/keys`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prefix }),
  });
  if (!res.ok) throw new ApiError(res.status, '/kvstore/keys', `KV list failed (${res.status})`, 'POST', await res.text());
  // The platform answers with a bare array of keys (the dev server mirrors it); `{ items }` is accepted too.
  const body = (await res.json()) as unknown[] | { items?: unknown[] };
  return (Array.isArray(body) ? body : body?.items ?? []).map((i) => (typeof i === 'string' ? i : String((i as { key?: unknown })?.key ?? ''))).filter(Boolean);
}
export async function kvPut(key: string, value: unknown, encrypted = false) {
  const res = await fetch(`${apiBase()}/kvstore/${key}${encrypted ? '?encrypted=true' : ''}`, {
    method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(value),
  });
  if (!res.ok) throw new ApiError(res.status, `/kvstore/${key}`, `KV write failed (${res.status})`, 'PUT', await res.text());
}

/* ---------- Search jobs ---------- */
export type Row = Record<string, unknown>;
const S = '/m/default_search/search';

/** Fire-and-forget cancel of a search job; errors are swallowed. */
export function cancelSearch(id: string): Promise<void> {
  return api(`${S}/jobs/${id}/cancel`, { method: 'POST' }).then(() => undefined, () => undefined);
}

const abortError = () => {
  try { return new DOMException('Search aborted', 'AbortError'); }
  catch { const e = new Error('Search aborted'); e.name = 'AbortError'; return e; }
};

export async function runSearch(query: string, earliest = '-24h', latest = 'now', timeoutMs = 120_000, limit = 1000, opts?: { signal?: AbortSignal }): Promise<Row[]> {
  const signal = opts?.signal;
  if (signal?.aborted) throw abortError();
  const job = items<{ id: string }>(await api(`${S}/jobs`, { method: 'POST', json: { query, earliest, latest } }))[0];
  const t0 = Date.now();
  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) { void cancelSearch(job.id); throw abortError(); }
    const st = items<{ status: string }>(await api(`${S}/jobs/${job.id}/status`))[0];
    if (st?.status === 'completed') break;
    if (st?.status === 'failed' || st?.status === 'canceled') throw new Error(`Search ${st.status}: ${JSON.stringify(st).slice(0, 300)}`);
    if (signal?.aborted) { void cancelSearch(job.id); throw abortError(); }
    if (Date.now() - t0 > timeoutMs) { void cancelSearch(job.id); throw new Error('Search timed out'); }
    await new Promise<void>((resolve) => {
      const t = setTimeout(done, pollDelay(attempt));
      function done() { clearTimeout(t); signal?.removeEventListener('abort', done); resolve(); }
      signal?.addEventListener('abort', done, { once: true });
    });
  }
  const raw = await api<string>(`${S}/jobs/${job.id}/results?limit=${limit}&offset=0`);
  const lines = (typeof raw === 'string' ? raw : JSON.stringify(raw)).split('\n').filter(Boolean).map((l) => JSON.parse(l) as Row);
  return lines.filter((l) => !('isFinished' in l && 'totalEventCount' in l));
}

/* ---------- Stream ---------- */
export type Group = { id: string; workerCount?: number; onPrem?: boolean; isFleet?: boolean; isSearch?: boolean };
export async function listGroups(): Promise<Group[]> {
  const gs = items<Group & { type?: string }>(await api('/master/groups?fields=id,workerCount,onPrem,isFleet,type'));
  return gs.filter((g) => !g.isFleet && g.type !== 'lake_search' && !/search|outpost/.test(g.id));
}
export type Input = { id: string; type: string; disabled?: boolean; port?: number };
export const listInputs = async (g: string) =>
  items<Input>(await api(`/m/${g}/system/inputs`)).filter((i) => !i.disabled && !['cribl', 'criblmetrics', 'system_metrics', 'system_state'].includes(i.type));
export type LakeDataset = { id: string; format?: 'json' | 'parquet' | 'ddss' };
export const listDatasets = async () => items<LakeDataset>(await api('/products/lake/lakes/default/datasets'));
export const listPacks = async (g: string) => items<{ id: string; version?: string }>(await api(`/m/${g}/packs`));

export type PackInput = { id: string; type: string; disabled?: boolean };
export const listPackInputs = async (group: string, pack: string) =>
  items<PackInput>(await api(`/m/${group}/p/${pack}/system/inputs`)).filter((i) => !i.disabled);
export const listPackRoutes = async (group: string, pack: string) =>
  items<{ routes?: Record<string, unknown>[] }>(await api(`/m/${group}/p/${pack}/routes`)).flatMap((t) => t.routes ?? []);

/** Commit a group's pending config. Undefined when there is nothing new to commit (spec 016: a re-run or a retry of
 *  a plan whose changes were already committed). */
export async function commitGroup(group: string, message: string): Promise<string | undefined> {
  try { return items<{ commit?: string }>(await api('/version/commit', { method: 'POST', json: { group, message } }))[0]?.commit || undefined; }
  catch (e) { if (e instanceof ApiError && /nothing to commit|no changes|working tree clean/i.test(`${e.message} ${e.body}`)) return undefined; throw e; }
}
export const deployGroup = (group: string, version: string) => api(`/master/groups/${group}/deploy`, { method: 'PATCH', json: { version } });

/* ---------- Search lookups (managed by the app): upload the CSV, then create or point the lookup at it ---------- */
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
export async function publishLookup(id: string, header: string[], rows: unknown[][], description: string) {
  const csv = [header.join(','), ...rows.map((r) => r.map(csvCell).join(','))].join('\n') + '\n';
  const S = '/m/default_search/system/lookups';
  const up = await api<{ filename: string }>(`${S}?filename=${id}`, { method: 'PUT', body: csv, headers: { 'Content-Type': 'text/csv' } });
  const known = items<{ id: string }>(await api(S)).some((l) => l.id === id);
  await api(`${S}${known ? `/${id}` : ''}`, { method: known ? 'PATCH' : 'POST', json: { id, fileInfo: { filename: up.filename }, mode: 'memory', description } });
}

/** Sets one variable of an installed pack (Knowledge → Variables of the pack, on a worker group). */
export const setPackVar = (group: string, pack: string, id: string, type: string, value: string, description: string) =>
  api(`/m/${group}/p/${pack}/lib/vars/${id}`, { method: 'PATCH', json: { id, type, lib: 'custom', value, description } });
export const getPackVars = async (group: string, pack: string) => items<{ id: string; value: string; type: string }>(await api(`/m/${group}/p/${pack}/lib/vars`));
