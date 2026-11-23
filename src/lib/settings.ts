import { kvGet, kvPut } from './api';
import { normalizeLoad, type SearchLoad } from './cadence';
import { DEFAULT_REFRESH, type RefreshChoice } from './refresh';
import { ALERT_EVENTS, type AlertEvent, type Route, type RouteKind } from './routes';

export type AiProvider = 'cribl' | 'anthropic' | 'openai';
export type AiSettings = { provider: AiProvider; model: string; apiKeySet?: boolean };
export type Learning = {
  K: number; MIN_GAP: number; MAX_GAP: number; LEARN_MIN: number; LOOKBACK: string;
  GRACE_S: number;     // stay missing this long before the alert fires (a blip that recovers never alerts)
  LAG_MAX: number;     // events older than this on arrival (s) => "delayed": data late, not lost
  FUTURE_S: number;    // events timestamped this far in the future (s) => clock skew
  VOL_MIN: number;     // last hour below this share of the asset's hourly average => low volume
  SRC_MIN: number;     // collective silence: at least this many assets of a source …
  SRC_PCT: number;     // … and this share of them missing => one source alert instead of N asset alerts
};
export type AppSettings = {
  dataset: string;          // Lake dataset holding pulse.heartbeat metric events
  destination: string;      // Stream destination id written by Deploy
  routeFilter: string;      // default observer filter
  learning: Learning;
  // recovery: Send recovery notifications (resolved/expired) by default; remindH: Remind every N hours (0 = off)
  notify: { targets: string[]; email: string; routes: Route[]; remindH?: number; recovery?: boolean };
  refresh: RefreshChoice;   // auto-refresh cadence for snapshot reads
  rollup: RollupSetting;    // read the rollup dataset when current ('auto') or never ('off')
  searchLoad: SearchLoad;
  rollCall: RollCall;
};
export type RollupSetting = 'auto' | 'off';
export type RollCall = { hour: number; tz: string; allClear: boolean };
const browserTz = (): string => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
};
export const normalizeRollCall = (v: unknown): RollCall => {
  const r = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const h = typeof r.hour === 'number' ? r.hour : r.hour == null || r.hour === '' ? NaN : Number(r.hour);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 7;
  const tz = typeof r.tz === 'string' && r.tz.trim() ? r.tz.trim() : browserTz();
  return { hour, tz, allClear: r.allClear === true };
};
/** The rollup setting actually in force: daily load never reads the rollup. */
export const effectiveRollup = (s: { searchLoad?: SearchLoad; rollup: RollupSetting }): RollupSetting =>
  s.searchLoad === 'daily' ? 'off' : s.rollup;

export const DEFAULT_AI: AiSettings = { provider: 'cribl', model: 'cribl-ai-settings' };
export const DEFAULT_SETTINGS: AppSettings = {
  dataset: 'pulse_metrics',
  destination: 'pulse_lake',
  routeFilter: "!__inputId.startsWith('cribl:')",
  learning: { K: 3, MIN_GAP: 300, MAX_GAP: 14400, LEARN_MIN: 10, LOOKBACK: '-24h', GRACE_S: 0, LAG_MAX: 900, FUTURE_S: 300, VOL_MIN: 0.3, SRC_MIN: 3, SRC_PCT: 0.5 },
  notify: { targets: ['system_notifications'], email: '', routes: [], remindH: 0, recovery: true },
  refresh: DEFAULT_REFRESH,
  rollup: 'auto',
  searchLoad: 'standard',
  rollCall: { hour: 7, tz: browserTz(), allClear: false },
};
export const MODELS: Record<AiProvider, string[]> = {
  cribl: ['cribl-ai-settings'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-6-sol', 'gpt-6-luna'],
};

/** A Stream destination id: letters, digits, `_` and `-` (Stream rejects others, e.g. `cribl_lake:pulse`). */
export const DESTINATION_RE = /^[A-Za-z0-9_-]+$/;
export const validDestination = (id: string) => DESTINATION_RE.test(id);
export const normalizeRollup = (v: unknown): RollupSetting => (v === 'off' ? 'off' : 'auto');
/** The default when.events (routes without their own, and the default route): no resolved/expired when recovery is off. */
export const defaultEvents = (s: { notify?: { recovery?: boolean } }): AlertEvent[] =>
  s.notify?.recovery === false ? ['opened', 'reminder'] : [...ALERT_EVENTS];
/** Remind every N hours: a whole number ≥ 0 (0 = off). */
export const normalizeRemindH = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
const ROUTE_IDS = ['r1', 'r2', 'r3', 'r4', 'r5'];
const ROUTE_KINDS = ['missing', 'source_down', 'digest'];
const ROUTE_SEVERITIES = ['critical', 'error', 'warning', 'info'];
const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');

/** Normalize notify.routes: max 5, stable ids r1–r5, sanitized fields. */
export function normalizeRoutes(input: unknown): Route[] {
  if (!Array.isArray(input)) return [];
  const raw = input.filter((r) => r && typeof r === 'object').slice(0, ROUTE_IDS.length) as Record<string, any>[];
  const used = new Set<string>();
  const ids: (string | undefined)[] = raw.map((r) => {
    const id = r.id;
    if (typeof id === 'string' && ROUTE_IDS.includes(id) && !used.has(id)) { used.add(id); return id; }
    return undefined;
  });
  return raw.map((r, i) => {
    let id = ids[i];
    if (!id) { id = ROUTE_IDS.find((x) => !used.has(x))!; used.add(id); }
    const w = (r.when && typeof r.when === 'object' ? r.when : {}) as Record<string, any>;
    const when: Route['when'] = {};
    if (Array.isArray(w.kinds)) {
      const kinds = [...new Set(w.kinds.filter((k: unknown) => typeof k === 'string' && ROUTE_KINDS.includes(k)))] as RouteKind[];
      if (kinds.length) when.kinds = kinds;
    }
    const mc = Number(w.maxCriticality);
    if (w.maxCriticality != null && w.maxCriticality !== '' && Number.isFinite(mc)) when.maxCriticality = Math.min(4, Math.max(1, Math.round(mc))) as 1 | 2 | 3 | 4;
    const team = str(w.team); if (team) when.team = team;
    const inp = str(w.input); if (inp) when.input = inp;
    if (Array.isArray(w.events)) {
      const evs = ALERT_EVENTS.filter((e) => w.events.includes(e));
      if (evs.length) when.events = evs;
    }
    const targets = [...new Set((Array.isArray(r.targets) ? r.targets : []).map(str).filter(Boolean))];
    const route: Route = { id, name: str(r.name), when, targets, final: r.final === true || r.final === 'true' };
    if (typeof r.severity === 'string' && ROUTE_SEVERITIES.includes(r.severity)) route.severity = r.severity as Route['severity'];
    return route;
  });
}

export const normalizeSettings = (s: Partial<AppSettings> | null | undefined): AppSettings => {
  s = s ?? {};
  return { ...DEFAULT_SETTINGS, ...s, rollup: normalizeRollup(s.rollup), searchLoad: normalizeLoad(s.searchLoad), rollCall: normalizeRollCall(s.rollCall), learning: { ...DEFAULT_SETTINGS.learning, ...(s.learning ?? {}) }, notify: { ...DEFAULT_SETTINGS.notify, ...(s.notify ?? {}), routes: normalizeRoutes(s.notify?.routes), remindH: normalizeRemindH(s.notify?.remindH), recovery: s.notify?.recovery !== false } };
};
export const loadSettings = async (): Promise<AppSettings> => normalizeSettings(await kvGet<Partial<AppSettings>>('settings/app', {}));
export const saveSettings = (s: AppSettings) => kvPut('settings/app', s);
export const loadAi = async () => ({ ...DEFAULT_AI, ...(await kvGet<Partial<AiSettings>>('settings/ai', {})) });
export async function saveAi(ai: AiSettings, apiKey?: string) {
  if (apiKey) { await kvPut(`secrets/${ai.provider}ApiKey`, apiKey, true); ai = { ...ai, apiKeySet: true }; }
  await kvPut('settings/ai', ai);
  return ai;
}
