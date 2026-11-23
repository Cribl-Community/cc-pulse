// Notification channel helpers: request bodies for POST /notification-targets, validation, Teams card expression.
// Pure: no React, no network.

export const PULSE_TARGET_PREFIX = 'pulse_';

export type Preset = 'slack' | 'teams' | 'pagerduty' | 'pagerduty_v2' | 'webhook';

export const PD_EVENTS_V2_URL = 'https://events.pagerduty.com/v2/enqueue';
export const PD_V2_HELP = "The routing key lives in the target's source expression (not in a routing key field). Resolved and expired events close the PagerDuty incident automatically.";

/** JS expression (evaluated by a custom webhook target) that turns a Pulse alert event v1 (`__e`, or its JSON `message`) into a PagerDuty Events v2 body. */
export function pdEventsV2Expression(routingKey: string): string {
  const k = JSON.stringify(routingKey);
  return (
    `(function(){var e=__e;var raw=e&&typeof e.message==='string'?e.message:null;` +
    `if(raw){try{e=JSON.parse(raw)}catch(x){}}` +
    `var inc=e.incident_id;` +
    `if(inc){var r=e.state==='resolved'||e.event==='resolved'||e.event==='expired';` +
    `return JSON.stringify({routing_key:${k},event_action:r?'resolve':'trigger',dedup_key:inc,` +
    `payload:{summary:e.summary,severity:e.severity,source:e.asset||e.input||'pulse'}})}` +
    `if(e.kind==='digest'){return JSON.stringify({routing_key:${k},event_action:'trigger',` +
    `dedup_key:'pulse:digest:'+e.worker_group+':'+e.input,` +
    `payload:{summary:e.summary||raw,severity:e.severity||'info',source:'pulse'}})}` +
    `return JSON.stringify({routing_key:${k},event_action:'trigger',dedup_key:'pulse:test',` +
    `payload:{summary:raw||String(e.message||e.summary||''),severity:'info',source:'pulse'}})})()`
  );
}

export interface ChannelForm {
  id: string;
  url?: string;
  routingKey?: string;
  severity?: string;
  auth?: 'none' | 'bearer' | 'basic';
  token?: string;
  username?: string;
  password?: string;
}

/** JS expression (evaluated by a custom webhook target) wrapping `field` of the event in a Teams Adaptive Card message. */
export function teamsSrcExpression(field: string): string {
  const f = JSON.stringify(field);
  return (
    `JSON.stringify({type:'message',attachments:[{contentType:'application/vnd.microsoft.card.adaptive',contentUrl:null,` +
    `content:{type:'AdaptiveCard',$schema:'http://adaptivecards.io/schemas/adaptive-card.json',version:'1.4',` +
    `body:[{type:'TextBlock',wrap:true,text:String(__e[${f}])}]}}]})`
  );
}

export function targetBody(preset: Preset, form: ChannelForm): Record<string, unknown> {
  const id = form.id;
  const url = form.url ?? '';
  switch (preset) {
    case 'slack':
      // Needs T0 verification against the org's notification-targets schema.
      return { id, type: 'slack', url };
    case 'pagerduty':
      // Needs T0 verification (field names routingKey/severity).
      return { id, type: 'pager_duty', routingKey: form.routingKey ?? '', severity: form.severity ?? 'error' };
    case 'pagerduty_v2':
      return { id, type: 'webhook', format: 'custom', method: 'POST', url: PD_EVENTS_V2_URL, srcExpression: pdEventsV2Expression(form.routingKey ?? '') };
    case 'teams':
      // Needs T0 verification (custom format + srcExpression).
      return { id, type: 'webhook', format: 'custom', method: 'POST', url, srcExpression: teamsSrcExpression('message') };
    case 'webhook': {
      // Needs T0 verification (auth field names).
      const body: Record<string, unknown> = { id, type: 'webhook', format: 'ndjson', method: 'POST', url };
      if (form.auth === 'bearer') Object.assign(body, { authType: 'token', token: form.token ?? '' });
      else if (form.auth === 'basic') Object.assign(body, { authType: 'basic', username: form.username ?? '', password: form.password ?? '' });
      else Object.assign(body, { authType: 'none' });
      return body;
    }
  }
}

const MASK = '••••';

/** Hides a secret: shows at most its last 4 characters (none when it is short). A URL keeps only its host. */
export function redact(secret: string): string {
  const s = String(secret ?? '');
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(s);
  const tail = (v: string) => (v.length >= 8 ? MASK + v.slice(-4) : MASK);
  if (m) {
    const host = m[1].replace(/^[^@]*@/, '');
    const path = m[2].replace(/\/+$/, '');
    if (!path) return host;
    return `${host}/…/${tail(path.slice(1))}`;
  }
  return s ? tail(s) : '';
}

/** T0: smtp targets report totalSent / errorCnt; slack, pager_duty and webhook report sentCount / numDropped. */
export type TestMetrics = { totalSent?: number; errorCnt?: number; sentCount?: number; numDropped?: number };
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
export const sentOf = (m?: TestMetrics) => num(m?.totalSent) ?? num(m?.sentCount);
export const errorsOf = (m?: TestMetrics) => num(m?.errorCnt) ?? num(m?.numDropped);

export type Tone = 'success' | 'warning' | 'danger' | 'default';

export interface ChannelRow {
  id: string;
  kind: string;
  tone: Tone;
  where: string;
  sent?: number;
  errors?: number;
}

const KINDS: Record<string, string> = {
  slack: 'Slack',
  pager_duty: 'PagerDuty',
  sns: 'SNS',
  smtp: 'Email',
  bulletin_message: 'In-product',
};

const TONES: Record<string, Tone> = { Green: 'success', Yellow: 'warning', Red: 'danger' };

/* eslint-disable @typescript-eslint/no-explicit-any */
export function channelRows(targets: any[]): ChannelRow[] {
  return (targets ?? []).map((t) => {
    let kind = KINDS[t.type];
    if (!kind) {
      kind = t.type === 'webhook' && t.format === 'custom' && /AdaptiveCard/.test(String(t.srcExpression ?? '')) ? 'Teams' : 'Webhook';
    }
    let where = '';
    if (t.type === 'pager_duty') where = t.routingKey ? MASK + String(t.routingKey).slice(-4) : '';
    else if (t.type === 'smtp') where = 'recipients set per alert'; // T0: the smtp target has no recipients field
    else if (t.url) where = redact(String(t.url));
    else if (t.host) where = String(t.host);
    const row: ChannelRow = { id: t.id, kind, tone: TONES[t.status?.health] ?? 'default', where };
    const m = t.status?.metrics;
    const sent = sentOf(m), errors = errorsOf(m);
    if (sent !== undefined) row.sent = sent;
    if (errors !== undefined) row.errors = errors;
    return row;
  });
}

/** First free `pulse_<preset>_<n>` (n from 1). */
export function nextTargetId(preset: Preset, existingIds: string[]): string {
  let n = 1;
  while (existingIds.includes(`${PULSE_TARGET_PREFIX}${preset}_${n}`)) n++;
  return `${PULSE_TARGET_PREFIX}${preset}_${n}`;
}

/** The confirmation shown before a target is created. */
export function confirmText(id: string, presetLabel: string): string {
  return `Create notification target \`${id}\` (${presetLabel})? It is shared with every Cribl product in this org. Pulse can't edit or delete it later; use Cribl → Settings → Notification targets.`;
}

/** Forces the pulse_ prefix on whatever the user typed. */
export function withPrefix(v: string): string {
  const s = String(v ?? '');
  if (s.startsWith(PULSE_TARGET_PREFIX)) return s;
  return PULSE_TARGET_PREFIX.startsWith(s) ? PULSE_TARGET_PREFIX : PULSE_TARGET_PREFIX + s;
}

const ID_RE =/^pulse_[a-z0-9_]{1,48}$/;

export function validChannel(preset: Preset, form: ChannelForm, existingIds: string[]): string | null {
  const id = form.id ?? '';
  if (!ID_RE.test(id)) return `ID must match ${PULSE_TARGET_PREFIX} followed by 1-48 lowercase letters, digits or underscores`;
  if (existingIds.includes(id)) return `A target with ID ${id} already exists`;
  const url = form.url ?? '';
  if (preset === 'slack') {
    if (!url.startsWith('https://hooks.slack.com/')) return 'Slack URL must start with https://hooks.slack.com/';
  } else if (preset === 'pagerduty' || preset === 'pagerduty_v2') {
    if ((form.routingKey ?? '').length !== 32) return 'PagerDuty routing key must be 32 characters';
  } else if (!url.startsWith('https://') || url.length <= 'https://'.length) {
    return 'URL must start with https://';
  }
  return null;
}

export const TEST_TIMEOUT_MS = 3 * 60_000;

/** T0: a cron pinned to one date and minute (`8 18 18 11 *`) is never run by the Search scheduler, so the test
 *  schedule runs every minute and sendTest switches it off right after the first run (see testStopAt). */
export const TEST_CRON = '* * * * *';

/** When to disable the test schedule: 20 s after the next whole minute. A scheduled job is created on the minute
 *  (its timeCreated is the boundary) even when it is dispatched later, so it survives the disable. */
export function testStopAt(nowMs: number): number {
  return Math.floor(nowMs / 60_000) * 60_000 + 60_000 + 20_000;
}


/** The full saved search with its schedule switched off. T0: a PATCH carrying only `schedule` returns 500
 *  ("Cannot read properties of undefined (reading 'lastIndexOf')"), so the whole object goes back, minus `status`. */
export function disabledSaved<T extends { schedule?: object; status?: unknown }>(cur: T): Omit<T, 'status'> {
  const { status: _status, ...rest } = cur;
  void _status;
  return { ...rest, schedule: { ...(cur.schedule ?? {}), enabled: false } };
}
export type TestResult = { state: 'sent' } | { state: 'failed'; errors: number } | { state: 'no-answer' } | { state: 'waiting' };

/** Compares the metrics read now with the starting ones. Errors win over a delivery only when no delivery was seen. */
export function compareMetrics(start: TestMetrics, now: TestMetrics, elapsedMs: number): TestResult {
  if ((sentOf(now) ?? 0) > (sentOf(start) ?? 0)) return { state: 'sent' };
  const errors = (errorsOf(now) ?? 0) - (errorsOf(start) ?? 0);
  if (errors > 0) return { state: 'failed', errors };
  return elapsedMs >= TEST_TIMEOUT_MS ? { state: 'no-answer' } : { state: 'waiting' };
}
