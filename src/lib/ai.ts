import { apiBase } from './host';
import type { AiSettings, AppSettings } from './settings';

/* Cribl AI = the org's own AI Settings, reached through the generic agent endpoint (same contract as
   the pack-generator app): NDJSON stream, keep chunk.content, drop reasoning; the agent ignores the
   system role so the system prompt is prepended to the user message. */
async function criblAi(system: string, user: string): Promise<string> {
  const res = await fetch(`${apiBase()}/ai/q/agents/open_investigator`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: `${system}\n\n---\n\n${user}` }], stream: true, context: {}, tools: [], sessionId: crypto.randomUUID() }),
  });
  if (!res.ok) throw new Error(`Cribl AI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  let out = '';
  for (const line of (await res.text()).split('\n')) {
    const l = line.replace(/^data:\s*/, '').trim();
    if (!l || l === '[DONE]') continue;
    try {
      const c = JSON.parse(l) as { content?: string; type?: string; error?: string; chunk?: { content?: string; type?: string; error?: string } };
      const ch = c.chunk ?? c;
      if (ch.error) throw new Error(ch.error);
      if (ch.type !== 'reason' && typeof ch.content === 'string') out += ch.content;
    } catch (e) { if (e instanceof Error && !(e instanceof SyntaxError)) throw e; }
  }
  return out;
}

/* External providers: the app calls the public URL with no key; config/proxies.yml injects the key
   from the encrypted KV entry secrets/<provider>ApiKey. */
async function anthropic(model: string, system: string, user: string) {
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 2000, system, messages: [{ role: 'user', content: user }] }) });
  if (!r.ok) throw new Error(`Anthropic ${r.status}`);
  return ((await r.json()) as { content: { text?: string }[] }).content.map((c) => c.text ?? '').join('');
}
async function openai(model: string, system: string, user: string) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }) });
  if (!r.ok) throw new Error(`OpenAI ${r.status}`);
  return ((await r.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content;
}

export const complete = (ai: AiSettings, system: string, user: string) =>
  ai.provider === 'anthropic' ? anthropic(ai.model, system, user) : ai.provider === 'openai' ? openai(ai.model, system, user) : criblAi(system, user);

/* ---------- Ask Pulse: closed action set, plan-then-confirm ---------- */
export type Action =
  | { type: 'query'; kql: string; earliest?: string; latest?: string }
  | { type: 'deploy'; group: string; inputs: string[] }
  | { type: 'mute'; input: string; asset: string; days?: number; note?: string }
  | { type: 'unmute'; input: string; asset: string }
  | { type: 'threshold'; input: string; asset: string; max_gap_s: number }
  | { type: 'install_alerts'; enabled: boolean }
  | { type: 'ack'; asset: string; input?: string }
  | { type: 'maintenance'; scope: string; hours?: number; reason?: string };
export type AskResult = { answer: string; actions: Action[] };

export interface AskRange { label: string; earliest: string; latest: string }

/** Window for a query action: its own earliest (and latest, default now) if given, else the page range. */
export function queryWindow(a: { earliest?: string; latest?: string }, scope: { earliest: string; latest: string }) {
  return a.earliest ? { earliest: a.earliest, latest: a.latest ?? 'now' } : { earliest: scope.earliest, latest: scope.latest };
}
export function runQueryAction<R>(a: { kql: string; earliest?: string; latest?: string }, scope: { earliest: string; latest: string },
  search: (kql: string, earliest: string, latest: string) => Promise<R>): Promise<R> {
  const w = queryWindow(a, scope);
  return search(a.kql, w.earliest, w.latest);
}

export function systemPrompt(s: AppSettings, context: string, range?: AskRange) {
  return `You are Pulse, an assistant inside a Cribl App that watches Cribl Stream sources for missing assets (hosts).
DATA: Cribl Lake dataset "${s.dataset}" holds metric events every 60s: _metric=="pulse.heartbeat", _value=events in the minute,
bytes, event_lag_s, dims worker_group, input (Cribl __inputId e.g. "http:in_http_hostmiss:cribl"), asset, asset_src (how the asset
was identified: host, syslog, csv:2, kv:devname, ip, none…), worker.
The latest computed state per asset is read with dataset="$vt_results" | where jobName == "pulse_state", with columns
worker_group,input,asset,state(ok|late|delayed|missing|acked|maintenance|learning|muted),signal(clock_skew|delayed|low_volume),silent_min,tolerance_s,expected_gap_s,active_min,last_seen_utc,computed_at.
KQL is Cribl Search KQL (use "or"/"and", never "||"; summarize, countif, dcount, timestats span=5m, where, project, sort by, limit).
${range ? `CURRENT RANGE: the user is viewing "${range.label}" (earliest=${range.earliest}, latest=${range.latest}). Queries run over this range by default.\n` : ''}CURRENT STATE (summary): ${context}
Reply with ONLY a JSON object: {"answer": "<short markdown answer for the user>", "actions": [ ... ]}.
Allowed actions (never invent others):
 {"type":"query","kql":"<KQL>"}            read-only, run automatically to answer data questions; add "earliest" and "latest" (e.g. "-7d", "now") ONLY when the user asks for a different window than the current range
 {"type":"deploy","group":"<worker group>","inputs":["<input id prefix>",...]}   watch sources ([] = all non-internal)
 {"type":"mute","input":"..","asset":"..","days":2,"note":".."} {"type":"unmute","input":"..","asset":".."}
 {"type":"threshold","input":"..","asset":"..","max_gap_s":900}  {"type":"install_alerts","enabled":true}
 {"type":"ack","asset":"..","input":".."}   acknowledge the current silence (ends when the asset sends again)
 {"type":"maintenance","scope":"*" | "g:<group>" | "i:<group>|<input>","hours":2,"reason":".."}   maintenance window starting now
If the question can be answered from CURRENT STATE, answer directly with no actions. Change actions are only proposed — the user must confirm.`;
}

export function parseAsk(text: string): AskResult {
  const m = text.match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]) as AskResult; return { answer: j.answer ?? '', actions: Array.isArray(j.actions) ? j.actions : [] }; } catch { /* fallthrough */ } }
  return { answer: text, actions: [] };
}
export const isChange = (a: Action) => a.type !== 'query';
