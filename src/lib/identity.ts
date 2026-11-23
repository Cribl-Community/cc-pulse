/* Asset identity (spec 003). The Stream pack resolves the asset with the same rules (pulse_heartbeat Code
   function) — keep the two in sync; scripts/test-identity.mjs runs both on the same fixtures.
   A key spec says where the asset name lives in an event:
     host | field:<path> | json:<path> | syslog | csv:<n> | kv:<key> | ip | source | none | regex:<pattern>
   Chain fallbacks with " | " ("kv:devname | ip"); a regex: segment must come last; "auto" expands to AUTO. */

export type Ev = Record<string, unknown>;
export const DEFAULT_WEAK = ['localhost', 'localhost.localdomain', '127.0.0.1', '::1', 'unknown', '-', 'none', 'null', 'undefined'];
export const AUTO = ['host', 'field:hostname', 'field:host.name', 'field:hostName', 'field:ComputerName', 'field:Computer',
  'field:computer_name', 'field:device_name', 'field:dvchost', 'field:devname', 'field:agent.hostname', 'syslog',
  'kv:devname', 'kv:dvchost', 'ip'];
export const SOURCE_LABEL = '(source)';

const dig = (o: unknown, p: string) => p.split('.').reduce<unknown>((a, k) => (a === undefined || a === null ? undefined : (a as Record<string, unknown>)[k]), o);
const reEsc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function chainOf(spec: string): string[] {
  const chain: string[] = [];
  for (const p of (spec || 'auto').split(' | ')) {
    if (chain.length && chain[chain.length - 1].startsWith('regex:')) chain[chain.length - 1] += ' | ' + p;
    else if (p === 'auto') chain.push(...AUTO);
    else chain.push(p.trim());
  }
  return chain;
}

/** One rule on one event. Returns '' when the rule finds nothing usable. */
export function applyRule(s: string, e: Ev, weak = DEFAULT_WEAK): string {
  const raw = typeof e._raw === 'string' ? e._raw : '';
  const good = (v: unknown) => {
    if (v === undefined || v === null || typeof v === 'object') return '';
    const t = String(v).trim();
    return t && t.length <= 253 && !weak.includes(t.toLowerCase()) ? t : '';
  };
  if (s === 'host') return good(e.host);
  if (s === 'ip') return good(e.__srcIpPort ? String(e.__srcIpPort).replace(/^\[/, '').replace(/\]?:\d+$/, '') : e.src_ip);
  if (s === 'source') return good(e.source);
  if (s === 'syslog') {
    if (raw.charAt(0) !== '<' && !/^[A-Z][a-z]{2} /.test(raw)) return '';
    const m = raw.match(/^<\d{1,3}>1 \S+ (\S+) /) || raw.match(/^(?:<\d{1,3}>)?[A-Z][a-z]{2} +\d{1,2} \d\d:\d\d:\d\d (\S+) /);
    return m ? good(m[1] === '-' ? '' : m[1]) : '';
  }
  if (s.startsWith('field:')) return good(dig(e, s.slice(6)));
  if (s.startsWith('json:')) { try { return raw.charAt(0) === '{' ? good(dig(JSON.parse(raw), s.slice(5))) : ''; } catch { return ''; } }
  if (s.startsWith('csv:')) return good(raw.split(',')[Number(s.slice(4))]);
  if (s.startsWith('kv:')) {
    const m = raw.match(new RegExp('(?:^|[\\s,;|])' + reEsc(s.slice(3)) + '=(?:"([^"]*)"|([^\\s,;|]+))'));
    return m ? good(m[1] !== undefined ? m[1] : m[2]) : '';
  }
  if (s.startsWith('regex:')) { try { const m = raw.match(new RegExp(s.slice(6))); return m && m[1] !== undefined ? good(m[1]) : ''; } catch { return ''; } }
  return '';
}

export function resolve(e: Ev, spec = 'auto', weak = DEFAULT_WEAK): { asset: string; src: string } {
  for (const s of chainOf(spec)) {
    if (s === 'none') break;
    const a = applyRule(s, e, weak);
    if (a) return { asset: a, src: s };
  }
  return { asset: SOURCE_LABEL, src: 'none' };
}

/* ---------- labels ---------- */
export function describeRule(s: string): string {
  if (s === 'host') return 'host field';
  if (s === 'ip') return 'source IP';
  if (s === 'source') return 'source path';
  if (s === 'syslog') return 'syslog header';
  if (s === 'none') return 'whole source';
  if (s === 'auto') return 'automatic';
  if (s.startsWith('field:')) return `field ${s.slice(6)}`;
  if (s.startsWith('json:')) return `JSON ${s.slice(5)} in the raw event`;
  if (s.startsWith('csv:')) return `CSV column ${Number(s.slice(4)) + 1}`;
  if (s.startsWith('kv:')) return `${s.slice(3)}= in the raw event`;
  if (s.startsWith('regex:')) return 'regular expression';
  return s;
}
export const describeSpec = (spec: string) => (spec || 'auto').split(' | ').map(describeRule).join(', then ');

/* ---------- identity health of a source (what the heartbeat already tells us) ---------- */
export type IdHealth = 'strong' | 'fallback' | 'weak' | 'source';
export const ID_LABEL: Record<IdHealth, string> = { strong: 'Identified', fallback: 'By source IP', weak: 'Unreliable', source: 'Source only' };
const looksWrong = (a: string) => /\s|@/.test(a) || a.length > 80;

export function sourceIdentity(assets: { asset: string; key_src?: string }[]): { health: IdHealth; why: string } {
  const n = assets.length, srcs = new Set(assets.map((a) => a.key_src || '?'));
  if (!n) return { health: 'source', why: 'No asset seen yet.' };
  if (assets.every((a) => a.asset === SOURCE_LABEL || a.key_src === 'none')) return { health: 'source', why: 'No rule found a sender name, so the source is watched as one entity.' };
  const bad = assets.filter((a) => DEFAULT_WEAK.includes(a.asset.toLowerCase()) || looksWrong(a.asset));
  if (bad.length) return { health: 'weak', why: `${bad.length === n ? 'Every' : bad.length} asset name${bad.length > 1 && bad.length !== n ? 's' : ''} look${bad.length > 1 || bad.length === n ? '' : 's'} like a placeholder or free text (“${bad[0].asset.slice(0, 40)}”). Pick a key that names the sender.` };
  if (srcs.size === 1 && srcs.has('ip')) return { health: 'fallback', why: 'Assets are identified by source IP only. Relays, NAT and load balancers can hide or merge senders.' };
  if (n === 1 && !srcs.has('host')) return { health: 'weak', why: 'A single asset on this source — check that it really is the sender and not a relay.' };
  return { health: 'strong', why: `Assets come from ${[...srcs].map(describeRule).join(' and ')}.` };
}

/* ---------- Key Advisor: rank candidate specs on real samples ---------- */
export type Sample = { raw: string; fields: Record<string, unknown>; src_ip?: string };
export type Candidate = { spec: string; label: string; coverage: number; distinct: number; examples: string[]; score: number; note: string };

const HOSTY = /(host|computer|device|dvc|devname|node|server|serial|sensor|agent|machine|beat|instance)/i;
const valueOk = (v: string) => !!v && v.length <= 80 && !/\s/.test(v) && !/^\d{1,4}$/.test(v) && !/^\d{4}[-/]\d\d[-/]\d\d/.test(v) && !/^\d+(\.\d+)?$/.test(v) || /^\d{8,}$/.test(v);

export function candidates(samples: Sample[]): Candidate[] {
  if (!samples.length) return [];
  const evs: Ev[] = samples.map((s) => ({ ...s.fields, _raw: s.raw, src_ip: s.src_ip }));
  const specs = new Set<string>(['host', 'syslog', 'ip', ...AUTO]);
  for (const s of samples) {
    for (const [k, v] of Object.entries(s.fields)) if (typeof v === 'string' || typeof v === 'number') specs.add(`field:${k}`);
    for (const m of s.raw.matchAll(/(?:^|[\s,;|])([A-Za-z_][\w.]{1,40})=/g)) if (HOSTY.test(m[1])) specs.add(`kv:${m[1]}`);
    if (s.raw.charAt(0) === '{') { try { for (const k of Object.keys(JSON.parse(s.raw))) if (HOSTY.test(k)) specs.add(`json:${k}`); } catch { /* not JSON */ } }
    const cols = s.raw.split(',');
    if (cols.length >= 6) cols.slice(0, 90).forEach((_, i) => specs.add(`csv:${i}`));
  }
  const n = evs.length, out: Candidate[] = [];
  for (const spec of specs) {
    const vals = evs.map((e) => applyRule(spec, e)).filter(Boolean);
    if (!vals.length) continue;
    const coverage = vals.length / n, distinct = new Set(vals).size, okShare = vals.filter(valueOk).length / vals.length;
    const name = spec.split(':').slice(1).join(':');
    // Favour: full coverage, names that look like hosts, a key named like a host, a plausible number of senders.
    const named = HOSTY.test(name) || spec === 'syslog' || spec === 'host';
    const hostShape = vals.filter((v) => /^[A-Za-z][\w.-]*\d[\w.-]*$/.test(v) || /^\d{8,}$/.test(v)).length / vals.length; // fw-par-01, PA-3260-A, serials
    let score = coverage * 50 + okShare * 20 + (named ? 15 : 0) + hostShape * 12;
    if (distinct === vals.length && n > 6) score -= 30;            // unique per event → an id or a timestamp, not a sender
    if (distinct === 1 && n > 6) score -= named ? 6 : 28;          // a constant (sourcetype, log type) names no sender
    if (vals.some((v) => DEFAULT_WEAK.includes(v.toLowerCase()))) score -= 40;
    if (spec === 'ip') score -= 6;                                  // works, but relays hide senders
    const note = distinct === vals.length && n > 6 ? 'different on every event — probably an id, not a sender'
      : distinct === 1 ? 'one value in every sample' : `${distinct} senders in ${n} samples`;
    out.push({ spec, label: describeRule(spec), coverage, distinct, examples: [...new Set(vals)].slice(0, 4), score, note });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

export const PRESETS: { spec: string; label: string; hint: string }[] = [
  { spec: 'auto', label: 'Automatic', hint: 'host, common host fields, syslog header, devname/dvchost, then source IP' },
  { spec: 'syslog', label: 'Syslog header', hint: 'hostname in an RFC 3164/5424 header, when the source does not parse it' },
  { spec: 'csv:2 | ip', label: 'Palo Alto serial (CSV column 3)', hint: 'PAN-OS CSV logs; falls back to the source IP' },
  { spec: 'kv:devname | ip', label: 'Fortinet devname', hint: 'FortiGate key=value logs' },
  { spec: 'kv:dvchost | ip', label: 'CEF dvchost', hint: 'ArcSight CEF extension' },
  { spec: 'field:Computer | field:ComputerName', label: 'Windows Computer', hint: 'Windows event logs' },
  { spec: 'field:host.name | field:agent.hostname', label: 'Elastic / Beats host.name', hint: 'ECS documents' },
  { spec: 'ip', label: 'Source IP', hint: 'one asset per sending address' },
  { spec: 'none', label: 'Whole source', hint: 'no per-sender identity; watch the source as one entity (volume and silence)' },
];
