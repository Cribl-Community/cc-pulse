// Spec 030 §1: incident ledger lifecycle (src/lib/ledger.ts), table-driven.
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-ledger-'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/ledger.ts'), '--bundle', '--format=esm', '--platform=neutral', `--outfile=${join(tmp, 'l.mjs')}`, '--log-level=error'], { stdio: 'pipe' });
const { step, seed } = await import(join(tmp, 'l.mjs'));

let fail = 0;
const t = (msg, fn) => { let r; try { r = fn(); } catch (e) { r = `threw ${e.message}`; } if (r !== true) { fail++; console.log(`FAIL ${msg}`, r === false ? '' : r); } };

const t0 = 1_800_000_000;
const A = { remindH: 0, kind: 'asset' };
const e = { worker_group: 'g', input: 'i', asset: 'a', state: 'missing', raw_state: 'missing', eligible: true, last_seen: t0 - 900, criticality: '1', team: 'net' };
const okE = { ...e, state: 'ok', raw_state: 'ok', last_seen: t0 + 250 };
const id = `pulse:asset:g:i:a:${t0}`;

const s1 = step([], [e], t0, A);
t('opened', () => s1.events.length === 1 && s1.events[0].event === 'opened' && s1.events[0].incident_id === id && s1.events[0].opened_at === t0);
const s2 = step(s1.ledger, [e], t0 + 300, A);
t('same entity → open, no event', () => s2.events.length === 0 && s2.ledger.length === 1 && s2.ledger[0].event === 'open' && s2.ledger[0].incident_id === id);
const sk = step([], [e], t0 + 900, A);
t('skipped run still opens', () => sk.events.length === 1 && sk.events[0].event === 'opened' && sk.events[0].incident_id.endsWith(`:${t0 + 900}`));
const s3 = step(s2.ledger, [okE], t0 + 600, A);
t('resolved same id', () => s3.events.length === 1 && s3.events[0].event === 'resolved' && s3.events[0].incident_id === id);
const s4 = step(s3.ledger, [okE], t0 + 900, A);
t('dropped after resolved', () => s4.events.length === 0 && s4.ledger.length === 0);

const muted = { ...e, state: 'muted', eligible: false };
const m1 = step(s1.ledger, [muted], t0 + 7200, { remindH: 1, kind: 'asset' });
t('muted after opening: no reminder', () => m1.events.length === 0 && m1.ledger[0].event === 'open');
const m2 = step(m1.ledger, [okE], t0 + 7500, A);
t('muted then data back → resolved', () => m2.events.length === 1 && m2.events[0].event === 'resolved');
const mb = step([], [muted], t0, A);
t('muted before → never opens', () => mb.events.length === 0 && mb.ledger.length === 0);

const coll = { ...e, eligible: false };
t('collective silence: no asset opened', () => step([], [coll], t0, A).events.length === 0);
const src = step([], [{ ...e, asset: '' }], t0, { remindH: 0, kind: 'source' });
t('source_down opens one', () => src.events.length === 1 && src.events[0].incident_id === `pulse:source:g:i::${t0}`);

const r1 = step(s1.ledger, [e], t0 + 4 * 3600, { remindH: 4, kind: 'asset' });
t('reminder at 4 h', () => r1.events.length === 1 && r1.events[0].event === 'reminder' && r1.ledger[0].notified_at === t0 + 4 * 3600);
const r2 = step(r1.ledger, [e], t0 + 4 * 3600 + 300, { remindH: 4, kind: 'asset' });
t('no second reminder', () => r2.events.length === 0);
t('no reminder before 4 h', () => step(s1.ledger, [e], t0 + 3 * 3600, { remindH: 4, kind: 'asset' }).events.length === 0);

const ex = step(s1.ledger, [], t0 + 300, A);
t('expired', () => ex.events.length === 1 && ex.events[0].event === 'expired' && ex.events[0].incident_id === id);
t('expired dropped next run', () => step(ex.ledger, [], t0 + 600, A).ledger.length === 0);

const sd = seed([e, okE, coll], t0);
t('seed writes open rows', () => sd.length === 1 && sd[0].event === 'open');
const sn = step(sd, [e], t0 + 300, A);
t('seeded: no opened for already-missing', () => sn.events.length === 0 && sn.ledger.length === 1);

// Delivery confirmation (§1 step 5)
const D = (list) => ({ ...A, delivered: list });
const u1 = step(s1.ledger, [e], t0 + 300, D([]));
t('undelivered opened → opened again, same id', () => u1.events.length === 1 && u1.events[0].event === 'opened' && u1.events[0].incident_id === id && u1.events[0].opened_at === t0 && u1.events[0].notified_at === t0);
const u2 = step(u1.ledger, [e], t0 + 600, D([`${id}|opened`]));
t('delivered opened → open', () => u2.events.length === 0 && u2.ledger.length === 1 && u2.ledger[0].event === 'open');
const u3 = step(s1.ledger, [okE], t0 + 300, D([]));
t('undelivered opened + back → dropped silently', () => u3.events.length === 0 && u3.ledger.length === 0);
const u3b = step(s1.ledger, [], t0 + 300, D([]));
t('undelivered opened + absent → dropped silently', () => u3b.events.length === 0 && u3b.ledger.length === 0);
const u4 = step(s3.ledger, [okE], t0 + 900, D([]));
t('undelivered resolved → resolved again', () => u4.events.length === 1 && u4.events[0].event === 'resolved' && u4.events[0].incident_id === id);
t('delivered resolved → dropped', () => { const r = step(s3.ledger, [okE], t0 + 900, D([`${id}|resolved`])); return r.events.length === 0 && r.ledger.length === 0; });
const ux = step(ex.ledger, [], t0 + 600, D([]));
t('undelivered expired → expired again', () => ux.events.length === 1 && ux.events[0].event === 'expired');
const R = { remindH: 4, kind: 'asset' };
const ur = step(r1.ledger, [e], t0 + 4 * 3600 + 300, { ...R, delivered: [] });
t('undelivered reminder + missing → reminder again, notified_at unchanged', () => ur.events.length === 1 && ur.events[0].event === 'reminder' && ur.events[0].notified_at === t0 + 4 * 3600);
const ur2 = step(r1.ledger, [okE], t0 + 4 * 3600 + 300, { ...R, delivered: [] });
t('undelivered reminder + back → resolved', () => ur2.events.length === 1 && ur2.events[0].event === 'resolved' && ur2.events[0].incident_id === id);
const ur3 = step(r1.ledger, [], t0 + 4 * 3600 + 300, { ...R, delivered: [] });
t('undelivered reminder + absent → expired', () => ur3.events.length === 1 && ur3.events[0].event === 'expired');
const dr = step(r1.ledger, [e], t0 + 4 * 3600 + 300, { ...R, delivered: [`${id}|reminder`] });
t('delivered reminder → open', () => dr.events.length === 0 && dr.ledger[0].event === 'open');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('ledger tests passed');
