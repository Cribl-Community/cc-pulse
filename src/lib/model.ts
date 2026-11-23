import type { Row } from './api';
import type { Learning } from './settings';
import type { Clusters, Inventory } from './inventory';

/* Typed view of the entity search rows + the "why" diagnosis shown on every level of the app.
   Suppressed states (maintenance, muted, acked, covered) always win over alarms, so a known cause never pages anyone. */
export type AssetState = 'missing' | 'late' | 'delayed' | 'covered' | 'acked' | 'ok' | 'learning' | 'maintenance' | 'muted';
export type Signal = '' | 'clock_skew' | 'delayed' | 'low_volume';
export type Entity = {
  key: string; group: string; input: string; asset: string; state: AssetState; raw: AssetState; signal: Signal;
  silent_s: number; tolerance_s: number; gap_s: number; active_min: number; events: number; events_1h: number; vol_ratio: number;
  max_lag_s: number; lag_now_s: number; min_lag_s: number; key_src: string; maintenance: string; cluster: string;
  last_seen: number; last_seen_utc: string; overridden: boolean;
};
const n = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v: unknown) => (v === null || v === undefined ? '' : String(v));
export const entityKey = (group: string, input: string, asset: string) => `${group}|${input}|${asset}`;
export const ruleTolerance = (gap: number, L: Pick<Learning, 'K' | 'MIN_GAP' | 'MAX_GAP'>) => Math.max(L.MIN_GAP, Math.min(L.K * gap, L.MAX_GAP));

export function toEntity(r: Row, L: Learning): Entity {
  const gap = n(r.expected_gap_s), tol = n(r.tolerance_s);
  return {
    key: entityKey(str(r.worker_group), str(r.input), str(r.asset)), group: str(r.worker_group), input: str(r.input), asset: str(r.asset),
    state: (str(r.state) || 'ok') as AssetState, raw: (str(r.raw_state) || str(r.state) || 'ok') as AssetState, signal: str(r.signal) as Signal,
    silent_s: n(r.silent_min) * 60, tolerance_s: tol, gap_s: gap, active_min: n(r.active_min),
    events: n(r.events), events_1h: n(r.events_1h), vol_ratio: r.vol_ratio === undefined ? 1 : n(r.vol_ratio),
    max_lag_s: n(r.max_lag_s), lag_now_s: n(r.lag_now_s), min_lag_s: n(r.min_lag_s), key_src: str(r.key_src), maintenance: str(r.maintenance),
    cluster: str(r.cluster), last_seen: n(r.last_seen), last_seen_utc: str(r.last_seen_utc), overridden: tol !== ruleTolerance(gap, L),
  };
}

/** HA clusters (spec 008): a missing member stays "covered" while enough of its cluster is up.
 *  The inventory is the master copy of membership, so it wins over the (possibly stale) lookup column. */
export function applyClusters(list: Entity[], inv: Inventory, clusters: Clusters): Entity[] {
  const of = (e: Entity) => inv[e.asset]?.cluster || e.cluster;
  const live = (e: Entity) => e.raw !== 'learning' && e.state !== 'muted' && e.state !== 'maintenance';
  const stats: Record<string, { n: number; up: number }> = {};
  for (const e of list) { const c = of(e); if (!c || !live(e)) continue; (stats[c] ??= { n: 0, up: 0 }).n++; if (e.raw === 'ok' || e.raw === 'late' || e.raw === 'delayed') stats[c].up++; }
  return list.map((e) => {
    const c = of(e); const st = c ? stats[c] : undefined;
    const next = { ...e, cluster: c ?? '' };
    if (st && e.state === 'missing' && st.up * 100 >= (clusters[c!]?.min_pct ?? 50) * st.n) next.state = 'covered';
    return next;
  });
}

export const LATE_RATIO = 0.6; // fixed in kql.ts
export function stateFor(silent: number, tol: number): AssetState { return silent > tol ? 'missing' : silent > LATE_RATIO * tol ? 'late' : 'ok'; }

export const fmtDur = (s: number) => {
  if (!Number.isFinite(s)) return '—';
  const a = Math.abs(s), sign = s < 0 ? '−' : '';
  if (a >= 86400) return `${sign}${(a / 86400).toFixed(a >= 864000 ? 0 : 1)} d`;
  if (a >= 3600) return `${sign}${(a / 3600).toFixed(a >= 36000 ? 0 : 1)} h`;
  if (a >= 60) return `${sign}${Math.round(a / 60)} min`;
  return `${sign}${Math.round(a)} s`;
};
export const fmtTime = (epoch: number) => (epoch ? new Date(epoch * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—');
export const fmtPct = (v: number) => (v >= 0.9995 ? '100%' : `${(v * 100).toFixed(v >= 0.99 ? 2 : 1)}%`);
/** How far into its tolerance an asset is — 1 = alerting now. Used for ranking. */
export const pressure = (e: Entity) => (e.tolerance_s ? e.silent_s / e.tolerance_s : 0);

export const STATE_ORDER: AssetState[] = ['missing', 'late', 'delayed', 'covered', 'acked', 'ok', 'learning', 'maintenance', 'muted'];
export const ALARM: AssetState[] = ['missing', 'late', 'delayed'];
export const SUPPRESSED: AssetState[] = ['covered', 'acked', 'maintenance', 'muted'];
export const STATE_LABEL: Record<AssetState, string> = { missing: 'Missing', late: 'Late', delayed: 'Delayed', covered: 'Covered by HA', acked: 'Acknowledged',
  ok: 'Reporting', learning: 'Learning', maintenance: 'Maintenance', muted: 'Muted' };
export const SIGNAL_LABEL: Record<Exclude<Signal, ''>, string> = { clock_skew: 'Clock ahead', delayed: 'Arriving late', low_volume: 'Low volume' };
export const countStates = (list: Entity[]) => {
  const c = Object.fromEntries(STATE_ORDER.map((s) => [s, 0])) as Record<AssetState, number>;
  list.forEach((e) => { c[e.state] = (c[e.state] ?? 0) + 1; }); return c;
};
/** Assets that should be reporting right now (not learning, not deliberately silenced). */
export const isLive = (e: Entity) => e.state !== 'learning' && e.state !== 'muted' && e.state !== 'maintenance';
export const isUp = (e: Entity) => e.state === 'ok' || e.state === 'late' || e.state === 'delayed';
export const byUrgency = (a: Entity, b: Entity) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || pressure(b) - pressure(a);

/* ---------- diagnosis ---------- */
export type Verdict = 'host' | 'shared' | 'source' | 'group' | 'healthy' | 'learning' | 'muted' | 'delayed' | 'covered' | 'acked' | 'maintenance';
export type Check = { ok: boolean; text: string };
export type Diagnosis = { verdict: Verdict; headline: string; short: string; checks: Check[]; together: Entity[] };
const TOGETHER_S = 120; // stopped within 2 minutes of each other ⇒ probably one cause
const sn = (input: string) => input.split(':')[1] ?? input; // "syslog:in_syslog:tcp" → "in_syslog"

export function diagnose(e: Entity, all: Entity[], L: Learning): Diagnosis {
  const siblings = all.filter((x) => x.group === e.group && x.input === e.input && x.key !== e.key && isLive(x));
  const silentSib = siblings.filter((x) => x.raw === 'missing' || x.raw === 'late');
  const together = silentSib.filter((x) => Math.abs(x.last_seen - e.last_seen) <= TOGETHER_S);
  const groupSources = [...new Set(all.filter((x) => x.group === e.group).map((x) => x.input))];
  const deadSources = groupSources.filter((src) => { const l = all.filter((x) => x.group === e.group && x.input === src && isLive(x));
    return l.length > 0 && l.every((x) => x.raw === 'missing'); });
  const tolWhy = e.overridden ? `override ${fmtDur(e.tolerance_s)}`
    : `${fmtDur(e.tolerance_s)} = ${L.K} × learned ${fmtDur(e.gap_s)}${e.tolerance_s === L.MIN_GAP ? ', raised to the minimum' : e.tolerance_s === L.MAX_GAP ? ', capped at the maximum' : ''}`;
  const checks: Check[] = [];
  const peers = e.cluster ? all.filter((x) => x.cluster === e.cluster && x.key !== e.key) : [];

  if (e.state === 'maintenance') return { verdict: 'maintenance', headline: `In a maintenance window (${e.maintenance}). Silence is expected and no alert is sent.`, short: 'maintenance window', checks, together: [] };
  if (e.state === 'muted') return { verdict: 'muted', headline: 'Muted — no alert is sent for this asset.', short: 'muted', checks, together: [] };
  if (e.state === 'learning') return { verdict: 'learning', headline: `Still learning its cadence (${e.active_min} active minutes so far, needs ${L.LEARN_MIN}).`,
    short: `learning, ${e.active_min} of ${L.LEARN_MIN} min`, checks, together: [] };

  const silentTxt = isUp(e) ? `Sending — last event ${fmtDur(e.silent_s)} ago (alerts after ${tolWhy})`
    : `No events for ${fmtDur(e.silent_s)} — tolerance ${tolWhy}`;
  checks.push({ ok: isUp(e), text: silentTxt });
  const working = siblings.length - silentSib.length;
  if (siblings.length) checks.push({ ok: working > 0, text: working > 0 ? `Source ${sn(e.input)} still receives from ${working} other asset${working > 1 ? 's' : ''}` : `No other asset on ${sn(e.input)} is sending either` });
  if (together.length) checks.push({ ok: false, text: `${together.length} other asset${together.length > 1 ? 's' : ''} on ${sn(e.input)} stopped within 2 min of this one (${together.slice(0, 3).map((x) => x.asset).join(', ')}${together.length > 3 ? '…' : ''})` });
  checks.push({ ok: deadSources.length <= 1, text: deadSources.length > 1 ? `${deadSources.length} sources in ${e.group} have gone fully silent — group-wide` : `Other sources in ${e.group} are sending` });
  if (peers.length) { const up = peers.filter(isUp).length; checks.push({ ok: up > 0, text: `HA cluster ${e.cluster}: ${up} of ${peers.length} other member${peers.length > 1 ? 's' : ''} sending` }); }
  if (e.max_lag_s > 0 || e.lag_now_s > 0) checks.push({ ok: e.lag_now_s <= L.LAG_MAX, text: e.lag_now_s <= L.LAG_MAX ? `Event lag normal (now ${fmtDur(e.lag_now_s)}, worst ${fmtDur(e.max_lag_s)} in the loaded window)` : `Events arrive ${fmtDur(e.lag_now_s)} after they happened — data is late, not lost` });
  if (e.signal === 'clock_skew') checks.push({ ok: false, text: `Some events are stamped ${fmtDur(-e.min_lag_s)} in the future — the sender's clock is ahead` });
  if (e.signal === 'low_volume') checks.push({ ok: false, text: `Last hour carried ${Math.round(e.vol_ratio * 100)}% of its usual volume — still sending, but much less` });

  if (e.state === 'covered') return { verdict: 'covered', short: `covered by ${e.cluster}`, checks, together,
    headline: `Silent, but its HA cluster ${e.cluster} still has enough members sending, so no alert is sent. It alerts if the cluster drops below its minimum.` };
  if (e.state === 'acked') return { verdict: 'acked', short: 'acknowledged', checks, together,
    headline: 'Acknowledged. The acknowledgement ends by itself as soon as the asset sends again, so the next silence alerts normally.' };
  if (e.state === 'delayed') return { verdict: 'delayed', short: `arriving ${fmtDur(e.lag_now_s)} late`, checks, together,
    headline: `Data is arriving, but ${fmtDur(e.lag_now_s)} after it was produced. Look at a backlog upstream (forwarder queue, collector schedule, clock) rather than a dead host.` };
  if (isUp(e) && e.state === 'ok') return { verdict: 'healthy', headline: e.signal ? `Reporting, with a signal: ${SIGNAL_LABEL[e.signal as Exclude<Signal, ''>]}.` : 'Reporting normally.', short: 'reporting', checks, together: [] };
  const pct = Math.round(pressure(e) * 100);
  if (deadSources.length > 1) return { verdict: 'group', short: `${deadSources.length} sources silent in ${e.group}`,
    headline: `Several sources in ${e.group} went silent at once. Look at the worker group (workers, network, license) before the hosts.`, checks, together };
  if (siblings.length && working === 0) return { verdict: 'source', short: `whole source ${sn(e.input)} silent`,
    headline: `Nothing on ${sn(e.input)} is arriving. The Cribl source itself (port, TLS, token, upstream forwarder) is the likely cause, not this host.`, checks, together };
  if (together.length) return { verdict: 'shared', short: `stopped with ${together.length} other${together.length > 1 ? 's' : ''} on ${sn(e.input)}`,
    headline: `Stopped together with ${together.map((x) => x.asset).slice(0, 3).join(', ')}${together.length > 3 ? '…' : ''}; the rest of ${sn(e.input)} is fine. Look for a shared cause — a deploy, a network segment, a common forwarder.`, checks, together };
  return { verdict: 'host', short: e.state === 'late' ? `${pct}% of tolerance, alerts at ${fmtDur(e.tolerance_s)}` : 'only this asset is silent',
    headline: e.state === 'late' ? `Quieter than usual: ${pct}% of its tolerance. It alerts if still silent at ${fmtDur(e.tolerance_s)}.`
      : `Only this asset stopped; ${sn(e.input)} is receiving from the others. Look at the host — agent, service, local config, disk.`, checks, together };
}

export const HISTORY_INCOMPLETE = 'History incomplete for this range — narrow it';
export const noEventsText = (silentS?: number) => `No events in this range · last seen ${silentS !== undefined && Number.isFinite(silentS) ? `${fmtDur(silentS)} ago` : 'before this range'}`;
