// Spec 030 §1: pure reference for the incident ledger lifecycle. No IO, no clock: `nowS` is passed in.

export type LedgerKind = 'asset' | 'source';

export interface LedgerEntity {
  worker_group: string;
  input: string;
  asset: string;
  state: string;
  raw_state: string;
  eligible: boolean;
  last_seen: number;
  criticality: string;
  team: string;
}

export type LedgerEvent = 'opened' | 'open' | 'reminder' | 'resolved' | 'expired';

export interface LedgerRow {
  worker_group: string;
  input: string;
  asset: string;
  incident_id: string;
  opened_at: number;
  last_seen_at_open: number;
  notified_at: number;
  event: LedgerEvent;
  criticality: string;
  team: string;
}

export interface LedgerOpts {
  remindH: number;
  kind: LedgerKind;
  /** Keys `${incident_id}|${event}` of the alert search's last run. Omitted: every previous event counts as delivered. */
  delivered?: string[];
}

const keyOf = (kind: LedgerKind, r: { worker_group: string; input: string; asset: string }): string =>
  [r.worker_group, r.input, kind === 'asset' ? r.asset : ''].join('\u0001');

const incidentId = (kind: LedgerKind, e: { worker_group: string; input: string; asset: string }, openedAt: number): string =>
  `pulse:${kind}:${e.worker_group}:${e.input}:${kind === 'asset' ? e.asset : ''}:${openedAt}`;

const QUIET = new Set(['acked', 'muted', 'maintenance']);

function newRow(kind: LedgerKind, e: LedgerEntity, nowS: number, event: LedgerEvent): LedgerRow {
  const asset = kind === 'asset' ? e.asset : '';
  return {
    worker_group: e.worker_group,
    input: e.input,
    asset,
    incident_id: incidentId(kind, { ...e, asset }, nowS),
    opened_at: nowS,
    last_seen_at_open: e.last_seen,
    notified_at: nowS,
    event,
    criticality: e.criticality,
    team: e.team,
  };
}

const isMissing = (e: LedgerEntity): boolean => e.raw_state !== 'ok' && e.raw_state !== 'late';

export function step(prevLedger: LedgerRow[], entities: LedgerEntity[], nowS: number, opts: LedgerOpts): { ledger: LedgerRow[]; events: LedgerRow[] } {
  const { kind, remindH } = opts;
  const delivered = opts.delivered === undefined ? undefined : new Set(opts.delivered);
  const ents = new Map<string, LedgerEntity>();
  for (const e of entities) ents.set(keyOf(kind, e), e);

  const ledger: LedgerRow[] = [];
  const events: LedgerRow[] = [];
  const openKeys = new Set<string>();

  for (const prev of prevLedger) {
    const pending = delivered !== undefined && prev.event !== 'open' && !delivered.has(`${prev.incident_id}|${prev.event}`);
    if (!pending && (prev.event === 'resolved' || prev.event === 'expired')) continue;
    const k = keyOf(kind, prev);
    const e = ents.get(k);
    let row: LedgerRow;
    if (pending && (prev.event === 'resolved' || prev.event === 'expired')) {
      // Re-emitted as-is until delivered; the entity key stays reserved so it is not reopened in the same run.
      row = prev;
    } else if (pending && prev.event === 'opened') {
      if (e && isMissing(e)) row = prev;
      else {
        // Never notified, so it never resolves: dropped silently (the entity may open anew below).
        continue;
      }
    } else if (pending && prev.event === 'reminder') {
      row = !e ? { ...prev, event: 'expired' } : isMissing(e) ? prev : { ...prev, event: 'resolved' };
    } else if (!e) {
      row = { ...prev, event: 'expired' };
    } else if (!isMissing(e)) {
      row = { ...prev, event: 'resolved' };
    } else if (remindH > 0 && nowS - prev.notified_at >= remindH * 3600 && !QUIET.has(e.state)) {
      row = { ...prev, event: 'reminder', notified_at: nowS };
    } else {
      row = { ...prev, event: 'open' };
    }
    openKeys.add(k);
    ledger.push(row);
    if (row.event !== 'open') events.push(row);
  }

  for (const e of entities) {
    const k = keyOf(kind, e);
    if (openKeys.has(k)) continue;
    openKeys.add(k);
    if (!(isMissing(e) && e.eligible)) continue;
    const row = newRow(kind, e, nowS, 'opened');
    ledger.push(row);
    events.push(row);
  }

  return { ledger, events };
}

/** Ledger for an install: already-missing eligible entities are written as `open`, with no event. */
export function seed(entities: LedgerEntity[], nowS: number, kind: LedgerKind = 'asset'): LedgerRow[] {
  const seen = new Set<string>();
  const out: LedgerRow[] = [];
  for (const e of entities) {
    const k = keyOf(kind, e);
    if (seen.has(k) || !(isMissing(e) && e.eligible)) continue;
    seen.add(k);
    out.push(newRow(kind, e, nowS, 'open'));
  }
  return out;
}
