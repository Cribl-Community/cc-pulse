/* Demo data for `npm run dev` outside Cribl only (state.tsx imports it behind import.meta.env.DEV).
   Shapes match the rows of entityQuery / sourceQuery / activityQuery / fleetQuery / gapsQuery / samplesQuery. */
import type { Row } from './api';
import type { ClassRule, Clusters, Inventory } from './inventory';
import type { Window } from './maintenance';
import type { Win } from './timescope';

type R = [group: string, input: string, asset: string, state: string, gap: number, silent: number, lag: number, key: string, signal?: string];
const A: R[] = [
  ['prod-eu', 'syslog:in_syslog:tcp', 'fw-par-edge-01', 'missing', 60, 2820, 4, 'host'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'fw-par-edge-02', 'ok', 60, 20, 3, 'host'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'sw-lyon-core-03', 'late', 120, 250, 2, 'host'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'lb-f5-ext-01', 'ok', 30, 5, 1, 'host'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'vpn-gw-02', 'ok', 300, 40, 6, 'host', 'low_volume'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'dns-int-01', 'ok', 60, 10, 1, 'host'],
  ['prod-eu', 'syslog:in_syslog:tcp', 'ntp-01', 'learning', 600, 30, 0, 'ip'],
  ['prod-eu', 'http:in_splunk_hec:cribl', 'app-payments-7f9c', 'missing', 15, 1260, 2, 'host'],
  ['prod-eu', 'http:in_splunk_hec:cribl', 'app-payments-2b1d', 'missing', 15, 1250, 2, 'host'],
  ['prod-eu', 'http:in_splunk_hec:cribl', 'app-checkout-11', 'ok', 20, 4, 1, 'host'],
  ['prod-eu', 'http:in_splunk_hec:cribl', 'app-search-04', 'acked', 30, 900, 1, 'host'],
  ['prod-eu', 'tcp:in_pan_traffic', '007200001234', 'ok', 5, 2, 3, 'csv:2'],
  ['prod-eu', 'tcp:in_pan_traffic', '007200001377', 'delayed', 5, 3, 1840, 'csv:2', 'delayed'],
  ['prod-eu', 'tcp:in_fortigate', 'FGT-LYS-02', 'missing', 60, 1900, 2, 'kv:devname'],
  ['prod-eu', 'tcp:in_fortigate', 'FGT-LYS-01', 'ok', 60, 12, 2, 'kv:devname'],
  ['04-2025', 'http:in_http_hostmiss:cribl', 'lab-host-a', 'ok', 60, 30, 0, 'host'],
  ['04-2025', 'http:in_http_hostmiss:cribl', 'lab-host-b', 'late', 60, 450, 0, 'host'],
  ['04-2025', 'http:in_http_hostmiss:cribl', 'lab-host-c', 'ok', 60, 12, 0, 'host'],
  ['04-2025', 'http:in_http_hostmiss:cribl', 'lab-host-d', 'muted', 60, 9000, 0, 'host'],
  ['04-2025', 'datagen:pantraffic', 'localhost', 'ok', 1, 1, 70, 'host'],
  ['04-2025', 'collection:cribl-mist-rest-io_1-0-0.in_mist', 'simon duchene simon.duchene@gmail.com', 'delayed', 900, 470, 275000, 'host', 'delayed'],
  ['edge-paris', 'wef:in_windows_events', 'DC-PAR-01', 'ok', 45, 15, 2, 'field:Computer'],
  ['edge-paris', 'wef:in_windows_events', 'DC-PAR-02', 'ok', 45, 22, 2, 'field:Computer'],
  ['edge-paris', 'wef:in_windows_events', 'FS-PAR-07', 'maintenance', 180, 3600, 5, 'field:Computer'],
  ['edge-paris', 'wef:in_windows_events', 'PRT-PAR-12', 'learning', 900, 120, 0, 'field:Computer'],
  ['edge-paris', 'wef:in_windows_events', 'WKS-PAR-0441', 'ok', 600, 300, 480, 'field:Computer'],
  ['edge-paris', 'syslog:in_syslog_edge:udp', 'ap-par-wifi-01', 'ok', 120, 60, 1, 'ip'],
  ['edge-paris', 'http:in_iot:cribl', '(source)', 'ok', 30, 8, 1, 'none'],
];
// A realistic estate around the named assets: switches and k8s pods that are mostly fine.
let seed = 11; const rnd = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280);
for (const [g, i, p, count, gap] of [['prod-eu', 'syslog:in_syslog:tcp', 'sw-par-acc-', 34, 120], ['prod-eu', 'http:in_splunk_hec:cribl', 'app-k8s-', 22, 30], ['edge-paris', 'wef:in_windows_events', 'WKS-PAR-0', 26, 600]] as const)
  for (let k = 0; k < count; k++) A.push([g, i, `${p}${100 + k}`, rnd() < 0.05 ? 'late' : 'ok', gap, rnd() * gap * 1.4, 1 + Math.round(rnd() * 8), i.startsWith('wef') ? 'field:Computer' : 'host']);

const tol = (gap: number) => Math.max(300, Math.min(3 * gap, 14400));
const now = () => Math.floor(Date.now() / 1000);
const TOL_OVERRIDE: Record<string, number> = { 'lab-host-b': 600 };

export const entities = (): Row[] => A.map(([g, i, a, st, gap, silent, lag, key, signal]) => ({
  worker_group: g, input: i, asset: a, state: st, raw_state: ['acked', 'maintenance'].includes(st) ? 'missing' : st === 'delayed' ? 'ok' : st,
  signal: signal ?? '', silent_min: Math.round(silent / 6) / 10, tolerance_s: TOL_OVERRIDE[a] ?? tol(gap),
  expected_gap_s: gap, active_min: st === 'learning' ? 4 : 1200, events: Math.round(86400 / gap * 12), events_1h: Math.round(3600 / gap * 12 * (signal === 'low_volume' ? 0.2 : 1)),
  vol_ratio: signal === 'low_volume' ? 0.2 : 1, max_lag_s: lag, lag_now_s: lag, min_lag_s: 0, key_src: key, maintenance: st === 'maintenance' ? 'Patch Tuesday' : '',
  last_seen: now() - silent - 60, last_seen_utc: new Date((now() - silent - 60) * 1000).toISOString().slice(0, 19) + 'Z',
}));

export const sources = (): Row[] => [...new Set(A.map((x) => `${x[0]}|${x[1]}`))].map((k) => {
  const [g, i] = k.split('|'); const l = A.filter((x) => x[0] === g && x[1] === i);
  const c = (s: string) => l.filter((x) => x[3] === s).length;
  return { worker_group: g, input: i, expected: c('ok') + c('late') + c('missing') + c('delayed'), current: c('ok') + c('late') + c('delayed'), missing: c('missing'), late: c('late'),
    learning: c('learning'), muted: c('muted'), missing_list: l.filter((x) => x[3] === 'missing').map((x) => x[2]), health: c('missing') ? 'degraded' : 'healthy' };
});

/** Deterministic day-shaped series that goes silent for the last `silent` seconds. */
export function series(asset: string, gap: number, silent: number, state: string, span: number, bins: number): number[] {
  let s = [...asset].reduce((acc, ch) => acc + ch.charCodeAt(0), 0);
  const r = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  const silentBins = ['ok', 'learning', 'delayed'].includes(state) ? 0 : Math.ceil(silent / span);
  return Array.from({ length: bins }, (_, i) => {
    if (state === 'learning' && i < bins * 0.8) return 0;
    if (i >= bins - silentBins) return 0;
    if (asset === 'fw-par-edge-01' && Math.abs(i - Math.round(bins * 0.42)) <= Math.max(0, Math.round(480 / span) - 1)) return 0; // an earlier short blip
    if (asset === 'sw-lyon-core-03' && span <= 60 && (i % 211 === 0 || i % 347 === 0)) return 0;
    const day = 0.55 + 0.45 * Math.sin((i / bins) * Math.PI * 2 - 1.2);
    const v = (span / gap) * day * (0.75 + r() * 0.5);
    return span <= 60 && gap > 60 ? (r() < 60 / gap ? 1 : 0) : Math.max(0, Math.round(v));
  });
}
/** Per-asset activity over `win` in bins of `span` seconds (bins end at win.to). Assets silent now stay silent
 *  only for the part of their silence that falls inside the window. */
export function activity(win: Win, span: number): Record<string, number[]> {
  const bins = Math.max(1, Math.ceil((win.to - win.from) / span)), behind = Math.max(0, now() - win.to);
  return Object.fromEntries(A.map(([g, i, a, st, gap, silent]) => [`${g}|${i}|${a}`, series(a, gap, Math.max(0, silent - behind), st, span, bins)]));
}
export const entitySeries = (asset: string, span: number, bins: number) => {
  const x = A.find((r) => r[2] === asset); return x ? series(x[2], x[4], x[5], x[3], span, bins) : new Array(bins).fill(0);
};

/** Fleet heartbeat over `win` in bins of `span` seconds: a short dip about a fifth of the way in (a blip under
 *  tolerance) and the drop of the last half hour before now. */
export function fleet(win: Win, span: number): Row[] {
  const bins = Math.max(1, Math.ceil((win.to - win.from) / span)), end = Math.floor(win.to / span) * span, t = now();
  let s2 = 5; const r = () => ((s2 = (s2 * 9301 + 49297) % 233280) / 233280);
  const total = A.length, dip = Math.round(bins * 0.215), dipW = Math.max(1, Math.round(600 / span));
  return Array.from({ length: bins }, (_, i) => {
    const b = end - (bins - 1 - i) * span;
    const day = 0.55 + 0.45 * Math.sin(((b % (bins * span)) / (bins * span)) * Math.PI * 2 - 1.3);
    let events = 4200 * (span / 300) * day * (0.92 + r() * 0.16), assets = total - 3 - (r() < 0.08 ? 1 : 0);
    if (i >= dip && i < dip + dipW) { events *= 0.8; assets -= 2; }
    if (b + span > t - 1800) { events *= 0.72; assets -= 4; }
    return { b, events: Math.round(events), assets };
  });
}

/* Gap fixture: [asset, where the silence ends as a fraction of the window back from its end, length in s, also in the previous period]. */
const GAPS: [string, number, number, boolean][] = [
  ['fw-par-edge-01', 0.583, 480, true], ['lab-host-c', 0.0625, 1080, false], ['sw-lyon-core-03', 0.25, 900, true], ['sw-lyon-core-03', 0.5, 840, true],
  ['sw-lyon-core-03', 0.75, 780, false], ['vpn-gw-02', 0.347, 2400, true], ['DC-PAR-02', 0.833, 600, false], ['app-k8s-104', 0.104, 400, true], ['app-k8s-111', 0.105, 420, true],
];
/** Gap ledger over `win`, its previous period, and the MAX_GAP padding before it: a few silences, some over
 *  tolerance (incidents) and some under (blips). Every gap ends at or before win.to. */
export function gaps(win: Win, maxGap: number): Row[] {
  const dur = win.to - win.from, prevTo = win.from, prevFrom = win.from - dur;
  const g = (asset: string, end: number, secs: number) => { const x = A.find((r) => r[2] === asset)!; return { worker_group: x[0], input: x[1], asset, gap_start: end - secs, gap_end: end, gap_s: secs }; };
  const cur = GAPS.map(([a, frac, secs]) => g(a, win.to - frac * dur, secs));
  const prev = GAPS.filter((x) => x[3]).map(([a, frac, secs]) => g(a, prevTo - frac * dur, secs));
  // One silence that began in the padding before the previous period and ran into it.
  const pad = Math.min(maxGap, Math.floor(maxGap / 2) + Math.min(600, Math.floor(dur / 4)));
  return [...cur, ...prev, g('DC-PAR-01', prevFrom - Math.floor(maxGap / 2) + pad, pad)];
}

/** Key Advisor samples for the sources whose identity is weak. */
export function samples(input: string): Row[] {
  const t = now();
  if (input.startsWith('datagen:pantraffic')) return Array.from({ length: 24 }, (_, i) => ({ _time: t - i * 300, input, worker_group: '04-2025', src_ip: '',
    raw_sample: `1,2026/11/08 18:${String(i % 60).padStart(2, '0')}:01,00720000${1234 + (i % 4)},TRAFFIC,end,2561,2026/11/08 18:${String(i % 60).padStart(2, '0')}:01,10.1.${i % 7}.5,8.8.8.8,0.0.0.0,0.0.0.0,allow-web,,,ssl,vsys1,trust,untrust,ethernet1/1,ethernet1/2,log-fwd,2026/11/08 18:00:01,${4000 + i},1,5${i}221,443,0,0,0x400000,tcp,allow,5432,1234,4198,24,2026/11/08 18:00:00,8,any,0,${7000000 + i * 13},0x0,10.0.0.0-10.255.255.255,United States,0,13,11,tcp-fin,0,0,0,0,,PA-3260-PAR-${i % 4 < 2 ? 'A' : 'B'},from-policy`,
    fields_json: JSON.stringify({ host: 'localhost', sourcetype: 'pan:traffic', cribl_breaker: 'Break on newlines' }) }));
  if (input.startsWith('collection:')) return Array.from({ length: 12 }, (_, i) => ({ _time: t - i * 900, input, worker_group: '04-2025', src_ip: '',
    raw_sample: JSON.stringify({ device_id: `5c5b35${(i % 3)}f00a1`, device_name: ['AP-Lobby', 'AP-Floor2', 'AP-Lab'][i % 3], type: 'ap', org_id: 'f0d2', site_name: 'Paris HQ', admin_name: 'simon duchene simon.duchene@gmail.com', timestamp: t - i * 900 }),
    fields_json: JSON.stringify({ host: 'simon duchene simon.duchene@gmail.com', device_name: ['AP-Lobby', 'AP-Floor2', 'AP-Lab'][i % 3], site_name: 'Paris HQ', type: 'ap' }) }));
  return Array.from({ length: 10 }, (_, i) => ({ _time: t - i * 600, input, worker_group: 'prod-eu', src_ip: `10.0.0.${10 + (i % 3)}`,
    raw_sample: `<134>Nov  8 18:${String(i).padStart(2, '0')}:00 sw-par-acc-1${i % 3}0 %LINK-3-UPDOWN: Interface Gi1/0/${i}, changed state to up`, fields_json: JSON.stringify({ host: `sw-par-acc-1${i % 3}0` }) }));
}

export const inventory = (): Inventory => ({
  'fw-par-edge-01': { criticality: 1, team: 'Network Ops', contact: '#netops-oncall', environment: 'prod', location: 'Paris DC2', description: 'Perimeter firewall, edge pair A', runbook: 'https://wiki.example.com/netops/fw', tags: 'perimeter, pci', cluster: 'fw-par-edge' },
  'fw-par-edge-02': { criticality: 1, team: 'Network Ops', contact: '#netops-oncall', environment: 'prod', location: 'Paris DC2', cluster: 'fw-par-edge' },
  'FGT-LYS-01': { criticality: 2, team: 'Network Ops', cluster: 'fgt-lyon' }, 'FGT-LYS-02': { criticality: 2, team: 'Network Ops', cluster: 'fgt-lyon' },
  'sw-lyon-core-03': { criticality: 2, team: 'Network Ops', contact: '#netops-oncall', environment: 'prod', location: 'Lyon' },
  'app-payments-7f9c': { criticality: 1, team: 'Payments', contact: '#payments-oncall · payments@example.com', environment: 'prod', description: 'Checkout API pod, HEC forwarder', runbook: 'https://wiki.example.com/payments/logging', tags: 'pci, k8s' },
  'app-payments-2b1d': { criticality: 1, team: 'Payments', contact: '#payments-oncall', environment: 'prod', tags: 'pci, k8s' },
  'app-checkout-11': { criticality: 1, team: 'Payments', environment: 'prod' },
  'DC-PAR-01': { criticality: 1, team: 'Identity', environment: 'prod', cluster: 'dc-par' }, 'DC-PAR-02': { criticality: 1, team: 'Identity', environment: 'prod', cluster: 'dc-par' },
  'lab-host-b': { criticality: 4, team: 'SE Lab', environment: 'lab' },
});
export const clusters = (): Clusters => ({ 'fw-par-edge': { min_pct: 50, description: 'Paris edge firewall pair' }, 'fgt-lyon': { min_pct: 50 }, 'dc-par': { min_pct: 50, description: 'Paris domain controllers' } });
export const rules = (): ClassRule[] => [
  { id: 'switches', match: '^sw-', set: { team: 'Network Ops', criticality: 3, environment: 'prod' } },
  { id: 'k8s pods', match: '^app-k8s-', set: { team: 'Platform', criticality: 2, tags: 'k8s' } },
  { id: 'workstations', match: '^WKS-', set: { team: 'Workplace', criticality: 4 } },
];
export const windows = (): Window[] => { const t = now(); return [
  { id: 'w1', scope: 'g:edge-paris', start: t - 1800, end: t + 5400, reason: 'Patch Tuesday' },
  { id: 'w2', scope: 'i:prod-eu|tcp:in_pan_traffic', start: t + 86400, end: t + 90000, reason: 'PAN-OS upgrade' },
]; };
export const keys = (): Record<string, Record<string, string>> => ({ 'prod-eu': { 'tcp:in_pan_traffic': 'csv:2 | ip', 'tcp:in_fortigate': 'kv:devname | ip' }, 'edge-paris': { 'http:in_iot': 'none' } });

/* ---------- Setup fleet (spec 039 §2) ---------- */
/** `reach` is packSources' PackReach for a pack source ('no' = stays in the pack); unset falls back to `staysInPack`. */
export type FleetSource = {
  id: string; type: string; evs: number; picked: boolean; isNew?: boolean; pack?: string; staysInPack?: boolean;
  reach?: 'yes' | 'maybe' | 'no'; locked?: boolean; versionBlock?: boolean; routeId?: string;
};
export type FleetGroup = {
  id: string; workers: number; pulse?: string; mode: 'all' | 'selected'; selected: boolean;
  sources: FleetSource[]; packSources: FleetSource[];
};
export type FleetSearch = { dataset: string; targets: string[]; schedules: boolean; saved: number; lookups: number; outdated: number };
export type FleetData = { groups: FleetGroup[]; search: FleetSearch };

const fsrc = (id: string, type: string, evs: number, picked: boolean, isNew?: boolean): FleetSource =>
  ({ id, type, evs, picked, ...(isNew ? { isNew: true } : {}) });

export function setupFleet(): FleetData {
  return {
    groups: [
      { id: 'prod-eu', workers: 6, pulse: '1.2.0', mode: 'selected', selected: true,
        sources: [fsrc('in_syslog', 'syslog', 4200, true), fsrc('in_splunk_hec', 'splunk_hec', 1800, true), fsrc('in_kafka_app', 'kafka', 9000, true, true), fsrc('in_s3_cloudtrail', 's3', 300, false)],
        packSources: [{ id: 'in_pan_syslog', type: 'syslog', evs: 2500, picked: false, pack: 'cc-paloalto', staysInPack: true, locked: true }] },
      { id: 'prod-us', workers: 8, mode: 'all', selected: true,
        sources: [fsrc('in_syslog_us', 'syslog', 3100, true), fsrc('in_hec_us', 'splunk_hec', 2200, true), fsrc('in_kafka_us', 'kafka', 5400, true), fsrc('in_s3_us', 's3', 450, true)], packSources: [] },
      { id: 'edge-paris', workers: 2, mode: 'selected', selected: true,
        sources: [fsrc('in_iot', 'http', 600, true), fsrc('in_syslog_edge', 'syslog', 900, false), fsrc('in_windows_events', 'wef', 350, false)], packSources: [] },
      { id: '04-2025', workers: 2, pulse: '1.3.0', mode: 'all', selected: false,
        sources: [fsrc('in_syslog_0425', 'syslog', 700, true)], packSources: [] },
      { id: 'lab', workers: 0, mode: 'all', selected: false, sources: [], packSources: [] },
    ],
    search: { dataset: 'pulse_metrics', targets: ['system_notifications'], schedules: true, saved: 7, lookups: 3, outdated: 2 },
  };
}
