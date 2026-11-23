// Alert routing core (spec 029). Pure: no fetch, no DOM, no React, no state.

/** Per specs/029-alert-routing/t0.md: each route reads its parent's results through $vt_results. */
export const routingMode: 'condition' | 'vt_results' = 'vt_results';

export type RouteKind = 'missing' | 'source_down' | 'digest';

export type AlertEvent = 'opened' | 'reminder' | 'resolved' | 'expired';
export const ALERT_EVENTS: AlertEvent[] = ['opened', 'reminder', 'resolved', 'expired'];
export const DEFAULT_EVENTS: AlertEvent[] = ALERT_EVENTS;

/** Pulse alert event v1 `state`: firing for opened/reminder, resolved for resolved/expired. */
export const stateOf = (event: AlertEvent): 'firing' | 'resolved' => (event === 'resolved' || event === 'expired' ? 'resolved' : 'firing');

/** Spec 030 §3: the plain `pager_duty` target stays without auto-resolve (it sends no `event_action`), so a resolved or
 *  expired row would reach PagerDuty as one more trigger. Native pager_duty targets get the firing events only. */
export const firingEvents = (evs: AlertEvent[]): AlertEvent[] => ALERT_EVENTS.filter((e) => evs.includes(e) && stateOf(e) === 'firing');

/** Notification id suffix of the native PagerDuty group when the route (or default) also has other text targets. */
export const PD_SUFFIX = 'pager_duty';

export type Route = {
  id: string; // r1…r5, stable across edits (part of the notification ID)
  name: string;
  when: {
    kinds?: RouteKind[]; // empty = all
    maxCriticality?: 1 | 2 | 3 | 4;
    team?: string;
    input?: string;
    events?: AlertEvent[]; // default: all four; a route may opt out of recoveries
  };
  targets: string[];
  severity?: 'critical' | 'error' | 'warning' | 'info';
  final: boolean;
};

function kqlString(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

/** KQL condition for a route's matchers (AND-ed). `kinds` is not part of the condition. */
export function routeCondition(when: Route['when'], kind?: RouteKind, defaults: AlertEvent[] = DEFAULT_EVENTS): string {
  const parts: string[] = [];
  // Grouped rows carry crit_min (worst) and teams_j (",a,b,"): Cribl KQL documents no array membership function.
  const grouped = kind === 'source_down' || kind === 'digest';
  if (when.maxCriticality != null) parts.push(`toint(${grouped ? 'crit_min' : 'criticality'}) <= ${when.maxCriticality}`);
  if (when.team != null && when.team !== '') parts.push(grouped ? `teams_j contains_cs ${kqlString(`,${when.team},`)}` : `team == ${kqlString(when.team)}`);
  if (when.input != null && when.input !== '') parts.push(`input == ${kqlString(when.input)}`);
  // The digest has no `event` column. A recovery filter (opened/reminder) would reference a missing column
  // and the hourly search would fail or match nothing.
  const ev = kind === 'digest' ? '' : eventsClause(when.events ?? defaults);
  if (ev) parts.push(ev);
  return parts.length ? parts.join(' and ') : 'true';
}

/** `event in (…)` for a subset of the four events, or '' when all four pass. */
export function eventsClause(evs: AlertEvent[]): string {
  if (ALERT_EVENTS.every((e) => evs.includes(e))) return '';
  return `event in (${ALERT_EVENTS.filter((e) => evs.includes(e)).map(kqlString).join(', ')})`;
}

/* ---------------------------------------------------------------------------------------------------------------
 * Message templates (spec 029 §3).
 *
 * Column contract: the exact columns T2 (kql.ts) must emit for each alert search, and which the templates below
 * read through `{{resultSet[<row>].<col>}}`. Per t0.md (sanitizing: yes), every free-text value is read from a
 * sanitized `*_s` column (`"`, `\` and control characters replaced; also `<`, `>`, `|` so Slack links stay intact),
 * because `{{…}}` substitution may not escape JSON. `*_u` columns are URL-encoded, for the incident link.
 * Number columns are written unquoted into the JSON event, so T2 must make each one always present and numeric
 * (coalesce to a default), never null or empty. `more_s` is the render-time `(+N more: …)` suffix (t0.md: the query
 * computes what only the run knows), or "" when there is nothing more to say.
 *
 *   missing      (pulse_alert_missing, one row per silent asset):
 *     strings: severity, asset_s, asset_u, input_s, worker_group_s, team_s, others_s, more_s
 *     numbers: criticality (coalesce "3"), silent_min, tolerance_s, n_alerts (rows in this run)
 *     more_s = "(+<n_alerts-1> more: <others_s>)" when n_alerts > 1, else ""
 *     lead_s / msg_s: the event's headline and full sentence (lifecycleColumns: opened, Resolved:, Reminder:, Closed:)
 *   source_down  (pulse_alert_source_down, one row per worker_group/input):
 *     strings: severity, input_s, input_u, worker_group_s, teams_s, missing_s, more_s
 *     numbers: crit_min (worst criticality of the missing assets, coalesce 3), s_live, s_missing, pct
 *     n_alerts = s_missing; others = missing_s (missing_list, comma-joined, trimmed to 300 chars)
 *     more_s = "(+<rows-1> more: <other inputs>)" when several sources went down in this run, else ""
 *   digest       (pulse_source_digest, one row per worker_group/input; not a lifecycle event):
 *     strings: severity, input_s, input_u, worker_group_s, teams_s, missing_s, signals_s, more_s
 *     numbers: crit_min (coalesce 3), expected, current, missing, signals
 *     no state, event, or incident_id
 *     n_alerts = missing; others = missing_s
 *     more_s = "(+<rows-1> more: <other inputs>)" when the digest has several rows, else ""
 *
 * Length caps T2 applies when sanitizing (ALERT_CAPS), so every rendered message stays ≤ 1,000 chars (Search's
 * message limit, and PagerDuty's summary): names ≤ 32, teams_s ≤ 48, others_s / missing_s ≤ 300, more_s ≤ 320 for
 * missing (it repeats others) and ≤ 120 for source_down / digest, signals_s ≤ 60.
 * `severity` is critical | error | warning | info, from criticality / crit_min 1 | 2 | 3 | 4+.
 * Kinds without an asset write "" for asset and null for silent_min / tolerance_s in the event.
 * ------------------------------------------------------------------------------------------------------------- */

export const ALERT_COLUMNS: Record<RouteKind, { strings: string[]; numbers: string[] }> = {
  missing: {
    strings: ['severity', 'state', 'event', 'incident_id_s', 'asset_s', 'asset_u', 'input_s', 'worker_group_s', 'team_s', 'others_s', 'more_s', 'lead_s', 'msg_s'],
    numbers: ['criticality', 'silent_min', 'tolerance_s', 'n_alerts'],
  },
  source_down: {
    strings: ['severity', 'state', 'event', 'incident_id_s', 'input_s', 'input_u', 'worker_group_s', 'teams_s', 'missing_s', 'more_s', 'lead_s', 'msg_s'],
    numbers: ['crit_min', 's_live', 's_missing', 'pct'],
  },
  digest: {
    strings: ['severity', 'input_s', 'input_u', 'worker_group_s', 'teams_s', 'missing_s', 'signals_s', 'more_s'],
    numbers: ['crit_min', 'expected', 'current', 'missing', 'signals'],
  },
};

/** Max rendered length of each string column (see the contract above). */
export const ALERT_CAPS: Record<RouteKind, Record<string, number>> = {
  missing: { incident_id_s: 140, asset_s: 32, asset_u: 96, input_s: 32, worker_group_s: 32, team_s: 32, others_s: 160, more_s: 200, lead_s: 120, msg_s: 240 },
  source_down: { incident_id_s: 140, input_s: 32, input_u: 96, worker_group_s: 32, teams_s: 48, missing_s: 160,more_s: 120, lead_s: 110, msg_s: 360 },
  digest: { input_s: 32, input_u: 96, worker_group_s: 32, teams_s: 48, missing_s: 160, signals_s: 60, more_s: 120 },
};

/* ---------------------------------------------------------------------------------------------------------------
 * Run summary (KQL): n_alerts / others / more_s for the rows a search keeps. kql.ts appends it to each alert search
 * before numbering slots, so every parent row already carries the run's counts. A per-slot derived search keeps
 * those columns: recounting after `slot == i` would see one row ("Alerts this run: 1", empty others, no "(+N more)").
 * routeSearchQuery, defaultSearchQuery, and the digest's derived search still append it again after their own
 * `where` (several rows). Only functions in Cribl's KQL index (eventstats, next, strcat_delim).
 * ------------------------------------------------------------------------------------------------------------- */

/** Sanitized text column: `"`, `\`, control characters and `<>|` replaced (t0.md: {{…}} may not escape JSON). */
export const san = (x: string, n: number) => String.raw`substring(replace_regex(tostring(${x}), @'["\\<>|\x00-\x1f]', " "), 0, ${n})`;
/** "a, b, c" from the next `n` rows' `col` (needs a sorted input; next() is only allowed in extend). */
const nextList = (col: string, n: number, cap: number) =>
  `substring(replace_regex(strcat_delim(", ", ${Array.from({ length: n }, (_, i) => `next(${col}, ${i + 1}, "")`).join(', ')}), @'(, )+$', ""), 0, ${cap})`;

const SUMMARY_ORDER: Record<RouteKind, string> = {
  missing: 'criticality asc, asset asc',
  source_down: 'crit_min asc, s_missing desc, input asc',
  digest: 'crit_min asc, missing desc, input asc',
};

/** The KQL tail that (re)computes the run summary over the rows so far. `again`: the rows come from a parent that
 *  already carries a summary (a route or default search), so its columns are dropped first. */
export const ALERT_SLOTS = 5;

/** Spec 030 §3: order the kept rows (opened / reminder before resolved / expired, then criticality, then incident_id),
 *  number them `slot` 0, 1, 2 … and keep `slot < ALERT_SLOTS`. Runs after the run summary, which counts the whole run. */
const slotTail = (kind: RouteKind) => kind === 'digest' ? '' : `
| extend ev_rank = iff(event in ("opened", "reminder"), 0, 1)
| sort by ev_rank asc, ${kind === 'missing' ? 'criticality' : 'crit_min'} asc, incident_id asc
| extend slot = row_number(0)
| where slot < ${ALERT_SLOTS}`;

/** Cribl Search's next() crashes on an empty stream: after a `where` that kept no row it fails the job
 *  ("Cannot set properties of undefined (setting '__windowHeadFlush_…')", probed on the org 2026-11-22), so every quiet
 *  run of an alert search ended `failed`. One padding row (`print`) always reaches next(): it is not counted, sorts last
 *  (so the last real row's next() still reads ""), and is dropped before the slots are numbered. */
const PAD_IN = (col: string) => `
| union (print __pad = 1, ${col} = "")
| extend __pad = iff(isnull(__pad), 0, __pad)`;
const PAD_OUT = `
| where __pad == 0
| project-away __pad`;

export function runSummary(kind: RouteKind, again = false): string {
  const drop = kind === 'digest' ? '' : ', ev_rank, slot';
  if (kind === 'missing') {
    return `${again ? `\n| project-away n_alerts, others, others_s, more_s${drop}` : ''}${PAD_IN('asset')}
| eventstats n_alerts = countif(__pad == 0)
| sort by __pad asc, ${SUMMARY_ORDER.missing}
| extend others = ${nextList('asset', 9, 160)}
| extend others_s = ${san('others', 160)}
| extend more_s = iff(n_alerts > 1, ${san('strcat("(+", tostring(n_alerts - 1), " more: ", others, ")")', 200)}, "")${PAD_OUT}${slotTail('missing')}`;
  }
  return `${again ? `\n| project-away n_rows, more_s${drop}` : ''}${PAD_IN('input')}
| eventstats n_rows = countif(__pad == 0)
| sort by __pad asc, ${SUMMARY_ORDER[kind]}
| extend more_in = ${nextList('input', 5, 100)}
| extend more_s = iff(n_rows > 1, ${san('strcat("(+", tostring(n_rows - 1), " more: ", more_in, ")")', 120)}, "")
| project-away more_in${PAD_OUT}${slotTail(kind)}`;
}

const ph = (row: number, col: string) => `{{resultSet[${row}].${col}}}`;
const RESULTS_URL = '{{searchResultsUrl}}';

type Parts = {
  /** Event values: string templates are quoted, number templates are written raw, null is JSON null. */
  event: { asset: string; criticality: string; team: string; silent_min: string | null; tolerance_s: string | null; n_alerts: string; others: string };
  summary: string; // short line, for the event and PagerDuty
  head: string; // Slack bold header: "P1 · network"
  slackBody: string; // the Slack sentence after the header
  text: string; // today's sentence plus counts
  incident: string; // query string of the incident view link
};

function parts(kind: RouteKind, row: number): Parts {
  const c = (col: string) => ph(row, col);
  // Spec 030 §3: the sentence depends on the row's event (opened / Resolved: / Reminder: / Closed:). Templates have no
  // conditionals, so the alert search computes it per row (lifecycleColumns) and the templates read lead_s / msg_s.
  if (kind === 'missing') {
    return {
      event: { asset: c('asset_s'), criticality: c('criticality'), team: c('team_s'), silent_min: c('silent_min'), tolerance_s: c('tolerance_s'), n_alerts: c('n_alerts'), others: c('others_s') },
      summary: `P${c('criticality')} ${c('team_s')}: ${c('lead_s')}`,
      head: `P${c('criticality')} · ${c('team_s')}`,
      slackBody: c('msg_s'),
      text: `Pulse [P${c('criticality')} ${c('team_s')}]: ${c('msg_s')} Alerts this run: ${c('n_alerts')}.`,
      incident: `asset=${c('asset_u')}`,
    };
  }
  if (kind === 'source_down') {
    return {
      event: { asset: '', criticality: c('crit_min'), team: c('teams_s'), silent_min: null, tolerance_s: null, n_alerts: c('s_missing'), others: c('missing_s') },
      summary: `P${c('crit_min')} ${c('teams_s')}: ${c('lead_s')}`,
      head: `P${c('crit_min')} · ${c('teams_s')}`,
      slackBody: c('msg_s'),
      text: `Pulse [P${c('crit_min')} ${c('teams_s')}]: ${c('msg_s')}`,
      incident: `input=${c('input_u')}`,
    };
  }
  const where = `${c('input_s')} (${c('worker_group_s')}) has ${c('current')}/${c('expected')} assets reporting, ${c('missing')} missing, ${c('signals')} with signals`;
  return {
    event: { asset: '', criticality: c('crit_min'), team: c('teams_s'), silent_min: null, tolerance_s: null, n_alerts: c('missing'), others: c('missing_s') },
    summary: `Digest P${c('crit_min')} ${c('teams_s')}: ${c('input_s')} (${c('worker_group_s')}) ${c('current')}/${c('expected')} reporting, ${c('missing')} missing, ${c('signals')} signals`,
    head: `Digest P${c('crit_min')} · ${c('teams_s')}`,
    slackBody: `${where}. Missing: ${c('missing_s')}. Signals: ${c('signals_s')}.`,
    text: `Pulse digest [P${c('crit_min')} ${c('teams_s')}]: ${where}. Missing: ${c('missing_s')}. Signals: ${c('signals_s')}.`,
    incident: `input=${c('input_u')}`,
  };
}

/** Pulse alert event v1 as a JSON-string message template (≤ 1,000 chars once rendered; see the tests). */
export function alertEvent(row: number, kind: RouteKind): string {
  const p = parts(kind, row);
  const e = p.event;
  const str = (v: string) => `"${v}"`;
  const num = (v: string | null) => (v == null ? 'null' : v);
  const fields: [string, string][] = [
    ['source', str('pulse')],
    ['v', '1'],
    ['kind', str(kind)],
  ];
  // A digest is not an incident: the JSON omits state, event, and incident_id (no pulse:asset: / pulse:source: id).
  if (kind !== 'digest') fields.push(
    ['state', str(ph(row, 'state'))],
    ['event', str(ph(row, 'event'))],
    ['incident_id', str(ph(row, 'incident_id_s'))],
  );
  fields.push(
    ['severity', str(ph(row, 'severity'))],
    ['asset', str(e.asset)],
    ['input', str(ph(row, 'input_s'))],
    ['worker_group', str(ph(row, 'worker_group_s'))],
    ['criticality', num(e.criticality)],
    ['team', str(e.team)],
    ['silent_min', num(e.silent_min)],
    ['tolerance_s', num(e.tolerance_s)],
    ['n_alerts', num(e.n_alerts)],
    ['others', str(e.others)],
    ['summary', str(p.summary)],
    ['url', str(RESULTS_URL)],
    ['at', str('{{timestamp}}')],
  );
  return '{' + fields.map(([k, v]) => `"${k}":${v}`).join(',') + '}';
}

export type MessageOpts = { origin?: string; base?: string; row?: number };

function incidentUrl(kind: RouteKind, opts: MessageOpts): string | undefined {
  if (!opts.origin) return undefined;
  const base = (opts.base ?? '').replace(/\/+$/, '');
  return `${opts.origin.replace(/\/+$/, '')}${base}/incidents?${parts(kind, opts.row ?? 0).incident}`;
}

/** Slack mrkdwn: `*P1 · network* — fw01 stopped sending to … <url|Open>`. */
export function slackMessage(kind: RouteKind, opts: MessageOpts = {}): string {
  const row = opts.row ?? 0;
  const p = parts(kind, row);
  const inc = incidentUrl(kind, opts);
  return `*${p.head}* — ${p.slackBody} ${ph(row, 'more_s')} <${RESULTS_URL}|Open>` + (inc ? ` · <${inc}|Incident>` : '');
}

/** Plain text (email, bulletin, SNS, PagerDuty): today's sentence, counts, the `(+N more: …)` suffix and links. */
export function textMessage(kind: RouteKind, opts: MessageOpts = {}): string {
  const row = opts.row ?? 0;
  const p = parts(kind, row);
  const inc = incidentUrl(kind, opts);
  return `${p.text} ${ph(row, 'more_s')} Results: ${RESULTS_URL}` + (inc ? ` Incident: ${inc}` : '');
}

/** "47 min" under an hour, else hours ("4 h", "1.5 h"). */
export function formatDuration(seconds: number): string {
  const min = Math.max(0, Math.round(seconds / 60));
  if (min < 60) return `${min} min`;
  return `${Math.round((min / 60) * 10) / 10} h`;
}

export type LifecycleCtx = {
  asset?: string; // omitted for source-down rows
  input: string;
  criticality?: number;
  team?: string;
  openedAt?: number; // epoch seconds
  nowS?: number; // epoch seconds
  silentS?: number; // reminder: time silent so far
  windowH?: number; // expired: tracking window in hours
};

const WIN = 'win' + 'dow'; // split: test-routes.mjs greps this file for the browser global of that name

/** Text for resolved / reminder / expired (spec 030). Source-kind variants (no asset) name the input instead. */
export function lifecycleText(event: Exclude<AlertEvent, 'opened'>, c: LifecycleCtx): string {
  const who = c.asset || c.input;
  if (event === 'reminder') return `Reminder: ${who} still silent after ${formatDuration(c.silentS ?? 0)}.`;
  if (event === 'expired') return `Closed: ${who} left the ${c.windowH ?? 24} h ${WIN}; Pulse stopped tracking it.`;
  const dur = formatDuration((c.nowS ?? 0) - (c.openedAt ?? 0));
  const tail = c.criticality != null || c.team ? ` (${[c.criticality != null ? `P${c.criticality}` : '', c.team ?? ''].filter(Boolean).join(' · ')})` : '';
  const what = c.asset ? `${c.asset} is sending to ${c.input} again` : `${c.input} is sending again`;
  const started = c.openedAt != null ? ` Incident started ${new Date(c.openedAt * 1000).toISOString().replace('.000Z', 'Z')}.` : '';
  return `Resolved: ${what} after ${dur}${tail}.${started}`;
}

/** KQL tail (spec 030 §3) that the alert searches append: `lead_s` is the row's headline without a final period (the
 *  JSON `summary`, so PagerDuty's payload.summary) and `msg_s` the Slack / text sentence, both chosen by `event` with
 *  the words of lifecycleText (formatDuration's rounding included); the resolved "(P1 · team)" tail and start time
 *  go in msg_s only, since the summary already starts with them. opened keeps today's sentence. Built only from
 *  sanitized columns and literals, so it needs no sanitizing of its own; capped by ALERT_CAPS. */
export function lifecycleColumns(kind: 'missing' | 'source_down', windowH: number): string {
  const a = kind === 'missing';
  const crit = a ? 'criticality' : 'tostring(crit_min)';
  const team = a ? 'team_s' : 'teams_s';
  const who = a ? 'asset_s' : 'input_s';
  const back = a ? 'asset_s, " is sending to ", input_s, " again"' : 'input_s, " is sending again"';
  // Seconds for "after N": a reminder counts the asset's silence, everything else (and a source) the time since opened.
  const silentS = a ? 'iff(event == "reminder", todouble(silent_min) * 60, now() - todouble(opened_at))' : 'now() - todouble(opened_at)';
  const opened = a
    ? 'strcat(asset_s, " stopped sending to ", input_s, " (", worker_group_s, ")")'
    : 'strcat(input_s, " (", worker_group_s, ") lost ", tostring(s_missing), " of ", tostring(s_live), " assets at once (", tostring(pct), "%)")';
  const detail = a
    ? 'strcat(". Silent ", tostring(silent_min), " min (tolerance ", tostring(tolerance_s), " s).")'
    : 'strcat(". Check the source, its forwarder or the network before the hosts. Missing: ", missing_s, ".")';
  const C = ALERT_CAPS[kind];
  const min = `round(max_of(${silentS}, 0) / 60, 0)`;
  return `
| extend dur_min = ${min}
| extend dur_t = iff(dur_min < 60, strcat(tostring(dur_min), " min"), strcat(tostring(round(dur_min / 60, 1)), " h"))
| extend lead_s = substring(case(event == "resolved", strcat("Resolved: ", ${back}, " after ", dur_t),
    event == "reminder", strcat("Reminder: ", ${who}, " still silent after ", dur_t),
    event == "expired", strcat("Closed: ", ${who}, " left the ${windowH} h ${WIN}; Pulse stopped tracking it"),
    ${opened}), 0, ${C.lead_s})
| extend msg_s = substring(case(event == "resolved", strcat(lead_s, " (P", ${crit}, " · ", ${team}, "). Incident started ", strftime(toint(opened_at), "%Y-%m-%dT%H:%M:%SZ"), "."),
    event == "opened", strcat(lead_s, ${detail}), strcat(lead_s, ".")), 0, ${C.msg_s})`;
}

export function formatFor(targetType: string): 'slack' | 'text' | 'json' {
  switch (targetType) {
    case 'slack':
      return 'slack';
    case 'webhook':
      return 'json';
    default:
      return 'text';
  }
}

/* ---------------------------------------------------------------------------------------------------------------
 * Notification bodies (spec 029 §2). The only place that builds a notification's targetConfigs.
 * ------------------------------------------------------------------------------------------------------------- */

type Format = 'slack' | 'text' | 'json';
const FORMATS: Format[] = ['text', 'slack', 'json'];
/** Every id suffix a notification of a route / the default can carry (`_text` is never produced, kept for old ids). */
const SUFFIXES: string[] = [...FORMATS, PD_SUFFIX];

/** The alert kind a Pulse saved search carries (by its id); unknown ids read as `missing`. */
export function searchKind(searchId: string): RouteKind {
  if (searchId.includes('source_down')) return 'source_down';
  if (searchId.includes('digest')) return 'digest';
  return 'missing';
}

const routeApplies = (r: Route, searchId: string) => !r.when.kinds?.length || r.when.kinds.includes(searchKind(searchId));

/** A route's condition in its list: its own matchers, and none of the final routes above it that apply to the same
 *  search (README: "When a route is marked Final and matches an alert, no later route sees that alert"). */
export function effectiveCondition(r: Route, routes: Route[], searchId: string, defaults: AlertEvent[] = DEFAULT_EVENTS): string {
  const kind = searchKind(searchId);
  const above = routes.slice(0, Math.max(0, routes.findIndex((x) => x.id === r.id))).filter((x) => x.final && routeApplies(x, searchId));
  const own = routeCondition(r.when, kind, defaults);
  if (!above.length) return own;
  const not = `not (${above.map((x) => `(${routeCondition(x.when, kind, defaults)})`).join(' or ')})`;
  return own === 'true' ? not : `${own} and ${not}`;
}

export type NotificationBody = {
  id: string;
  disabled: boolean;
  condition: 'search';
  group: 'default_search';
  targets: string[];
  metadata: { name: string; value: string }[];
  targetConfigs: { id: string; conf: Record<string, unknown> }[];
  conf: Record<string, unknown>;
};

/** Spec 035: an enabled body has exactly one target and one targetConfigs entry for it. A disabled body may keep old targets. */
export function oneTargetProblem(n: Pick<NotificationBody, 'id' | 'targets' | 'targetConfigs'> & { disabled?: boolean }): string | undefined {
  if (n.disabled === true) return undefined;
  const targets = n.targets ?? [];
  const cfgs = n.targetConfigs ?? [];
  if (targets.length !== 1) return `notification ${n.id} must have exactly one target (has ${targets.length})`;
  if (cfgs.length !== 1 || cfgs[0].id !== targets[0]) return `notification ${n.id} must have one targetConfigs entry with id ${targets[0]}`;
  return undefined;
}

/** Spec 035: the default targets in ID order: system_email first when an email is set, then the settings targets as
 *  listed, no duplicates. The first one keeps the plain base ID (`<search>_notification`, `pulse_roll_call_notification`). */
export const defaultTargetOrder = (targets: string[], email?: string): string[] =>
  [...new Set([...(email?.trim() ? ['system_email'] : []), ...(targets ?? [])])];

export function notificationsFor(
  search: { id: string; desc: string },
  routes: Route[],
  defaults: { targets: string[]; email: string; events?: AlertEvent[] },
  ctx: { targetTypes: Record<string, string>; origin?: string; base?: string },
): NotificationBody[] {
  const kind = searchKind(search.id);
  const evs = defaults.events ?? DEFAULT_EVENTS; // settings-derived default (Send recovery notifications off → no resolved/expired)
  const email = defaults.email?.trim() ? defaults.email : '';
  const typeOf = (t: string) => ctx.targetTypes[t] ?? (t === 'system_email' ? 'smtp' : 'unknown');
  const targetConfigs = (targets: string[]) => targets.map((t) => ({
    id: t,
    conf: t === 'system_email'
      ? { emailRecipient: { to: defaults.email, ccEnabled: false }, subject: search.desc, includeResults: true, attachmentType: 'inline' }
      : {},
  }));
  const isPd = (t: string) => typeOf(t) === 'pager_duty';
  // Spec 035: one body per target. A native pager_duty target takes the firing events only (the digest has no recoveries).
  const pdOnly = kind !== 'digest';
  const pdTarget = (t: string) => pdOnly && isPd(t);
  const slots = kind === 'digest' ? 1 : ALERT_SLOTS;
  const message = (f: Format) => f === 'text' ? textMessage(kind, ctx) : f === 'slack' ? slackMessage(kind, ctx) : alertEvent(0, kind);
  const sid = (i: number) => (i === 0 ? '' : `_s${i}`);
  const noteConf = (cond: string): Record<string, unknown> => {
    if (kind === 'digest') {
      return cond ? { triggerType: 'custom', customValue: cond } : { triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0 };
    }
    return {
      triggerType: 'resultsCount',
      triggerComparator: '>',
      triggerCount: 0,
      ...(cond ? { customValue: cond } : {}),
    };
  };
  const mine = routes.filter((r) => routeApplies(r, search.id));
  const out: NotificationBody[] = [];

  for (const r of mine) {
    for (const t of [...new Set(r.targets)]) {
      const pd = pdTarget(t);
      const own = r.when.events ?? evs;
      const fire = pd ? firingEvents(own) : own;
      if (!fire.length) continue; // a recoveries-only route has nothing a native PagerDuty target can take
      const sev = r.severity && isPd(t);
      const cond = pd ? effectiveCondition({ ...r, when: { ...r.when, events: fire } }, mine, search.id, evs) : effectiveCondition(r, mine, search.id, evs);
      for (let i = 0; i < slots; i++) out.push({
        id: `${search.id}_route_${r.id}__${t}${sid(i)}`,
        disabled: false, condition: 'search', group: 'default_search', targets: [t],
        metadata: sev ? [{ name: '__severity', value: r.severity! }] : [],
        targetConfigs: targetConfigs([t]),
        conf: { ...noteConf(cond === 'true' ? '' : cond), savedQueryId: search.id, message: message(formatFor(typeOf(t))) },
      });
    }
  }

  // Default route: system_email first (when an email is set), then settings targets as listed. The first keeps the 0.2.8 id.
  const dTargets = defaultTargetOrder(defaults.targets, email);
  dTargets.forEach((t, idx) => {
    const pd = pdTarget(t);
    if (pd && !firingEvents(evs).length) return;
    const dCond = defaultCondition(mine, kind, evs, pd ? firingEvents(evs) : evs);
    for (let i = 0; i < slots; i++) out.push({
      id: `${search.id}_notification${idx === 0 ? '' : `__${t}`}${sid(i)}`,
      disabled: false, condition: 'search', group: 'default_search', targets: [t], metadata: [],
      targetConfigs: targetConfigs([t]),
      conf: { ...noteConf(dCond), savedQueryId: search.id, message: message(formatFor(typeOf(t))) },
    });
  });
  return out;
}

/** The routes that apply to a saved search (their `kinds` include its kind). */
export const routesFor = (searchId: string, routes: Route[]) => routes.filter((r) => routeApplies(r, searchId));

/** The notification id without its slot suffix (`_s1` … `_s4`; slot 0 has none). ID-only, so only safe on IDs that
 *  carry no target ID (029's `<search>_notification_<format>`): a target ID may itself end in `_s1`. For a body, use
 *  slotOf / baseIdOf, which read the ID against the body's own target. */
export const stripSlotId = (id: string) => id.replace(/_s[1-9]\d*$/, '');

/** A body's result slot (036). Spec 035 IDs end in `__<targetId>` (+ `_sN`), and a target ID may end in `_s1`
 *  (`pulse_ops_s1`), so the slot is whatever follows the body's own `__<target>`, never a bare suffix match. */
export function slotOf(n: { id: string; targets?: string[] }): number {
  const t = n.targets?.length === 1 ? n.targets[0] : undefined;
  if (t) {
    const mark = `__${t}`;
    if (n.id.endsWith(mark)) return 0;
    const i = n.id.lastIndexOf(`${mark}_s`);
    if (i >= 0) {
      const m = /^_s([1-9]\d*)$/.exec(n.id.slice(i + mark.length));
      if (m) return Number(m[1]);
    }
  }
  // No target in the ID (the first default `<search>_notification`, `_s1` …).
  const m = /_s([1-9]\d*)$/.exec(n.id);
  return m ? Number(m[1]) : 0;
}

/** A body's ID without its slot suffix (slot 0 is the ID itself). See slotOf. */
export const baseIdOf = (n: { id: string; targets?: string[] }): string => {
  const s = slotOf(n);
  return s === 0 ? n.id : n.id.slice(0, -`_s${s}`.length);
};

/** True when `rest` is `live` or one of its slot copies (`live` + `_sN`). Exact, so `r1__pulse_ops_s1` is live for
 *  target `pulse_ops_s1` and is not cut back to `r1__pulse_ops`. */
const isLiveOrSlot = (rest: string, live: string) =>
  rest === live || (rest.startsWith(`${live}_s`) && /^_s[1-9]\d*$/.test(rest.slice(live.length)));

/** True when notification `id` belongs to route `rid` of `searchId` (`<search>_route_<rid>` or `…_<rid>_<format>`). */
export const isRouteNotification = (id: string, searchId: string, rid: string) => {
  const p = `${searchId}_route_${rid}`;
  const b = stripSlotId(id);
  return b === p || b.startsWith(`${p}__`) || SUFFIXES.some((f) => b === `${p}_${f}`);
};

/** routingMode 'vt_results' (fallback F1): the saved search that reads a route's rows from its parent. */
export const routeSearchId = (rid: string, kind: RouteKind) => `pulse_route_${rid}_${kind}`;

/** The route's rows of `parent` (its own matchers, none of the finals above it), with the run summary recomputed. */
export const routeSearchQuery = (parent: string, r: Route, routes: Route[], defaults: AlertEvent[] = DEFAULT_EVENTS) =>
  `dataset="$vt_results" | where jobName == ${kqlString(parent)} | where ${effectiveCondition(r, routes, parent, defaults)}${runSummary(searchKind(parent), true)}`;

/** Minutes a supported cron minute field fires on. Unsupported forms return undefined so shiftCron leaves them. */
function cronMinutes(field: string): number[] | undefined {
  if (/^\d+$/.test(field)) {
    const n = Number(field);
    return n >= 0 && n <= 59 ? [n] : undefined;
  }
  let g: RegExpExecArray | null;
  if ((g = /^\*\/(\d+)$/.exec(field))) {
    const step = Number(g[1]);
    if (step < 1) return undefined;
    const out: number[] = [];
    for (let i = 0; i <= 59; i += step) out.push(i);
    return out;
  }
  if ((g = /^(\d+)-(\d+)\/(\d+)$/.exec(field))) {
    const a = Number(g[1]), b = Number(g[2]), step = Number(g[3]);
    if (step < 1 || a > b || b > 59) return undefined;
    const out: number[] = [];
    for (let i = a; i <= b; i += step) out.push(i);
    return out;
  }
  if (/^\d+(,\d+)+$/.test(field)) {
    const parts = field.split(',').map(Number);
    if (parts.some((n) => n < 0 || n > 59 || !Number.isInteger(n))) return undefined;
    return parts;
  }
  return undefined;
}

/** Write shifted minutes back as one cron field. `4-59/5` + 2 is `1-59/5` (:01, :06, …, :56), not `6-59/5`. */
function formatMinutes(mins: number[]): string {
  const s = [...new Set(mins)].sort((a, b) => a - b);
  if (s.length === 1) return String(s[0]);
  if (s.length === 60) return '*';
  const step = s[1] - s[0];
  const ap = step > 0 && s.every((v, i) => i === 0 || v - s[i - 1] === step);
  if (!ap) return s.join(',');
  const start = s[0], end = s[s.length - 1];
  if (step === 1) return `${start}-${end}`;
  if (start === 0 && end === Math.floor(59 / step) * step && s.length === Math.floor(59 / step) + 1) return `*/${step}`;
  // Same minutes as start-end/step, written the way the rest of the pack writes ranges (`2-59/5`).
  if (end === start + step * Math.floor((59 - start) / step)) return `${start}-59/${step}`;
  return `${start}-${end}/${step}`;
}

/** A cron `by` minutes after `cron` (minute field only: `N`, `a-b/n`, `*\/n`, `a,b`; anything else is kept).
 *  A range that wraps past :59 still fires. `4-59/5` includes :59, so +2 must include :01. */
export function shiftCron(cron: string, by = 2): string {
  const [m, ...rest] = cron.trim().split(/\s+/);
  const mins = cronMinutes(m);
  if (!mins) return cron;
  return [formatMinutes(mins.map((x) => (x + by) % 60)), ...rest].join(' ');
}

/** routingMode 'vt_results' with a final route: the default notifications read the parent's rows that no final route
 *  took from this search, so resultSet[0] is never an alert a final route already sent (t0.md: F1 for the default too). */
export const defaultSearchId = (kind: RouteKind) => `pulse_route_default_${kind}`;

/** The default route's condition: none of the final routes (that apply) took the row, and — for missing and
 *  source_down — the row's event is one the default events allow (Send recovery notifications off → opened/reminder
 *  only). The digest has no event column, so that clause is skipped. '' when every row goes there. */
export function defaultCondition(routes: Route[], kind: RouteKind, defaults: AlertEvent[] = DEFAULT_EVENTS, own: AlertEvent[] = defaults): string {
  // `own`: the events the default notification itself takes (a native PagerDuty target: firing only); the finals above
  // keep matching on `defaults`.
  const finals = routes.filter((r) => r.final && (!r.when.kinds?.length || r.when.kinds.includes(kind)));
  const parts = [
    finals.length ? `not (${finals.map((r) => `(${routeCondition(r.when, kind, defaults)})`).join(' or ')})` : '',
    kind === 'digest' ? '' : eventsClause(own),
  ].filter(Boolean);
  return parts.join(' and ');
}

const SLOT_RE = /^slot == (\d+)$|^\((.*)\) and slot == (\d+)$/s;
/** A notification's route condition without its `slot == i` part ('' when the note only scoped a slot). */
const noteCondition = (n: NotificationBody) => {
  const c = String(n.conf.customValue ?? '');
  if (!c) return '';
  const m = SLOT_RE.exec(c);
  if (m) return m[2] ?? '';
  if (n.conf.triggerType === 'custom' || n.conf.triggerType === 'resultsCount') return c;
  return '';
};
/** @deprecated use noteCondition — kept for tests that still import the name */
export const baseCond = noteCondition;

const condStem = (base: string, ci: number) => (ci === 0 ? base : `${base}_firing${ci > 1 ? ci : ''}`);
const slotSearchId = (base: string, ci: number, slot: number) => {
  const stem = condStem(base, ci);
  return slot === 0 ? stem : `${stem}_s${slot}`;
};

/** routingMode 'vt_results': one derived search per (route condition, slot) for lifecycle alerts; digest keeps one
 *  search per condition with no `slot ==`. A slot search only filters. It does not recompute the run summary: the
 *  parent row already has n_alerts, others, others_s, and more_s from before the slot cut. */
export function vtSearches(parent: string, id: string, ns: NotificationBody[]): { searches: { id: string; query: string }[]; notes: NotificationBody[] } {
  const kind = searchKind(parent);
  if (kind === 'digest') {
    const conds: string[] = [];
    for (const n of ns) {
      const c = noteCondition(n);
      if (c && !conds.includes(c)) conds.push(c);
    }
    const sid = (i: number) => condStem(id, i);
    return {
      searches: conds.map((c, i) => ({ id: sid(i), query: `dataset="$vt_results" | where jobName == ${kqlString(parent)} | where ${c}${runSummary(kind, true)}` })),
      notes: ns.map((n) => {
        const c = noteCondition(n);
        return c ? onRouteSearch(n, sid(conds.indexOf(c))) : n;
      }),
    };
  }
  const conds: string[] = [];
  const key = (c: string, slot: number) => `${c}\0${slot}`;
  const seen = new Map<string, { id: string; query: string }>();
  const condIndex = (c: string) => {
    if (!conds.includes(c)) conds.push(c);
    return conds.indexOf(c);
  };
  const slotQuery = (slot: number, cond: string) => {
    const slotPart = `slot == ${slot}`;
    const where = cond ? `${slotPart} and (${cond})` : slotPart;
    // Do not append runSummary(..., true). That project-aways n_alerts / others / others_s / more_s and
    // eventstats-counts this one row, so every notice claims it was the only incident in the run.
    return `dataset="$vt_results" | where jobName == ${kqlString(parent)} | where ${where}`;
  };
  for (const n of ns) {
    const slot = slotOf(n);
    const c = noteCondition(n);
    const ci = condIndex(c);
    const sid = slotSearchId(id, ci, slot);
    const k = key(c, slot);
    if (!seen.has(k)) seen.set(k, { id: sid, query: slotQuery(slot, c) });
  }
  return {
    searches: [...seen.values()],
    notes: ns.map((n) => {
      const slot = slotOf(n);
      const c = noteCondition(n);
      const sid = slotSearchId(id, condIndex(c), slot);
      return onRouteSearch(n, sid);
    }),
  };
}

export function defaultSearchQuery(parent: string, routes: Route[], defaults: AlertEvent[] = DEFAULT_EVENTS): string | undefined {
  const kind = searchKind(parent);
  const cond = defaultCondition(routes, kind, defaults);
  if (!cond) return undefined;
  return `dataset="$vt_results" | where jobName == ${kqlString(parent)} | where ${cond}${runSummary(kind, true)}`;
}

/** In vt_results mode a route/default notification is `resultsCount > 0` on its derived search: the search already
 *  filtered `slot == i` and the route condition, so `resultSet[0]` is the one row to send. */
export function onRouteSearch(n: NotificationBody, savedQueryId: string): NotificationBody {
  return { ...n, conf: { triggerType: 'resultsCount', triggerComparator: '>', triggerCount: 0, savedQueryId, message: n.conf.message } };
}

/** Existing `<search>_route_*` ids that the current routes no longer produce (to be disabled, never deleted). */
export function staleNotifications(searchId: string, routes: Route[], existingIds: string[], rollCallTargets?: string[]): string[] {
  if (searchId === 'pulse_roll_call') return staleRollCall(rollCallTargets ?? [], existingIds);
  const prefix = `${searchId}_route_`;
  // Spec 035: only `<rid>__<targetId>` is live. 029's plain and format-suffixed ids (`r1`, `r2_slack`, `r2_pager_duty`) are stale.
  const live = routes.filter((r) => routeApplies(r, searchId)).flatMap((r) => r.targets.map((t) => `${r.id}__${t}`));
  const oldDefaults = new Set(SUFFIXES.map((f) => `${searchId}_notification_${f}`));
  return existingIds.filter((id) => {
    if (oldDefaults.has(stripSlotId(id))) return true; // 029's `<search>_notification_<format>`
    if (!id.startsWith(prefix)) return false;
    // Match the whole rest against each live `<rid>__<t>` and its `_sN` copies: never strip `_sN` first, since a
    // target ID may end in `_s1` (`r1__pulse_ops_s1` is the slot-0 body of target `pulse_ops_s1`).
    const rest = id.slice(prefix.length);
    return !live.some((l) => isLiveOrSlot(rest, l));
  });
}

/** Existing default-route notifications of `searchId` (`<search>_notification`, `…_notification_<format>`) that the
 *  current settings no longer produce: a target switched off, or 0.2.8's `_notification` once no text target is left.
 *  They are disabled, never deleted. */
export function staleDefaults(searchId: string, producedIds: string[], existingIds: string[]): string[] {
  const own = new Set([`${searchId}_notification`, ...SUFFIXES.map((f) => `${searchId}_notification_${f}`)]);
  const now = new Set(producedIds);
  return existingIds.filter((id) => (own.has(stripSlotId(id)) || stripSlotId(id).startsWith(`${searchId}_notification__`)) && !now.has(id));
}

const KIND_LABEL: Record<RouteKind, string> = { missing: 'missing', source_down: 'source down', digest: 'digest' };

/** One-line sentence for a route's matchers, e.g. "P1–P2 · team network · missing, source down". */
export function whenSentence(when: Route['when']): string {
  const parts: string[] = [];
  if (when.maxCriticality != null) parts.push(when.maxCriticality === 1 ? 'P1' : `P1–P${when.maxCriticality}`);
  if (when.team) parts.push(`team ${when.team}`);
  if (when.input) parts.push(`input ${when.input}`);
  if (when.kinds && when.kinds.length) parts.push(when.kinds.map((k) => KIND_LABEL[k] ?? k).join(', '));
  return parts.length ? parts.join(' · ') : 'any alert';
}

/** Move the route at `i` by `delta` (-1 up, +1 down). Out of range returns the list unchanged. */
export function moveRoute<T>(list: T[], i: number, delta: number): T[] {
  const j = i + delta;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return list;
  const out = list.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** What a route matches on, for one alert (browser-side preview of the Search-side condition). */
export type AlertRow = { kind: RouteKind; criticality: number; team?: string; input?: string; event?: AlertEvent };

/** Pure: does an alert row satisfy the route's matchers (AND-ed; empty matcher = any)? */
export function routeMatches(when: Route['when'], row: AlertRow, defaults: AlertEvent[] = DEFAULT_EVENTS): boolean {
  if (when.kinds && when.kinds.length && !when.kinds.includes(row.kind)) return false;
  if (when.maxCriticality != null && !(row.criticality <= when.maxCriticality)) return false;
  if (when.team && (row.team ?? '') !== when.team) return false;
  if (when.input && (row.input ?? '') !== when.input) return false;
  if (!(when.events ?? defaults).includes(row.event ?? 'opened')) return false;
  return true;
}

/** Pure: how many of the rows the route would have received; `above` are the final routes above it, which take theirs first. */
export function previewCount(when: Route['when'], rows: AlertRow[], above: Route['when'][] = [], defaults: AlertEvent[] = DEFAULT_EVENTS): { x: number; y: number } {
  return { x: rows.filter((r) => routeMatches(when, r, defaults) && !above.some((a) => routeMatches(a, r, defaults))).length, y: rows.length };
}

export const MAX_ROUTES = 5;

export const ROLL_CALL_NOTE = 'pulse_roll_call_notification';

/** Spec 035 ID rule for the roll call: the first target keeps `pulse_roll_call_notification`, the others get `__<targetId>`. */
export const rollCallNotificationIds = (targets: string[]): string[] =>
  [...new Set(targets)].map((t, i) => (i === 0 ? ROLL_CALL_NOTE : `${ROLL_CALL_NOTE}__${t}`));

/** Existing roll-call notifications the current targets no longer produce, to be disabled (never deleted). This includes
 *  033's `pulse_roll_call_notification__<firstTargetId>`, which would notify the first target twice next to the plain ID. */
export function staleRollCall(targets: string[], existingIds: string[]): string[] {
  const live = new Set(rollCallNotificationIds(targets));
  return existingIds.filter((id) => (id === ROLL_CALL_NOTE || id.startsWith(`${ROLL_CALL_NOTE}__`)) && !live.has(id));
}

/** Daily load: the roll-call notifications, one per target (spec 035 ID rule, rollCallNotificationIds). They fire when
 *  n_missing > 0, or on every run with allClear, and carry no result rows. */
export const rollCallNotifications = (targets: string[], o: { email?: string; allClear: boolean; message: string }): NotificationBody[] =>
  [...new Set(targets)].map((t, i) => ({
    id: i === 0 ? ROLL_CALL_NOTE : `${ROLL_CALL_NOTE}__${t}`, disabled: false, condition: 'search', group: 'default_search', targets: [t], metadata: [],
    targetConfigs: [{ id: t, conf: t === 'system_email'
      ? { emailRecipient: { to: o.email, ccEnabled: false }, subject: 'Pulse roll call', includeResults: false, attachmentType: 'inline' }
      : { includeResults: false } }],
    conf: { triggerType: 'custom', customValue: o.allClear ? 'true' : 'n_missing > 0', savedQueryId: 'pulse_roll_call', message: o.message },
  }));
