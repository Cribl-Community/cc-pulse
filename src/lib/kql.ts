import { effectiveRollup, type AppSettings } from './settings';
import { cadenceOf, normalizeLoad, type Cadence, type SavedId } from './cadence';
import { rollupDataset, rollupWindow, ROLLUP_SPAN } from './rollup';
import { lifecycleColumns, runSummary, san } from './routes';
/** Spec 026's constants, at their Standard values (026's gate reads them). The queries take theirs from the cadence. */
export { ROLLUP_SPAN, TAIL_S, ROLLUP_MAX_LAG_S } from './rollup';
/* Pulse detection logic. Entity = (worker_group, input, asset). Learned cadence: expected_gap = span/active minutes;
   tolerance = clamp(K × gap, MIN_GAP, MAX_GAP) unless an override sets it. Constants are inlined as literals (not
   `let`) because the alert searches reuse the body inside join sub-queries.
   States, strongest first (suppressions win over alarms):
     maintenance · muted · acked (until the asset sends again) · learning · missing · late · delayed · ok
   Signals (badges, never alerts on their own): clock_skew · delayed · low_volume
   Lookups the body needs — all published by the app: pulse_overrides, pulse_assets, pulse_maintenance. */

/** Spec 033: every cron and window below follows the search load. A settings object without searchLoad (a caller
 *  that predates 033) is Standard. */
const cadence = (s: AppSettings): Cadence => cadenceOf(normalizeLoad(s.searchLoad), s.rollCall);
/** The rollup window in force (Standard's when the load has none: the daily rollup search is disabled, never read). */
const rwin = (s: AppSettings) => rollupWindow(normalizeLoad(s.searchLoad));
/** newly_missing window: one run of the saved searches plus 60 s of slack, so an incident is never skipped. */
const RUN_EVERY = (s: AppSettings) => cadence(s).runEvery;

/** Spec 026: rollup mode unless the settings say 'off'. A settings object without the field (a caller that predates
 *  spec 026, e.g. the spec 015 gate) reads raw; loadSettings() always fills it, with 'auto' as the default.
 *  Spec 033: effectiveRollup, so the daily load always reads raw. */
export const rollupOn = (s: AppSettings) => (effectiveRollup(s) ?? 'off') !== 'off';

/** Readers dedupe the rollup: every bucket is written by about two runs. Cribl KQL has no arg_max / max_by, and
 *  take_any(*) doesn't expand the row (probed on the org, 2026-11-13), so each column takes one aggregate. The copies
 *  are identical, and a later copy can only grow its bucket (late events): counts, last_* and the lag max go up,
 *  first_* and the lag min go down, so max / min give the newest copy's values. */
const DEDUPE = `summarize events=max(events), bytes=max(bytes), active_min=max(active_min), first_min=min(first_min), last_min=max(last_min),
            first_s=min(first_s), last_s=max(last_s), in_gap_start=max(in_gap_start), in_gap_end=max(in_gap_end),
            max_lag_s=max(max_lag_s), min_lag_s=min(min_lag_s), asset_src=max(asset_src), written_at=max(written_at)
          by worker_group, input, asset, bucket`;

/** The cut between the rollup (buckets < cut) and the raw tail (events >= cut). */
const CUT = (s: AppSettings) => `bin(now() - ${rwin(s).tailS}, ${ROLLUP_SPAN})`;

/** Raw mode (and rollup 'off'): one summarize over the raw dataset. Byte-identical to the pre-026 body. */
const rawHead = (s: AppSettings) => `dataset="${s.dataset}" _metric=="pulse.heartbeat"
| extend minute = bin(_time, 60)
| summarize first_seen=min(_time), last_seen=max(_time), active_min=dcount(minute),
            events=sum(_value), bytes=sum(bytes), max_lag_s=max(event_lag_s), min_lag_s=min(event_lag_s),
            lag_now_s=maxif(event_lag_s, _time > now() - 900), events_1h=sumif(_value, _time > now() - 3600),
            key_src=max(asset_src)
          by worker_group, input, asset`;

/** Rollup mode: the deduped rollup up to the cut, plus the raw tail summarized per entity and bucket inside the raw
 *  dataset (dcount there only), then one sum per entity across both. Same columns as rawHead.
 *  first_seen / last_seen come from the exact first_s / last_s (to the second, like raw); the coalesce only covers
 *  bucket rows written before those columns existed. */
const rollupHead = (s: AppSettings) => `dataset="${rollupDataset(s.dataset)}"
| where bucket < ${CUT(s)}
| ${DEDUPE}
| extend first_seen = coalesce(first_s, first_min), last_seen = coalesce(last_s, last_min), key_src = asset_src, events_1h = iff(bucket > now() - 3600, events, 0)
| project worker_group, input, asset, bucket, first_seen, last_seen, active_min, events, bytes, max_lag_s, min_lag_s, events_1h, key_src
| union (dataset="${s.dataset}" _metric=="pulse.heartbeat"
  | where _time >= ${CUT(s)}
  | extend minute = bin(_time, 60), bucket = bin(_time, ${ROLLUP_SPAN})
  | summarize first_seen=min(_time), last_seen=max(_time), active_min=dcount(minute),
              events=sum(_value), bytes=sum(bytes), max_lag_s=max(event_lag_s), min_lag_s=min(event_lag_s),
              lag_now_s=maxif(event_lag_s, _time > now() - 900), events_1h=sumif(_value, _time > now() - 3600),
              key_src=max(asset_src)
            by worker_group, input, asset, bucket)
| summarize first_seen=min(first_seen), last_seen=max(last_seen), active_min=sum(active_min),
            events=sum(events), bytes=sum(bytes), max_lag_s=max(max_lag_s), min_lag_s=min(min_lag_s),
            lag_now_s=max(lag_now_s), events_1h=sum(events_1h), key_src=max(key_src)
          by worker_group, input, asset`;

/** Rollup mode: one summarize of the rollup's newest bucket, and `rollup_ok` = that bucket is within the cadence's
 *  rollup.maxLagS (ROLLUP_MAX_LAG_S in Standard). */
const rollupFlag = (s: AppSettings) => `
| extend rk = 1
| join kind=leftouter (dataset="${rollupDataset(s.dataset)}"
  | summarize newest_bucket=max(bucket)
  | extend rk = 1) on rk
| extend rollup_ok = isnotnull(newest_bucket) and now() - newest_bucket <= ${rwin(s).maxLagS}`;

/** pulse_state in rollup mode: output `rollup_ok` as a column and keep every row (its readers filter on it). */
const stateFlag = (s: AppSettings) => rollupOn(s) ? `${rollupFlag(s)}
| project-away rk, newest_bucket` : '';

/** One pulse_maintenance lookup: `out` = the open window's reason for `key`, or "". */
const mw = (key: string, out: string) => `| extend mw_key = ${key}
| lookup pulse_maintenance on mw_key
| extend ${out} = iff(isnotnull(mw_start) and now() >= todouble(mw_start) and now() < todouble(mw_end), coalesce(mw_reason, "maintenance"), "")
| project-away mw_start, mw_end, mw_reason`;
/** The three maintenance windows (fleet "*", group "g:", source "i:") folded into `maintenance`, the source window first. */
const maintenanceCols = `${mw('"*"', 'mw_all')}
${mw('strcat("g:", worker_group)', 'mw_grp')}
${mw('strcat("i:", worker_group, "|", input)', 'mw_src')}
| extend maintenance = case(mw_src != "", mw_src, mw_grp != "", mw_grp, mw_all)`;

export function body(s: AppSettings) {
  const L = s.learning;
  return `${rollupOn(s) ? rollupHead(s) : rawHead(s)}
| extend silent_raw = now() - last_seen - 60
| extend silent_s = iff(silent_raw < 0, 0.0, silent_raw)
| extend span_min = max_of(1, (last_seen - first_seen) / 60 + 1)
| extend expected_gap_s = round(60 * span_min / active_min, 0)
| extend vol_ratio = iff(span_min >= 180 and events > 0, round(events_1h * span_min / (60.0 * events), 2), 1.0)
| lookup pulse_overrides on input, asset
| extend ov_on = isnotnull(action) and action != "none" and (isnull(until_s) or todouble(until_s) <= 0 or todouble(until_s) > now())
| extend tolerance_s = iff(ov_on and action == "threshold" and todouble(max_gap_s) > 0, todouble(max_gap_s), max_of(${L.MIN_GAP}, min_of(${L.K} * expected_gap_s, ${L.MAX_GAP})))
| lookup pulse_assets on asset
${maintenanceCols}
| extend raw_state = case(active_min < ${L.LEARN_MIN}, "learning", silent_s > tolerance_s, "missing", silent_s > 0.6 * tolerance_s, "late", "ok")
| extend signal = case(min_lag_s < -${L.FUTURE_S}, "clock_skew", lag_now_s > ${L.LAG_MAX}, "delayed", raw_state == "ok" and vol_ratio < ${L.VOL_MIN}, "low_volume", "")
| extend state = case(maintenance != "", "maintenance", ov_on and action == "mute", "muted",
                      ov_on and action == "ack" and raw_state in ("missing", "late") and last_seen <= todouble(ack_seen) + 1, "acked",
                      raw_state == "ok" and signal == "delayed", "delayed", raw_state)
| extend newly_missing = state == "missing" and silent_s > tolerance_s + ${L.GRACE_S} and silent_s <= tolerance_s + ${L.GRACE_S} + ${RUN_EVERY(s)}`;
}

const ENTITY_COLS = 'worker_group, input, asset, state, raw_state, signal, newly_missing, silent_min, tolerance_s, expected_gap_s, active_min, events, events_1h, vol_ratio, bytes, max_lag_s, lag_now_s, min_lag_s, key_src, maintenance, criticality, team, cluster, cluster_min, last_seen_utc, last_seen';
export const entityQuery = (s: AppSettings) => `${body(s)}
| extend silent_min = round(silent_s / 60, 1), last_seen_utc = strftime(last_seen, "%Y-%m-%dT%H:%M:%SZ")
| project ${ENTITY_COLS}`;

/** Per source: assets reporting vs expected (the learned set). */
export const sourceQuery = (s: AppSettings) => `${body(s)}
| extend missing_asset = iff(state == "missing", asset, null)
| summarize expected = countif(state in ("ok", "late", "missing", "delayed", "acked")), current = countif(state in ("ok", "late", "delayed")),
            missing = countif(state == "missing"), late = countif(state == "late"),
            learning = countif(state == "learning"), muted = countif(state in ("muted", "maintenance")),
            missing_list = values(missing_asset) by worker_group, input
| extend health = case(missing > 0, "degraded", expected == 0, "learning", "healthy")`;

const hb = (s: AppSettings) => `dataset="${s.dataset}" _metric=="pulse.heartbeat"`;
const q = (v: string) => JSON.stringify(v);

/** Fleet activity for sparklines and the fleet heartbeat: events per `span` seconds per entity. */
export const activityQuery = (s: AppSettings, span = 1800, group?: string) => `${hb(s)}${group ? ` worker_group==${q(group)}` : ''}
| extend b = bin(_time, ${span})
| summarize events=sum(_value) by worker_group, input, asset, b`;

/** Fleet heartbeat (Overview hero): events and distinct reporting assets per `span` seconds, whole fleet. */
export const fleetQuery = (s: AppSettings, span = 300) => `${hb(s)}
| extend b = bin(_time, ${span})
| summarize events=sum(_value), assets=dcount(strcat(worker_group, "|", input, "|", asset)) by b`;

/** One entity: events per `span` seconds (span=60 gives the minute grid used to replay gaps). */
export const entityActivityQuery = (s: AppSettings, input: string, asset: string, span = 600) =>
  `${hb(s)} input==${q(input)} asset==${q(asset)}
| extend b = bin(_time, ${span})
| summarize events=sum(_value), max_lag_s=max(event_lag_s) by b`;

/** Gap ledger (spec 009): every silence longer than 2 min, per entity. The app turns it into availability,
 *  incidents and flapping with each entity's own tolerance. */
export const gapsQuery = (s: AppSettings, group?: string) => `${hb(s)}${group ? ` worker_group==${q(group)}` : ''}
| extend minute = bin(_time, 60)
| summarize ev=sum(_value) by worker_group, input, asset, minute
| sort by worker_group, input, asset, minute asc
| extend k = strcat(worker_group, "|", input, "|", asset)
| extend pk = prev(k), pm = prev(minute)
| where pk == k and minute - pm > 120
| project worker_group, input, asset, gap_start=pm, gap_end=minute, gap_s=minute - pm`;

/* ---------- spec 026: history queries in rollup mode ---------- */
/** A history window in epoch seconds. `nowS` is the clock the cut is computed from. `rollupFromS` is the oldest
 *  bucket the rollup holds (from the rollup check): a window that starts before it reads raw, since the rollup would
 *  come back short there. Undefined means no limit is known (tests, the parity script). */
export interface HistoryWindow { earliestS: number; latestS: number; nowS: number; rollupFromS?: number }
/** What the caller runs: `rollup` is bounded at the cut; `raw` is either the whole raw query (no rollup) or the raw
 *  tail from the cut onward. The caller merges the two results. */
export interface HistoryParts { mode: 'raw' | 'rollup' | 'rollup+tail'; rollup?: string; raw?: string }

/** The cut for a given bin span, aligned to that span (matches the tail cut used by body()). Without settings, or in
 *  Standard, the tail is TAIL_S; otherwise the cadence's rollup.tailS. */
export const historyCutS = (nowS: number, span: number, s?: AppSettings) => Math.floor((nowS - rollupWindow(normalizeLoad(s?.searchLoad)).tailS) / span) * span;
const cutExpr = (s: AppSettings, span: number) => `bin(now() - ${rwin(s).tailS}, ${span})`;

/** Rollup is used only for 'auto', span >= 300 s, a window longer than 1 h, and a window the rollup reaches back to. */
export function rollupApplies(s: AppSettings, span: number, w?: HistoryWindow): boolean {
  return !!w && rollupOn(s) && span >= ROLLUP_SPAN && w.latestS - w.earliestS > 3600
    && (w.rollupFromS === undefined || w.earliestS >= w.rollupFromS);
}

function plan(s: AppSettings, span: number, w: HistoryWindow | undefined, rollup: (cut: string) => string, tail: (cut: string) => string, raw: string): HistoryParts {
  if (!w || !rollupApplies(s, span, w)) return { mode: 'raw', raw };
  const cut = cutExpr(s, span);
  if (w.latestS <= historyCutS(w.nowS, span, s)) return { mode: 'rollup', rollup: rollup(cut) };
  return { mode: 'rollup+tail', rollup: rollup(cut), raw: tail(cut) };
}

const rollupHist = (s: AppSettings, cut: string, group?: string) => `dataset="${rollupDataset(s.dataset)}"${group ? ` worker_group==${q(group)}` : ''}
| where bucket < ${cut}
| ${DEDUPE}`;

/** activityQuery in rollup mode. Raw (unchanged text) for ≤ 1 h windows, 'off' or spans < 300 s. */
export function activityParts(s: AppSettings, span = 1800, group?: string, w?: HistoryWindow): HistoryParts {
  return plan(s, span, w,
    (cut) => `${rollupHist(s, cut, group)}
| extend b = bin(bucket, ${span})
| summarize events=sum(events) by worker_group, input, asset, b`,
    (cut) => `${hb(s)}${group ? ` worker_group==${q(group)}` : ''}
| where _time >= ${cut}
| extend b = bin(_time, ${span})
| summarize events=sum(_value) by worker_group, input, asset, b`,
    activityQuery(s, span, group));
}

/** fleetQuery in rollup mode. Entities are unique per bucket after the dedupe, so counting them per bin is exact. */
export function fleetParts(s: AppSettings, span = 300, w?: HistoryWindow): HistoryParts {
  return plan(s, span, w,
    (cut) => `${rollupHist(s, cut)}
| extend b = bin(bucket, ${span}), k = strcat(worker_group, "|", input, "|", asset)
| summarize events=sum(events) by b, k
| summarize events=sum(events), assets=count() by b`,
    (cut) => `${hb(s)}
| where _time >= ${cut}
| extend b = bin(_time, ${span}), k = strcat(worker_group, "|", input, "|", asset)
| summarize events=sum(_value) by b, k
| summarize events=sum(events), assets=count() by b`,
    fleetQuery(s, span));
}

/** gapsQuery in rollup mode: gaps inside a bucket (in_gap_*) plus gaps between consecutive buckets of an entity.
 *  A gap that straddles the cut is not produced by either part; the caller joins the last rollup row to the tail. */
export function gapsParts(s: AppSettings, group?: string, w?: HistoryWindow): HistoryParts {
  return plan(s, ROLLUP_SPAN, w,
    // Two legs (Cribl KQL has no mv-expand over a dynamic literal, probed 2026-11-13): gaps between consecutive buckets
    // of an entity, then the inner gap of each bucket.
    (cut) => `${rollupHist(s, cut, group)}
| sort by worker_group, input, asset, bucket asc
| extend k = strcat(worker_group, "|", input, "|", asset)
| extend pk = prev(k), pl = prev(last_min)
| where pk == k and first_min - pl > 120
| project worker_group, input, asset, gap_start=pl, gap_end=first_min, gap_s=first_min - pl
| union (${rollupHist(s, cut, group)}
  | where isnotnull(in_gap_start)
  | project worker_group, input, asset, gap_start=in_gap_start, gap_end=in_gap_end, gap_s=in_gap_end - in_gap_start)`,
    (cut) => gapsQuery(s, group).replace('\n| extend minute', `\n| where _time >= ${cut}\n| extend minute`),
    gapsQuery(s, group));
}

/** The two edges of the gaps cut (rollup+tail mode only): each entity's last minute before the cut, from the rollup,
 *  and its first minute at or after the cut, from the raw tail. joinCutGaps (series.ts) turns them into the gap that
 *  straddles the cut, which neither gapsParts part produces. */
export function gapsCutEdges(s: AppSettings, group?: string): { rollup: string; raw: string } {
  const cut = cutExpr(s, ROLLUP_SPAN);
  return {
    rollup: `${rollupHist(s, cut, group)}
| summarize last_min=max(last_min) by worker_group, input, asset`,
    raw: `${hb(s)}${group ? ` worker_group==${q(group)}` : ''}
| where _time >= ${cut}
| extend minute = bin(_time, 60)
| summarize first_min=min(minute) by worker_group, input, asset`,
  };
}

/** Raw samples sent by the pack for the Key Advisor (spec 003). */
export const samplesQuery = (s: AppSettings, input: string) => `dataset="${s.dataset}" (kind=="pulse.sample" or isnotnull(raw_sample)) input==${q(input)}
| sort by _time desc
| limit 300
| project _time, worker_group, input, raw_sample, fields_json, src_ip`;

export const lookbackSeconds = (lb: string) => { const m = lb.match(/^-(\d+)([mhd])$/); return m ? Number(m[1]) * { m: 60, h: 3600, d: 86400 }[m[2] as 'm' | 'h' | 'd'] : 86400; };
/** Assets seen in the last 7 days that are absent from the detection window (spec 009). */
export const retiredQuery = (s: AppSettings) => `${hb(s)}
| summarize last_seen=max(_time), first_seen=min(_time), events=sum(_value), key_src=max(asset_src) by worker_group, input, asset
| where last_seen < now() - ${lookbackSeconds(s.learning.LOOKBACK)}
| sort by last_seen desc`;

/* ---------- scheduled searches (spec 005) ---------- */
const live = 'state != "muted" and state != "maintenance" and raw_state != "learning"';
/** A values() array as "a,b" (its JSON form, brackets and quotes dropped), and as "a, b" for messages. */
const unjson = (col: string) => String.raw`replace_regex(tostring(${col}), @'[\[\]"]', "")`;
const listText = (col: string) => `replace_regex(${unjson(col)}, ",", ", ")`;
/** Inventory lookups write "" for an unset criticality or team (inventory.ts), and coalesce only replaces null:
 *  isempty() covers both, so an asset with a team but no criticality is P3, not "" (toint("") is null and would drop
 *  the row from a route's `not (...)`), and the JSON event never gets an empty number. */
const crit3 = String.raw`iff(isempty(tostring(criticality)), "3", tostring(criticality))`;
const teamOr = String.raw`iff(isempty(tostring(team)), "unassigned", tostring(team))`;
/** Latest $vt_results run for a saved search (one row per key after the filter). */
const latestRun = (job: string, col: string) =>
  `dataset="$vt_results" | where jobName == "${job}" | eventstats mx = max(${col}) | where ${col} == mx`;
/** Spec 030 §1: an alert search reads its ledger writer's latest run and keeps the (incident_id, event) pairs that no
 *  earlier run of this alert search sent (leftanti), so a pair is never sent twice. */
const alertFeed = (kind: 'asset' | 'source', job: string) =>
  `${latestRun(`pulse_ledger_${kind}`, 'computed_at')}
| where event in ("opened", "resolved", "reminder", "expired")
| join kind=leftanti (dataset="$vt_results" | where jobName == "${job}" | project incident_id, event) on incident_id, event
| extend alerted_at = now()`;
const alertState = `| extend state = iff(event in ("opened", "reminder"), "firing", "resolved"), event = tostring(event)`;
/** The tracking window in hours, for the *Closed: … left the 24 h window* text. */
const windowH = (s: AppSettings) => Math.round((lookbackSeconds(s.learning.LOOKBACK) / 3600) * 10) / 10;
function alertMissing(s: AppSettings) {
  // Per-row columns here; n_alerts / others / more_s come from runSummary (routes.ts), one pass with eventstats.
  // Route and default searches recompute the summary over the rows they keep.
  return `${alertFeed('asset', 'pulse_alert_missing')}
| extend criticality = ${crit3}, team = ${teamOr}, silent_min = coalesce(todouble(silent_min), 0), tolerance_s = coalesce(todouble(tolerance_s), 0)
| extend severity = case(criticality == "1", "critical", criticality == "2", "error", criticality == "3", "warning", "info")
| extend asset_s = ${san('asset', 32)}, asset_u = substring(url_encode(asset), 0, 96), input_s = ${san('input', 32)}, worker_group_s = ${san('worker_group', 32)}, team_s = ${san('team', 32)}
${alertState}
| extend incident_id_s = ${san('incident_id', 140)}${lifecycleColumns('missing', windowH(s))}${runSummary('missing')}`;
}
/** Spec 030 §1: the incident ledger writer. Reads the pulse_state snapshot, its own latest run (prev) and the alert
 *  search's latest run (delivered); writes one row per entity (event "none" when nothing happens) plus lifecycle rows. */
/** The union branch: the open incidents missing from `snap`. An empty `snap` (pulse_state late or skipped, or the rollup
 *  lagging: `rollup_ok` is one flag for the whole run) says nothing about the entities, so it must not expire them.
 *  The branch starts from snap's one-row count (n_snap) and leftouter-joins the open incidents the leftanti left (all of
 *  them when snap is empty). `up` = snap has rows: then `expired` as before. Not `up`: every open incident is carried
 *  forward as it is (`open`, or its pending event, still pending), and with no open incident the null row becomes one
 *  "none" row, so the output is never empty and two late runs in a row never make the next run seed again. */
const gone = (snap: string, prev: string, anti: string, key: string, cols: string) => `
| union (${snap} | summarize n_snap = count() | extend one = 1
  | join kind=leftouter (${prev}
    | join kind=leftanti (${anti}) on ${key} | extend one = 1) on one
  | extend up = n_snap > 0
  | where up == false or (isnotnull(pe) and (pend == false or pe != "opened"))
  | project ${cols}, event = case(isnull(pe), "none", up, iff(pe in ("resolved", "expired"), pe, "expired"), pend, pe, "open"), opened_at = po, notified_at = pt, last_seen_at_open = pl)`;
/** Spec 030 §3 seeding: n_led counts the writer's real ledger rows only. Every real row (main branch or an incident
 *  carried by gone()) has opened_at set; the placeholder "none" row gone() emits when there is no fresh pulse_state run
 *  and no open incident has opened_at = po = null (and a null key). Counting it would end seeding on a run that saw no
 *  snapshot, and the next run would open (notify) every asset that was already missing. */
const nLed = 'summarize n_led = countif(isnotnull(opened_at)) | extend one = 1';
function ledgerAsset(s: AppSettings) {
  const L = s.learning;
  const rh = s.notify?.remindH ?? 0;
  // Grace before alerting (Settings → Alerts): an asset opens only once it has stayed silent GRACE_S past its
  // tolerance: silent_s > tolerance_s + GRACE_S, with silent_s = computed_at - last_seen - 60 as body() computes it at
  // the snapshot's computed_at (the 60 is folded into the constant), so a blip that recovers sooner never opens. Only
  // the opening test uses it: an open incident still resolves as soon as the asset is back. The writer no longer
  // re-rounds silent_min (pulse_state already rounds it; the alert search coalesces it), to stay under 4000 chars.
  // Eligibility is today's alert filter (newly_missing): `state == "missing"`, which already implies live (not muted, not
  // in maintenance, not learning) and raw_state "missing", and also excludes `acked`: suppressions gate opening.
  const g = Number(L.GRACE_S) || 0;
  const grace = g > 0 ? ` and computed_at - last_seen > todouble(tolerance_s) + ${g + 60}` : '';
  const snap = `dataset="$vt_results" | where jobName == "pulse_state" | where computed_at >= now() - 300${rollupOn(s) ? '\n| where rollup_ok' : ''}`;
  const prev = `${latestRun('pulse_ledger_asset', 'computed_at')} | where event != "none"
| join kind=leftouter (${latestRun('pulse_alert_missing', 'alerted_at')} | project incident_id, event, dl = 1) on incident_id, event
| extend pend = event != "open" and isnull(dl)
| where pend or event in ("open", "opened", "reminder")
| project worker_group, input, asset, pe = event, po = opened_at, pt = notified_at, pl = last_seen_at_open, pc = criticality, pm = team, pend`;
  return `${snap}
| extend lv = ${live}
| eventstats s_live=countif(lv), s_missing=countif(lv and raw_state == "missing") by worker_group, input
| join kind=leftouter (${snap}
  | where isempty(cluster) == false | extend lv = ${live}
  | summarize c_n=countif(lv), c_up=countif(lv and raw_state in ("ok", "late")) by cluster) on cluster
| extend collective = s_live >= ${L.SRC_MIN} and s_missing >= ${L.SRC_PCT} * s_live
| extend covered = isnotnull(c_n) and c_n > 0 and c_up * 100 >= coalesce(todouble(cluster_min), 50) * c_n
| extend miss = (raw_state in ("ok", "late")) == false, elig = state == "missing" and (collective or covered) == false${grace}, one = 1
| extend criticality = ${crit3}, team = ${teamOr}
| join kind=leftouter (${prev}) on worker_group, input, asset
| join kind=leftouter (dataset="$vt_results" | where jobName == "pulse_ledger_asset" | ${nLed}) on one
| extend reuse = isnotnull(pe)
| extend event = case(reuse == false, iff(miss and elig, iff(n_led > 0, "opened", "open"), "none"),
    pe in ("resolved", "expired"), pe, pend, iff(miss, pe, iff(pe == "opened", "none", "resolved")),
    miss == false, "resolved",${rh > 0 ? `
    now() - pt >= ${rh * 3600} and (state in ("acked", "muted", "maintenance")) == false, "reminder",` : ''} "open")
| extend opened_at = iff(reuse, po, toint(now())), last_seen_at_open = iff(reuse, pl, last_seen),
    notified_at = case(reuse == false, toint(now()), event == "reminder" and pend == false, toint(now()), pt)
${gone(snap, prev, snap, 'worker_group, input, asset', 'worker_group, input, asset, criticality = pc, team = pm')}
| extend incident_id = strcat("pulse:asset:", worker_group, ":", input, ":", asset, ":", tostring(opened_at)), computed_at = now()`;
}
/** Spec 030 §1, source kind: keyed on worker_group, input (asset empty); delivery is pulse_alert_source_down.
 *  crit_min / teams aggregate the currently missing assets only, so a recovered source has none. A reused row (open,
 *  resolved, reminder, a retried event) keeps the values its incident opened with (pc / pm), as the expired branch
 *  does: spec §3, routes match every lifecycle row "because the row keeps the asset's criticality and team", so a P1
 *  or team route that got `opened` also gets `resolved` (and PagerDuty Events v2 auto-resolves). */
function ledgerSource(s: AppSettings) {
  const L = s.learning;
  const rh = s.notify?.remindH ?? 0;
  const snap = `dataset="$vt_results" | where jobName == "pulse_state" | where computed_at >= now() - 300${rollupOn(s) ? '\n| where rollup_ok' : ''}`;
  const prev = `${latestRun('pulse_ledger_source', 'computed_at')} | where event != "none"
| join kind=leftouter (${latestRun('pulse_alert_source_down', 'alerted_at')} | project incident_id, event, dl = 1) on incident_id, event
| extend pend = event != "open" and isnull(dl)
| where pend or event in ("open", "opened", "reminder")
| project worker_group, input, pe = event, po = opened_at, pt = notified_at, pl = last_seen_at_open, pc = crit_min, pm = teams, pend`;
  const ents = `${snap}
| extend lv = ${live}
| extend lm = lv and raw_state == "missing"
| extend missing_asset = iff(lm, asset, null), crit_n = iff(lm, toint(${crit3}), null), team_n = iff(lm, ${teamOr}, null)
| summarize s_live=countif(lv), s_missing=countif(lm), last_seen=max(last_seen),
            missing_list=values(missing_asset), crit_min=min(crit_n), teams=values(team_n) by worker_group, input
| extend pct = round(100.0 * s_missing / s_live, 0), asset = ""
| extend elig = s_live >= ${L.SRC_MIN} and s_missing >= ${L.SRC_PCT} * s_live
| extend raw_state = iff(elig, "missing", "ok"), state = raw_state, miss = elig, one = 1`;
  return `${ents}
| join kind=leftouter (${prev}) on worker_group, input
| join kind=leftouter (dataset="$vt_results" | where jobName == "pulse_ledger_source" | ${nLed}) on one
| extend reuse = isnotnull(pe)
| extend event = case(reuse == false, iff(miss and elig, iff(n_led > 0, "opened", "open"), "none"),
    pe in ("resolved", "expired"), pe, pend, iff(miss, pe, iff(pe == "opened", "none", "resolved")),
    miss == false, "resolved",${rh > 0 ? `
    now() - pt >= ${rh * 3600}, "reminder",` : ''} "open")
| extend opened_at = iff(reuse, po, toint(now())), last_seen_at_open = iff(reuse, pl, last_seen),
    notified_at = case(reuse == false, toint(now()), event == "reminder" and pend == false, toint(now()), pt),
    crit_min = iff(reuse, toint(pc), crit_min), teams = iff(reuse, pm, teams)
${gone(snap, prev, `${snap} | summarize n_e = count() by worker_group, input`, 'worker_group, input', 'worker_group, input, crit_min = pc, teams = pm')}
| extend asset = "", incident_id = strcat("pulse:source:", worker_group, ":", input, "::", tostring(opened_at)), computed_at = now()`;
}
export function ledgerQuery(s: AppSettings, kind: 'asset' | 'source'): string {
  return kind === 'asset' ? ledgerAsset(s) : ledgerSource(s);
}

/** Digest columns (029 contract in routes.ts ALERT_COLUMNS.digest). A digest is a summary, not a lifecycle
 *  event: no state, event, or incident_id. teams_j is ",a,b," so a route can match one team exactly with contains_cs. */
const groupedColumns = (kind: 'digest') => `
| extend crit_min = coalesce(crit_min, 3)
| extend teams_l = ${unjson('teams')}
| extend teams_j = strcat(",", teams_l, ","), severity = case(crit_min == 1, "critical", crit_min == 2, "error", crit_min == 3, "warning", "info")
| extend input_s = ${san('input', 32)}, input_u = substring(url_encode(input), 0, 96), worker_group_s = ${san('worker_group', 32)},
         teams_s = ${san(listText('teams'), 48)}, missing_s = ${san(listText('missing_list'), 160)}
| project-away teams_l${runSummary(kind)}`;
function alertSourceDown(s: AppSettings) {
  return `${alertFeed('source', 'pulse_alert_source_down')}
| extend s_live = coalesce(toint(s_live), 0), s_missing = coalesce(toint(s_missing), 0)
| extend pct = iff(s_live > 0, round(100.0 * s_missing / s_live, 0), 0)
| extend crit_min = coalesce(crit_min, 3)
| extend teams_l = ${unjson('teams')}
| extend teams_j = strcat(",", teams_l, ","), severity = case(crit_min == 1, "critical", crit_min == 2, "error", crit_min == 3, "warning", "info")
| extend input_s = ${san('input', 32)}, input_u = substring(url_encode(input), 0, 96), worker_group_s = ${san('worker_group', 32)},
         teams_s = ${san(listText('teams'), 48)}, missing_s = ${san(listText('missing_list'), 160)}
${alertState}
| extend incident_id_s = ${san('incident_id', 140)}${lifecycleColumns('source_down', windowH(s))}
| project-away teams_l${runSummary('source_down')}`;
}
function digest(s: AppSettings) {
  const ok = rollupOn(s) ? '\n| where rollup_ok' : '';
  return `dataset="$vt_results" | where jobName == "pulse_state" | where computed_at >= now() - 300${ok}
| extend missing_asset = iff(state == "missing", asset, null), signal_asset = iff(signal != "", strcat(asset, " (", signal, ")"), null)
| extend crit_n = iff(state == "missing", toint(${crit3}), null), team_n = iff(state == "missing", ${teamOr}, null)
| summarize expected = countif(${live}), current = countif(${live} and raw_state in ("ok", "late")), missing = countif(state == "missing"),
            signals = countif(signal != ""), missing_list = values(missing_asset), signal_list = values(signal_asset),
            crit_min = min(crit_n), teams = values(team_n) by worker_group, input
| where missing > 0 or signals > 0${groupedColumns('digest')}
| extend signals_s = ${san(listText('signal_list'), 60)}`;
}

/** Spec 026: writes closed 5-minute buckets to the rollup dataset. Minute grain, inner gap via prev(), then per bucket. */
/** `backfillS`: the one-off backfill over the last `backfillS` seconds. It starts at the first whole bucket inside that
 *  range, like the scheduled run, so the oldest bucket it writes is never partial. */
export const rollupQuery = (s: AppSettings, backfillS?: number) => `${hb(s)}
| extend minute = bin(_time, 60), bucket = bin(_time, 300)
| summarize ev=sum(_value), by_=sum(bytes), lag_max=max(event_lag_s), lag_min=min(event_lag_s), src=max(asset_src), t_first=min(_time), t_last=max(_time) by worker_group, input, asset, bucket, minute
| where bucket >= bin(now() - ${backfillS ?? lookbackSeconds(rwin(s).earliest)}, 300) + 300 and bucket < bin(now(), 300) - 300
| sort by worker_group, input, asset, bucket, minute asc
| extend k = strcat(worker_group, "|", input, "|", asset, "|", tostring(bucket))
| extend pk = prev(k), pm = prev(minute)
| extend gap_start = iff(pk == k and minute - pm > 120, pm, null), gap_end = iff(pk == k and minute - pm > 120, minute, null)
| summarize events=sum(ev), bytes=sum(by_), active_min=count(), first_min=min(minute), last_min=max(minute), first_s=min(t_first), last_s=max(t_last),
            in_gap_start=max(gap_start), in_gap_end=max(gap_end), max_lag_s=max(lag_max), min_lag_s=min(lag_min), asset_src=max(src)
          by worker_group, input, asset, bucket
| extend written_at = now(), _time = bucket
| export to lake ${rollupDataset(s.dataset)}`;

/** A saved-search definition. `cron` and `enabled` come from cadenceOf(s.searchLoad). A search the load turns off
 *  (null cron) keeps the Standard cron as a placeholder and carries `enabled: false`; one the load runs leaves
 *  `enabled` out (= enabled), so the Standard output stays byte-identical to the pre-033 one. */
export type SavedSearchDef = {
  id: SavedId; cron: string; enabled?: false; earliest?: string; latest?: string; notify: boolean; desc: string; query: string; message?: string;
};
const STANDARD = cadenceOf('standard');
const sched = (c: Cadence, id: SavedId): { cron: string; enabled?: false } => {
  const cron = c.crons[id];
  return cron ? { cron } : { cron: STANDARD.crons[id] ?? '', enabled: false };
};

/* ---------- spec 033 §4: the roll call (Economy only) ---------- */
export const ROLL_CALL_FORGET_D = 30;
/** The roll call's missing list is cut at this many characters (at a comma), then " +N more". Cribl Search has no
 *  array_* functions (array_sort_asc, array_slice, array_length, strcat_array, pack_array: "Unknown Kusto scalar
 *  function", 2026-11-22), so the list is the values() JSON as text (unjson), like the digest's. Its order is values()'s. */
export const ROLL_CALL_LIST_CHARS = 1500;
/** The roll call's scan window: max(LOOKBACK, 25 h), as a saved-search `earliest`. */
export const rollCallEarliest = (s: AppSettings) => lookbackSeconds(s.learning.LOOKBACK) > 25 * 3600 ? s.learning.LOOKBACK : '-25h';

/** entityQuery over the raw dataset (never the rollup), plus the missing entities of the previous roll call that today's
 *  scan no longer sees (kept as 'missing' until muted, acked, retired or silent ROLL_CALL_FORGET_D days), plus the fleet
 *  totals. Only rows the previous run reported missing (raw_state "missing": never learning, ok, late or delayed) carry
 *  forward, never muted or acked ones, and pulse_overrides is re-checked. A carried row under an open fleet, group or source maintenance
 *  window is kept as 'maintenance' (not counted, not listed), so it is listed missing again once the window closes. */
export const rollCallQuery = (s: AppSettings): string => {
  const raw = { ...s, rollup: 'off' as const, searchLoad: 'daily' as const };
  const today = entityQuery(raw);
  const forgetS = ROLL_CALL_FORGET_D * 86400;
  return `${today}
| extend carried = 0
| union (${latestRun('pulse_roll_call', 'computed_at')}
  | where raw_state == "missing" and state in ("missing", "maintenance")
  | extend silent_s = max_of(0.0, now() - todouble(last_seen) - 60)
  | where silent_s <= ${forgetS}
  | lookup pulse_overrides on input, asset
  | extend ov_on = isnotnull(action) and action != "none" and (isnull(until_s) or todouble(until_s) <= 0 or todouble(until_s) > now())
  | where not(ov_on)
${maintenanceCols}
  | extend state = iff(maintenance != "", "maintenance", "missing"), raw_state = "missing", signal = "", newly_missing = false, silent_min = round(silent_s / 60, 1)
  | project ${ENTITY_COLS}
  | extend carried = 1)
| eventstats only_carried = min(carried) by worker_group, input, asset
| where carried == 0 or only_carried == 1
| project-away carried, only_carried
| extend is_exp = iff(state in ("ok", "late", "missing", "delayed", "acked"), 1, 0), is_rep = iff(state in ("ok", "late", "delayed"), 1, 0),
         is_miss = iff(state == "missing", 1, 0), is_del = iff(signal == "delayed", 1, 0), is_skew = iff(signal == "clock_skew", 1, 0),
         is_low = iff(signal == "low_volume", 1, 0), missing_asset = iff(state == "missing", asset, null)
| eventstats n_expected = sum(is_exp), n_reporting = sum(is_rep), n_missing = sum(is_miss), n_delayed = sum(is_del),
             n_skew = sum(is_skew), n_low = sum(is_low), missing_names = values(missing_asset)
| extend missing_all = ${unjson('missing_names')}
| extend missing_cut = iff(strlen(missing_all) > ${ROLL_CALL_LIST_CHARS}, extract(@'^(.{0,${ROLL_CALL_LIST_CHARS}}),', 1, missing_all), missing_all)
| extend n_names = iff(isempty(missing_all), 0, countof(missing_all, ",") + 1), n_shown = iff(isempty(missing_cut), 0, countof(missing_cut, ",") + 1)
| extend missing_list = strcat(replace_regex(missing_cut, ",", ", "), iff(n_names > n_shown, strcat(" +", tostring(n_names - n_shown), " more"), ""))
| extend signal_list = trim_end(@'[, ]+', strcat(iff(n_delayed > 0, strcat(tostring(n_delayed), " delayed, "), ""),
    iff(n_skew > 0, strcat(tostring(n_skew), " clock ahead, "), ""), iff(n_low > 0, strcat(tostring(n_low), " low volume, "), "")))
| extend computed_at = now()
| project-away is_exp, is_rep, is_miss, is_del, is_skew, is_low, missing_asset, n_delayed, n_skew, n_low, missing_names, missing_all, missing_cut, n_names, n_shown
| sort by iff(state == "missing", 0, 1) asc, silent_min desc`;
};

/** The roll call notification message (resultSet[0] carries the totals). */
export const ROLL_CALL_MESSAGE = 'Pulse roll call: {{resultSet[0].n_reporting}} of {{resultSet[0].n_expected}} assets reporting. Missing ({{resultSet[0].n_missing}}): {{resultSet[0].missing_list}}. Signals: {{resultSet[0].signal_list}}.';
export const rollCallMessage = (r: { n_reporting: number; n_expected: number; n_missing: number; missing_list: string; signal_list: string }) =>
  `Pulse roll call: ${r.n_reporting} of ${r.n_expected} assets reporting. Missing (${r.n_missing}): ${r.missing_list || 'none'}. Signals: ${r.signal_list || 'none'}.`;

export const savedSearches = (s: AppSettings): SavedSearchDef[] => {
  const c = cadence(s);
  return [
    { id: 'pulse_rollup', ...sched(c, 'pulse_rollup'), earliest: rwin(s).earliest, latest: 'now', notify: false, desc: 'Pulse: 5-minute rollup of the heartbeat dataset (closed buckets only)',
      query: rollupQuery(s) },
    { id: 'pulse_state', ...sched(c, 'pulse_state'), notify: false, desc: 'Pulse: asset state snapshot, read by the app through $vt_results',
      query: `${entityQuery(s)}${stateFlag(s)}\n| extend computed_at = now()` },
    { id: 'pulse_ledger_asset', ...sched(c, 'pulse_ledger_asset'), notify: false, desc: 'Pulse: incident ledger for assets (spec 030 F1)',
      query: ledgerQuery(s, 'asset') },
    { id: 'pulse_ledger_source', ...sched(c, 'pulse_ledger_source'), notify: false, desc: 'Pulse: incident ledger for sources (spec 030 F1)',
      query: ledgerQuery(s, 'source') },
    { id: 'pulse_alert_missing', ...sched(c, 'pulse_alert_missing'), notify: true, desc: 'Pulse alert: an asset stopped sending (once per incident)',
      query: alertMissing(s),
      message: 'Pulse [P{{resultSet[0].criticality}} {{resultSet[0].team}}]: {{resultSet[0].asset}} stopped sending to {{resultSet[0].input}} ({{resultSet[0].worker_group}}). Silent {{resultSet[0].silent_min}} min; learned tolerance {{resultSet[0].tolerance_s}} s.' },
    { id: 'pulse_alert_source_down', ...sched(c, 'pulse_alert_source_down'), notify: true, desc: 'Pulse alert: most assets of a source went silent together (one alert, not one per asset)',
      query: alertSourceDown(s),
      message: 'Pulse: {{resultSet[0].input}} ({{resultSet[0].worker_group}}) lost {{resultSet[0].s_missing}} of {{resultSet[0].s_live}} assets at once. Check the source, its forwarder or the network before the hosts. Missing: {{resultSet[0].missing_list}}.' },
    { id: 'pulse_source_digest', ...sched(c, 'pulse_source_digest'), notify: true, desc: 'Pulse digest: sources with missing assets or data-quality signals',
      query: digest(s),
      message: 'Pulse digest: {{resultSet[0].input}} has {{resultSet[0].current}}/{{resultSet[0].expected}} assets reporting. Missing: {{resultSet[0].missing_list}}. Signals: {{resultSet[0].signal_list}}.' },
    ...(normalizeLoad(s.searchLoad) === 'daily' ? [{ id: 'pulse_roll_call' as const, ...sched(c, 'pulse_roll_call'), earliest: rollCallEarliest(s), latest: 'now',
      notify: true, desc: 'Pulse roll call: who is reporting, who is missing (once a day)', query: rollCallQuery(s), message: ROLL_CALL_MESSAGE }] : []),
  ];
};
