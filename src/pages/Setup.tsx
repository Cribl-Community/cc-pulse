import { useRef, useState } from 'react';
import { Alert, Button, Drawer, EmptyState, IconButton, Menu, Modal, Table, Tag, Text, TextField, ToggleButtonGroup, type Key, type TagColor } from '@capra/core';
import { ChevronDown, EllipsisVertical, ReloadOutlined, SearchOutlined } from '@capra/icons';
import { Deploy } from './Deploy';
import { filterGroups } from '../lib/setupFilter';
import { FleetRunner } from '../components/FleetRunner';
import { useMountedLoad } from '../components/useMountedLoad';
import { SetupAlerts } from '../components/SetupAlerts';
import { SetupSourcesDrawer } from '../components/SetupSourcesDrawer';
import { Page, Section } from '../components/ui';
import { hostMode, hostOrigin } from '../lib/host';
import { api, kvGet, listGroups, listInputs, listPacks, listPackInputs, listPackRoutes, type Input, type PackInput } from '../lib/api';
import { PACK_ID, PACK_VERSION, type Deployment } from '../lib/deploy';
import { loadFleet, type FleetData } from '../lib/setupFleet';
import type { FleetGroup, FleetSource } from '../lib/demo';
import {
  buildRows, buildSummary, CPU_PER_EVS, defaultChoices, demoTargets, formatCpu, formatVolume, summaryLine, watchedSourceCount,
  type Choices,
} from '../lib/setupRows';
import { fleetPlan } from '../lib/fleetPlan';
import { confirmRows } from '../lib/fleetRun';
import { packInputKey, packReachInfo, streamPackForward, type PackRoute } from '../lib/packSources';
import { defaultSourceMode } from '../lib/routeFilter';
import { useChanged } from '../lib/changed';
import { cols, vis } from '../lib/table';
import { usePulse } from '../state';

type Reach = 'yes' | 'maybe' | 'no';
type Src = { key: string; label: string; tickable: boolean; pack?: string; reach?: Reach; routeId?: string; versionBlock?: boolean };
type GroupRow = { id: string; workerCount: number; pulse?: string; own: Src[]; packIds: string[]; prev: Deployment | null };
type Mode = 'all' | 'selected';
/** `rec` is the record signature the choice was seeded from, so a reload reseeds only the groups whose record changed. */
type Choice = { on: boolean; mode: Mode; picked: string[]; rec?: string };

const DASH = '\u2014';
const PACK_READ_ERR = 'Could not read pack sources';
const groupsReadErr = (e: unknown) => `Could not read the worker groups: ${String(e)}`;
const COLS = ['group', 'workers', 'pulse', 'sources', 'volume', 'cpu', 'does', 'actions'];
const REDEPLOY = 'Dataset and full re-deploy\u2026';
const NO_WORKERS = 'no workers — nothing to deploy to';
/** Only these two deploy lines are subtle text. Every other action, including "up to date", is a Tag. */
const SUBTLE_DEPLOY = new Set(['not in this deploy', NO_WORKERS]);

/** One table row, the same shape for demo (setupRows) and live groups. Every column holds a non-empty string. */
type View = {
  id: string; group: string; workers: string; pulse: string; tone: TagColor; sources: string; mode: Mode;
  volume: string; cpu: string; does: string; actions: string[]; isDisabled: boolean; selected: boolean;
};

const toneOf = (t: string): TagColor => (t === 'warning' || t === 'success' ? t : 'default');

function pulseLabel(v: string | undefined): { label: string; tone: TagColor } {
  if (!v) return { label: 'not installed', tone: 'default' };
  return v === PACK_VERSION ? { label: `Pulse ${v}`, tone: 'success' } : { label: `Pulse ${v} · update`, tone: 'warning' };
}

/** planText's short step names as the action Tags of the What-the-deploy-does column. */
function actionTags(text: string, installed: string | undefined): string[] {
  const parts = text.split(', ');
  if (!parts.every((p) => p === 'pack' || p === 'dest' || p === 'route')) return [text];
  return parts.map((p) => (p === 'pack' ? (installed ? `upgrade pack → ${PACK_VERSION}` : `install pack ${PACK_VERSION}`) : p === 'dest' ? 'destination' : 'route'));
}

function demoViews(fleet: FleetData, c: Choices, settings: Parameters<typeof buildRows>[2]): View[] {
  return buildRows(fleet, c, settings).map((r) => ({
    id: r.key, group: r.name, workers: String(r.workers), pulse: r.pulse.label, tone: toneOf(r.pulse.tone),
    sources: r.sources, mode: r.mode === 'all' ? 'all' : 'selected', volume: r.volume, cpu: r.cpu,
    does: r.actions.join(', '), actions: r.actions, isDisabled: !r.selectable, selected: r.selected,
  }));
}
const STAYS = "This source stays inside the pack. Pulse's route is on the worker group, so it only sees events the pack sends to the worker group routes.";
const OWNER = 'Add a route with targetContext group (Send to Worker Group Routes), which needs Stream 4.17+, or move the source out of the pack.';

/** One read for the page. Unknown (or a failed read) is not treated as an old Stream. */
let versionOnce: Promise<string | undefined> | null = null;
function loadVersionOnce(): Promise<string | undefined> {
  if (!versionOnce) {
    versionOnce = (async () => {
      try {
        const body = await api<{ version?: string; items?: { version?: string }[] }>('/system/info');
        const v = body?.version ?? body?.items?.[0]?.version;
        return typeof v === 'string' ? v : undefined;
      } catch { return undefined; }
    })();
  }
  return versionOnce;
}

/**
 * One group's pack sources. A thrown read stays thrown: an empty list would look like
 * "this pack has no sources" and filterPicked would drop the record's keys.
 * Cribl-pulse is not in packIds, so it is never read.
 */
async function readPackSources(g: GroupRow): Promise<Src[]> {
  const version = await loadVersionOnce();
  if (!g.packIds.length) return [];
  const lists = await Promise.all(g.packIds.map(async (pack) => {
    const [inputs, routes] = await Promise.all([
      listPackInputs(g.id, pack),
      listPackRoutes(g.id, pack),
    ]);
    return classifyPack(pack, inputs, routes as PackRoute[], version);
  }));
  return lists.flat();
}

/** Group plus the pack ids this read closed over, so a later pack set is a different read. */
function packCacheKey(g: GroupRow): string {
  return `${g.id}\0${[...g.packIds].sort().join('\0')}`;
}

function classifyPack(pack: string, inputs: PackInput[], routes: PackRoute[], version: string | undefined): Src[] {
  const forward = streamPackForward(version);
  return inputs.map((i) => {
    const key = packInputKey(i.type, pack, i.id);
    if (!forward) return { key, label: key, tickable: false, pack, reach: 'no', versionBlock: true };
    const info = packReachInfo(routes, key);
    if (info.reach === 'yes') return { key, label: key, tickable: true, pack, reach: 'yes' };
    if (info.reach === 'maybe') return { key, label: key, tickable: true, pack, reach: 'maybe', routeId: info.routeId };
    return { key, label: key, tickable: false, pack, reach: 'no' };
  });
}

function ownKey(g: GroupRow, key: string): boolean {
  return g.own.some((s) => s.key === key);
}

/** Source ids a demo group can take from Copy: unlocked own inputs, and pack sources that reach the group. */
function demoListed(g: FleetGroup): Set<string> {
  const allow = new Set<string>();
  for (const s of g.sources) if (!s.locked) allow.add(s.id);
  for (const s of g.packSources) {
    if (s.locked || s.staysInPack || s.reach === 'no') continue;
    allow.add(s.id);
  }
  return allow;
}

/** Drop a previous id only once this group's pack sources are known and the id is not tickable. */
function filterPicked(g: GroupRow, extra: Src[], picked: string[]): string[] {
  const allow = new Set<string>();
  for (const s of g.own) if (s.tickable) allow.add(s.key);
  for (const s of extra) if (s.tickable) allow.add(s.key);
  return picked.filter((k) => allow.has(k));
}

/** A group with a record starts from that record. Pack keys stay until that group's pack list is classified. */
function seed(g: GroupRow, fresh: Mode): Choice {
  if (!g.prev) return { on: false, mode: fresh, picked: [], rec: recSig(g) };
  const picked = g.packIds.length === 0 ? g.prev.inputs.filter((k) => ownKey(g, k)) : [...g.prev.inputs];
  return { on: false, mode: defaultSourceMode(g.prev), picked, rec: recSig(g) };
}

function recSig(g: GroupRow): string {
  return `${g.id}:${g.prev?.at ?? ''}:${(g.prev?.inputs ?? []).join(',')}`;
}

/**
 * Choices after the rows are (re)read. The first read seeds every group. A reload after a run keeps
 * a group's choice when its record is the same, and reseeds it from the new record when that group
 * was deployed, keeping it included so the rebuilt plan says what is left for it (up to date).
 */
function reseed(rows: GroupRow[], cur: Record<string, Choice> | null, fresh: Mode): Record<string, Choice> {
  const next: Record<string, Choice> = {};
  for (const g of rows) {
    const had = cur?.[g.id];
    if (had && had.rec === recSig(g)) { next[g.id] = had; continue; }
    const s = seed(g, fresh);
    next[g.id] = had ? { ...s, on: had.on && g.workerCount > 0 } : s;
  }
  return next;
}

/** Reads each group's packs, global inputs, and deployment record. Nothing is written. Pack sources wait until opened. */
function loadRows(): Promise<GroupRow[]> {
  return listGroups().then((gs) => Promise.all(gs.map(async (g) => {
    const [packs, inputs, prev] = await Promise.all([
      listPacks(g.id).catch(() => [] as { id: string; version?: string }[]),
      listInputs(g.id).catch(() => [] as Input[]),
      kvGet<Deployment | null>(`deployments/${g.id}`, null).catch(() => null),
    ]);
    return {
      id: g.id,
      workerCount: g.workerCount ?? 0,
      pulse: packs.find((p) => p.id === PACK_ID)?.version,
      own: inputs.map((i) => ({ key: `${i.type}:${i.id}`, label: `${i.type}:${i.id}`, tickable: true })),
      packIds: packs.map((p) => p.id).filter((id) => id !== PACK_ID),
      prev,
    };
  })));
}

/** ev/s for the watched keys, same match as Deploy: input equals the key, or starts with key + ':'. */
function evPerSec(fleet: { group: string; input: string; events_1h: number }[], group: string, keys: string[]) {
  let n = 0;
  for (const key of keys) {
    const hits = fleet.filter((e) => e.group === group && (e.input === key || e.input.startsWith(`${key}:`)));
    if (hits.length) n += Math.round(hits.reduce((t, e) => t + e.events_1h, 0) / 3600);
  }
  return n;
}

function planText(id: string, on: boolean, plan: ReturnType<typeof fleetPlan>) {
  if (!on) return 'not in this deploy';
  const bad = plan.invalid.find((x) => x.group === id);
  if (bad) return bad.reason;
  const lane = plan.lanes.find((l) => l.id === id);
  if (lane?.unchanged) return 'up to date';
  const ids = new Set((lane?.steps ?? []).map((s) => s.id.split('/')[1]));
  const bits = ['pack', 'dest', 'route'].filter((k) => ids.has(k));
  return bits.join(', ') || DASH;
}

function listed(g: GroupRow, extra: Record<string, Src[]>): Src[] {
  return [...g.own, ...(extra[g.id] ?? [])];
}

/**
 * A live group in the Drawer's shape (the demo FleetGroup): own inputs, then its classified pack
 * sources with their reach. A source that is not tickable (stays in its pack, or Stream is too old) is locked.
 */
function liveDrawerGroup(g: GroupRow, extra: Src[], fleet: { group: string; input: string; events_1h: number }[], c: Choice | undefined): FleetGroup {
  const one = (s: Src): FleetSource => ({
    id: s.key, type: s.key.split(':')[0], evs: evPerSec(fleet, g.id, [s.key]), picked: !!c?.picked.includes(s.key),
    ...(s.pack ? { pack: s.pack, reach: s.reach ?? 'yes' } : {}),
    ...(s.tickable ? {} : { locked: true }),
    ...(s.versionBlock ? { versionBlock: true } : {}),
    ...(s.routeId ? { routeId: s.routeId } : {}),
  });
  return {
    id: g.id, workers: g.workerCount, pulse: g.pulse, mode: c?.mode ?? 'selected', selected: !!c?.on,
    sources: g.own.map(one), packSources: extra.map(one),
  };
}

export function Setup() {
  const { settings, fleet, refresh } = usePulse();
  const [rows, setRows] = useState<GroupRow[] | null>(null);
  const [groupsErr, setGroupsErr] = useState('');
  const [err, setErr] = useState('');
  const [fresh, setFresh] = useState<Mode>('all');
  const [choices, setChoices] = useState<Record<string, Choice> | null>(null);
  const [q, setQ] = useState('');
  const [copyTo, setCopyTo] = useState<string[]>([]);
  const [dropped, setDropped] = useState<number | null>(null);
  const [packExtra, setPackExtra] = useState<Record<string, Src[]>>({});
  const [alertsOn, setAlertsOn] = useState(true);
  const [schedulesOn, setSchedulesOn] = useState(true);
  const [ask, setAsk] = useState(false);
  // Successful pack reads for this visit only. Leaving Settings unmounts Setup, so the next
  // visit reads again (a pack added later, or a source the first read missed). A rejected
  // read is removed, so the next include or open tries the same packs again.
  const packCache = useRef(new Map<string, Promise<Src[]>>());
  // Demo (plain npm run dev): the fixed fleet from loadFleet(), rows from setupRows. Nothing is written.
  const [demo] = useState(() => hostMode() === 'demo');
  const [demoFleet, setDemoFleet] = useState<FleetData | null>(null);
  const [searchInfo, setSearchInfo] = useState<FleetData['search'] | null>(null);
  const [demoChoices, setDemoChoices] = useState<Choices | null>(null);
  const [showPlan, setShowPlan] = useState(false);
  const [sortDir, setSortDir] = useState<'ascending' | 'descending'>('ascending');
  // Drawer "Sources on <group>" (demo and live): the group it is open on, and a counter so each open mounts fresh ticks.
  const [drawer, setDrawer] = useState<{ id: string; n: number } | null>(null);
  const [deployDrawer, setDeployDrawer] = useState<string | null>(null);
  // Start the reads once, after mount (useMountedLoad runs them in useEffect). A result that lands after
  // unmount is dropped: alive() is false then. Selection is derived during render (useChanged), not in an effect.
  const isMounted = useMountedLoad((alive) => {
    if (demo) {
      void loadFleet().then((f) => {
        if (!alive()) return;
        setDemoFleet(f); setDemoChoices(defaultChoices(f)); setSearchInfo(f.search);
      }).catch((e: unknown) => { if (alive()) setErr(String(e)); });
      return;
    }
    void loadRows().then((r) => { if (alive()) { setRows(r); setGroupsErr(''); } }).catch((e: unknown) => { if (alive()) setGroupsErr(groupsReadErr(e)); });
    void loadVersionOnce();
    // Live first paint goes through loadFleet() too (spec 039 §2), so the Search section shows its
    // `<n> saved searches · <m> lookups` line and the outdated tag on open, not only after Refresh.
    // A failure here only leaves that line hidden: the rows above report their own read error.
    // groups: false — loadRows() above already reads every group; only the Search status is needed here.
    void loadFleet({ groups: false }).then((f) => { if (alive()) setSearchInfo(f.search); }, () => undefined);
  });

  const sig = rows ? rows.map(recSig).join('|') : '';
  const sigChanged = useChanged(sig);
  const freshChanged = useChanged(fresh);
  if (rows && (choices === null || sigChanged || freshChanged)) {
    if (choices === null || sigChanged) setChoices(reseed(rows, choices, fresh));
    else {
      const next: Record<string, Choice> = {};
      for (const g of rows) next[g.id] = g.prev && choices[g.id] ? choices[g.id] : seed(g, fresh);
      setChoices(next);
    }
  }
  const choice = choices ?? {};
  const liveTargets = (rows ?? []).filter((g) => choice[g.id]?.on).map((g) => {
    const c = choice[g.id];
    return { group: g.id, mode: c.mode, inputs: c.mode === 'all' ? [] : c.picked, prev: g.prev, installed: g.pulse };
  });
  const targets = demo ? (demoFleet && demoChoices ? demoTargets(demoFleet, demoChoices) : []) : liveTargets;
  const plan = fleetPlan(targets, settings, {
    alerts: alertsOn,
    enabled: schedulesOn,
    link: { origin: hostOrigin(), base: window.CRIBL_BASE_PATH },
  });
  const blocked = plan.invalid.length > 0 || (!alertsOn && targets.length === 0);
  // Every ticked group is up to date and Search is not in this deploy: there is nothing to run.
  const upToDate = !blocked && plan.steps.length === 0;
  const shown = filterGroups(rows ?? [], q, (g) => g.id);

  function packList(g: GroupRow): Promise<Src[]> {
    const key = packCacheKey(g);
    const hit = packCache.current.get(key);
    if (hit) return hit;
    const slot: { current?: Promise<Src[]> } = {};
    const pending = readPackSources(g).then(
      (extra) => extra,
      (err: unknown) => {
        if (slot.current && packCache.current.get(key) === slot.current) packCache.current.delete(key);
        throw err;
      },
    );
    slot.current = pending;
    packCache.current.set(key, pending);
    return pending;
  }
  /** After a run with nothing left to Retry: read the records and Pulse versions again, so fleetPlan is rebuilt from them. */
  function reloadRows(): Promise<void> {
    return loadRows().then((r) => { if (isMounted()) { setRows(r); setGroupsErr(''); } }, (e: unknown) => { if (isMounted()) setGroupsErr(groupsReadErr(e)); throw e; });
  }
  function remember(id: string, extra: Src[]) {
    setPackExtra((p) => (p[id] ? p : { ...p, [id]: extra }));
  }
  function toggleOn(id: string) {
    const g = rows?.find((r) => r.id === id);
    if (!g?.workerCount || !choices?.[id]) return;
    const wantOn = !choices[id].on;
    const pickedNow = choices[id].picked;
    const recordUnknown = (g.prev?.inputs ?? []).some((k) => !ownKey(g, k));
    const pickedUnknown = pickedNow.some((k) => !ownKey(g, k));
    // Classify before the inputs go to fleetPlan when the record (or the ticks) hold keys that are not group sources.
    const mustLoad = wantOn && g.packIds.length > 0 && !packExtra[id] && (recordUnknown || pickedUnknown);
    const apply = (extra: Src[] | undefined) => {
      setChoices((cur) => {
        if (!cur?.[id]) return cur;
        const picked = wantOn && extra ? filterPicked(g, extra, cur[id].picked) : cur[id].picked;
        return { ...cur, [id]: { ...cur[id], on: wantOn, picked } };
      });
    };
    if (!mustLoad) { apply(packExtra[id]); return; }
    void packList(g).then((extra) => { setErr(''); remember(id, extra); apply(extra); }).catch(() => { setErr(PACK_READ_ERR); });
  }
  function setMode(id: string, mode: Mode) {
    setChoices((c) => c && { ...c, [id]: { ...c[id], mode } });
  }
  function keysFrom(g: GroupRow, extra: Src[], c: Choice): string[] {
    const allow = new Set(filterPicked(g, extra, listed(g, { [g.id]: extra }).map((s) => s.key)));
    if (c.mode === 'all') return [...allow];
    return c.picked.filter((k) => allow.has(k));
  }
  /** Copy the drawer's current ticks onto the checked groups. Ids the target does not list are dropped. */
  function copySources(fromIds?: string[]) {
    // Demo has no live rows: the same drop-and-pick rules write demoChoices, which is what the table reads.
    if (demo) {
      if (!demoFleet || !drawer) return;
      const src = demoFleet.groups.find((g) => g.id === drawer.id);
      if (!src) return;
      const keys = fromIds ?? drawerPicked();
      const targets = copyTo.map((id) => demoFleet.groups.find((g) => g.id === id)).filter((g): g is FleetGroup => !!g);
      let n = 0;
      const patch: Record<string, string[]> = {};
      for (const g of targets) {
        const allow = demoListed(g);
        const keep = keys.filter((k) => allow.has(k));
        n += keys.length - keep.length;
        patch[g.id] = keep;
      }
      setDemoChoices((c) => {
        if (!c) return c;
        const modes = { ...c.modes };
        const picks = { ...c.picks };
        for (const id of Object.keys(patch)) {
          modes[id] = 'pick';
          picks[id] = patch[id];
        }
        return { ...c, modes, picks };
      });
      setDropped(n);
      return;
    }
    const src = drawer ? rows?.find((g) => g.id === drawer.id) ?? null : null;
    if (!src || !choices?.[src.id] || !rows) return;
    const targets = copyTo.map((id) => rows.find((g) => g.id === id)).filter((g): g is GroupRow => !!g);
    const srcChoice = choices[src.id];
    const srcKnown = packExtra[src.id] ?? (src.packIds.length === 0 ? [] : undefined);
    const preview = fromIds ?? (srcKnown ? keysFrom(src, srcKnown, srcChoice) : srcChoice.picked);
    const needs = (fromIds ? false : srcKnown === undefined) || targets.some((g) => g.packIds.length > 0 && !packExtra[g.id] && preview.some((k) => !ownKey(g, k)));
    const allowOf = (g: GroupRow, extra: Src[]) => new Set(filterPicked(g, extra, [...g.own.map((s) => s.key), ...extra.map((s) => s.key)]));
    const apply = (keys: string[], extras: Record<string, Src[]>) => {
      let n = 0;
      const patch: Record<string, string[]> = {};
      for (const g of targets) {
        const keep = keys.filter((k) => allowOf(g, extras[g.id] ?? []).has(k));
        n += keys.length - keep.length;
        patch[g.id] = keep;
      }
      setChoices((cur) => {
        if (!cur) return cur;
        const next = { ...cur };
        for (const id of Object.keys(patch)) next[id] = { ...cur[id], mode: 'selected', picked: patch[id] };
        return next;
      });
      setDropped(n);
    };
    if (!needs && (srcKnown || fromIds)) { apply(preview, packExtra); return; }
    void (async () => {
      try {
        const srcExtra = srcKnown ?? await packList(src);
        remember(src.id, srcExtra);
        const keys = fromIds ?? keysFrom(src, srcExtra, srcChoice);
        const extras: Record<string, Src[]> = { ...packExtra, [src.id]: srcExtra };
        for (const g of targets) {
          if (extras[g.id]) continue;
          extras[g.id] = g.packIds.length > 0 && keys.some((k) => !ownKey(g, k)) ? await packList(g) : [];
          if (extras[g.id].length || g.packIds.length) remember(g.id, extras[g.id]);
        }
        setErr('');
        apply(keys, extras);
      } catch { setErr(PACK_READ_ERR); }
    })();
  }

  const liveViews: View[] = shown.map((g) => {
    const c = choice[g.id] ?? { on: false, mode: 'selected' as Mode, picked: [] as string[] };
    const all = listed(g, packExtra);
    const keys = c.mode === 'all' ? all.filter((s) => s.tickable).map((s) => s.key) : c.picked;
    const ev = evPerSec(fleet, g.id, keys);
    const p = pulseLabel(g.pulse);
    const none = !g.workerCount;
    const does = none ? NO_WORKERS : planText(g.id, c.on, plan);
    return {
      id: g.id, group: g.id, workers: String(g.workerCount), pulse: p.label, tone: p.tone,
      sources: none ? DASH : c.mode === 'all' ? `All sources (${all.length})` : `${c.picked.length} of ${all.length}`, mode: c.mode,
      volume: none ? DASH : formatVolume(ev), cpu: none ? DASH : formatCpu(ev * CPU_PER_EVS),
      does, actions: none ? [NO_WORKERS] : actionTags(does, g.pulse), isDisabled: none, selected: !none && !!c.on,
    };
  });
  const demoShown = demo && demoFleet && demoChoices
    ? filterGroups(demoViews(demoFleet, { ...demoChoices, newDefault: fresh === 'all' ? 'all' : 'pick' }, settings), q, (v) => v.id)
    : [];
  const items = (demo ? demoShown : liveViews)
    .sort((a, b) => (sortDir === 'ascending' ? 1 : -1) * a.id.localeCompare(b.id));
  const groupCount = demo ? demoFleet?.groups.length ?? 0 : rows?.length ?? 0;
  const loading = demo ? demoFleet === null && !err : rows === null && !groupsErr;
  const emptyLive = !demo && !groupsErr && rows !== null && rows.length === 0;

  /** The Table's selection is Include: a row ticked or cleared toggles that group in or out of the deploy. */
  function onSelect(keys: 'all' | Set<Key>) {
    const want = new Set(items.filter((v) => !v.isDisabled && (keys === 'all' || keys.has(v.id))).map((v) => v.id));
    if (demo) {
      setDemoChoices((c) => c && { ...c, selected: [...c.selected.filter((id) => !items.some((v) => v.id === id)), ...want] });
      return;
    }
    for (const v of items) if (!v.isDisabled && v.selected !== want.has(v.id)) toggleOn(v.id);
  }
  /** Demo and live alike: Pick opens the Drawer and only its Apply sets the group to Pick, so Cancel leaves the row as it was. */
  function onMode(id: string, mode: Mode) {
    if (mode === 'selected') { openDrawer(id); return; }
    if (demo) { setDemoChoices((c) => c && { ...c, modes: { ...c.modes, [id]: 'all' } }); return; }
    setMode(id, 'all');
  }
  /** Live reads (and classifies) the group's pack sources first, so the Drawer mounts with every source and its reach. */
  function openDrawer(id: string) {
    if (drawer?.id !== id) { setCopyTo([]); setDropped(null); }
    const next = () => setDrawer((d) => ({ id, n: (d?.n ?? 0) + 1 }));
    if (demo) { next(); return; }
    const g = rows?.find((r) => r.id === id);
    if (!g) return;
    void packList(g).then((extra) => {
      if (!isMounted()) return;
      setErr('');
      remember(g.id, extra);
      next();
    }).catch(() => { if (isMounted()) setErr(PACK_READ_ERR); });
  }
  const liveDrawerRow = !demo && drawer ? rows?.find((g) => g.id === drawer.id) ?? null : null;
  const drawerGroup: FleetGroup | null = !drawer ? null
    : demo ? demoFleet?.groups.find((g) => g.id === drawer.id) ?? null
      : liveDrawerRow ? liveDrawerGroup(liveDrawerRow, packExtra[liveDrawerRow.id] ?? [], fleet, choice[liveDrawerRow.id]) : null;
  function drawerPicked(): string[] {
    if (!drawerGroup) return [];
    const every = [...drawerGroup.sources, ...drawerGroup.packSources];
    if (!demo) {
      const c = choice[drawerGroup.id];
      return c?.mode === 'all' ? every.filter((s) => !s.locked).map((s) => s.id) : c?.picked ?? [];
    }
    if (!demoChoices) return [];
    const mode = demoChoices.modes[drawerGroup.id] ?? (drawerGroup.mode === 'all' ? 'all' : 'pick');
    if (mode === 'all') return every.map((s) => s.id);
    return demoChoices.picks[drawerGroup.id] ?? every.filter((s) => s.picked).map((s) => s.id);
  }
  function applyDrawer(ids: string[]) {
    if (!drawer) return;
    const id = drawer.id;
    if (demo) setDemoChoices((c) => c && { ...c, modes: { ...c.modes, [id]: 'pick' }, picks: { ...c.picks, [id]: ids } });
    else if (liveDrawerRow) {
      const picked = filterPicked(liveDrawerRow, packExtra[id] ?? [], ids);
      setChoices((c) => (c?.[id] ? { ...c, [id]: { ...c[id], mode: 'selected', picked } } : c));
    }
    setDrawer(null);
  }

  /**
   * Refresh: loadFleet() again (demo fleet, or the live Search status); live rows are read again by loadRows().
   * Live asks loadFleet() for no groups, so each group is read once per click (packs, inputs, record) and
   * pack inputs wait until a group's sources are opened (031) — the proxy allows 100 requests/minute.
   */
  function reloadAll() {
    setErr('');
    setGroupsErr('');
    packCache.current.clear();
    setPackExtra({});
    void loadFleet({ groups: demo }).then((f) => {
      if (!isMounted()) return;
      if (demo) setDemoFleet(f);
      setSearchInfo(f.search);
    }).catch((e: unknown) => { if (isMounted()) setErr(String(e)); });
    if (!demo) void loadRows().then((r) => { if (isMounted()) { setRows(r); setGroupsErr(''); } }).catch((e: unknown) => { if (isMounted()) setGroupsErr(groupsReadErr(e)); });
  }

  const modalRows = confirmRows(plan.lanes, targets, settings.destination);
  // Summary bar: demo reads the pure setupRows summary; live counts the ticked groups the same way.
  const liveSummary = (() => {
    if (!rows) return '';
    const ticked = rows.filter((g) => g.workerCount > 0 && choice[g.id]?.on);
    let sources = 0;
    let cpu = 0;
    for (const g of ticked) {
      const c = choice[g.id] ?? { on: false, mode: 'selected' as Mode, picked: [] as string[] };
      const classified = packExtra[g.id];
      const tickablePack = g.packIds.length === 0 ? 0 : classified === undefined ? null : classified.filter((s) => s.tickable).length;
      sources += watchedSourceCount({
        mode: c.mode === 'all' ? 'all' : 'pick',
        pickCount: c.picked.length,
        ownInputs: g.own.filter((s) => s.tickable).length,
        tickablePack,
      });
      const keys = c.mode === 'all' ? listed(g, packExtra).filter((s) => s.tickable).map((s) => s.key) : c.picked;
      cpu += evPerSec(fleet, g.id, keys) * CPU_PER_EVS;
    }
    return summaryLine({ groups: ticked.length, sources, alerts: alertsOn, cpu });
  })();
  const summaryText = demo
    ? (demoFleet && demoChoices ? buildSummary(demoFleet, { ...demoChoices, search: alertsOn }, settings).text : '')
    : liveSummary;
  const planLanes = plan.lanes.filter((l) => l.steps.length > 0);
  return (
    <Page crumbs={[{ label: 'Setup' }]} sub="One plan for the whole fleet">
      <FleetRunner demo={demo} lanes={plan.lanes} steps={plan.steps} rows={modalRows} open={ask}
        onClose={() => setAsk(false)} onDone={() => { void refresh(); }} onSettle={reloadRows}>
        {(views, { busy }) => {
          const phase = (id: string) => {
            const p = views.find((v) => v.id === id)?.phase;
            return p === 'done' || p === 'running' || p === 'failed' || p === 'skipped' ? p : '';
          };
          const live = items.map((it) => { const ph = phase(it.id); return ph ? { ...it, does: ph, actions: [ph] } : it; });
          const selectedKeys = new Set<Key>(live.filter((v) => v.selected).map((v) => v.id));
          return (
      <>
      <div className="span-12 setup-title-row">
        <Text as="h2" variant="heading-sm">Set up Pulse</Text>
        <Button variant="secondary" leadingIcon={ReloadOutlined} onClick={reloadAll}>Refresh</Button>
      </div>
      <Section span={12} title={<span className="setup-groups-title">Worker groups<Text variant="body-sm-normal" color="subtle">{`tick every group Pulse should watch \u00b7 ${groupCount} groups`}</Text></span>}
        action={<div className="setup-groups-toolbar">
          <div className="setup-groups-filter">
            <TextField aria-label="Filter groups" leadingSlot={<SearchOutlined />} placeholder="Filter groups" value={q} onChange={setQ} />
          </div>
          <div className="setup-new-groups">
            <Menu trigger={<Button variant="secondary" trailingIcon={ChevronDown}>{fresh === 'all' ? 'New groups: All' : 'New groups: Pick'}</Button>}>
              <Menu.Item as="button" label="All" onPress={() => setFresh('all')} />
              <Menu.Item as="button" label="Pick" onPress={() => setFresh('selected')} />
            </Menu>
          </div>
        </div>}>
        {err && <div className="err">{err}</div>}
        {groupsErr
          ? <Alert appearance="danger" action={{ label: 'Retry', onClick: reloadAll }}>{groupsErr}</Alert>
          : emptyLive
          ? <EmptyState title="No worker group yet" description="Pulse lists the worker groups of this Cribl Stream leader here. Add a worker group in Stream, then come back." />
          : <Table density="compact" appearance="flat" aria-label="Worker groups" items={live} visibleColumns={vis(COLS)} isLoading={loading}
            selectionMode="multiple" selectedKeys={selectedKeys} onSelectionChange={onSelect}
            // Selection is Include: Escape (e.g. closing the Drawer, focus back in the Table) must not drop every group
            // from the deploy. Capra spreads it to the react-aria Table but does not type it.
            {...{ escapeKeyBehavior: 'none' as const }}
            sortDescriptor={{ column: 'group', direction: sortDir }} onSortChange={(d) => setSortDir(d.direction === 'descending' ? 'descending' : 'ascending')}
            columns={cols([
          { id: 'group', label: 'Group', allowsSorting: true, render: (_v: string, r: View) => (
            <Text variant="body-sm-semibold">{r.id}</Text>) },
          { id: 'workers', label: 'Workers' },
          { id: 'pulse', label: 'Pulse now', render: (_v: string, r: View) => (
            r.pulse === 'not installed' ? <Text>{r.pulse}</Text> : <Tag color={r.tone}>{r.pulse}</Tag>) },
          { id: 'sources', label: 'Sources to watch', render: (_v: string, r: View) => (r.isDisabled ? <Text color="subtle">{DASH}</Text> : (
            <div className="setup-sources-cell">
              {/* A click on the Pick already selected comes through as an empty set: it opens the Drawer too (demo and live). */}
              <ToggleButtonGroup size="sm" aria-label={`Sources to watch on ${r.id}`} disallowEmptySelection={false} selectedKeys={[r.mode]}
                onSelectionChange={(keys) => {
                  const k = [...keys][0];
                  if (k === 'all' || k === 'selected') onMode(r.id, k);
                  else if (r.mode === 'selected') openDrawer(r.id);
                }}
                items={[{ key: 'all', text: 'All' }, { key: 'selected', text: 'Pick' }]} />
              {r.mode === 'selected'
                ? <Button size="sm" variant="tertiary" onClick={() => openDrawer(r.id)}>{r.sources}</Button>
                : <Text variant="body-sm-normal" color="subtle">{r.sources}</Text>}
            </div>)) },
          { id: 'volume', label: 'Volume' },
          { id: 'cpu', label: 'Worker CPU' },
          { id: 'does', label: 'What the deploy does', render: (_v: string, r: View) => (
            <div className="setup-deploy-tags">{r.actions.map((a) => (SUBTLE_DEPLOY.has(a)
              ? <Text key={a} variant="body-sm-normal" color="subtle">{a}</Text>
              : <Tag key={a}>{a}</Tag>))}</div>) },
          { id: 'actions', label: '', render: (_v: string, r: View) => (
            <Menu trigger={<IconButton icon={EllipsisVertical} aria-label={`More actions for ${r.id}`} variant="tertiary" size="sm" disabled={r.isDisabled} />}>
              <Menu.Item as="button" label={REDEPLOY} disabled={r.isDisabled} onPress={() => setDeployDrawer(r.id)} />
            </Menu>) },
        ])} />}
      </Section>
      {deployDrawer && <Drawer isOpen title={`${deployDrawer} \u00b7 dataset and re-deploy`} onClose={() => setDeployDrawer(null)} width={720}>
        <Deploy key={deployDrawer} group={deployDrawer} embedded />
      </Drawer>}
      {drawerGroup && drawer && <SetupSourcesDrawer key={`${drawer.id}#${drawer.n}`} group={drawerGroup} picked={drawerPicked()}
        stays={STAYS} owner={OWNER}
        copyTargets={(demo ? demoFleet?.groups ?? [] : rows ?? []).map((g) => g.id).filter((id) => id !== drawerGroup.id)}
        copyTo={copyTo} onToggleCopy={(id) => setCopyTo((t) => (t.includes(id) ? t.filter((x) => x !== id) : [...t, id]))}
        onCopy={copySources} dropped={dropped}
        onApply={applyDrawer} onCancel={() => setDrawer(null)} />}
      <div className="span-12 stack">
        <SetupAlerts settings={settings} alertsOn={alertsOn} onAlertsOn={setAlertsOn} enabled={schedulesOn} onEnabled={setSchedulesOn} phase={phase('search')} info={searchInfo} />
        <div className="setup-summary-bar">
          <div className="setup-summary-row">
            <span className="nowrap">{summaryText}</span>
            <span className="sp" />
            <div className="row">
              <Button variant="secondary" onClick={() => setShowPlan(true)}>{`Show the plan (${plan.steps.length} steps)`}</Button>
              <Button variant="primary" disabled={blocked || upToDate || busy} onClick={() => setAsk(true)}>Deploy everything</Button>
            </div>
          </div>
          <span className="ellip muted">{upToDate ? 'Everything is up to date' : plan.invalid.map((b) => `${b.group}: ${b.reason}`).join('; ')}</span>
        </div>
        <Modal isOpen={showPlan} title="The plan" size="lg" confirmButtonText="Close" cancelButtonText={null}
          onConfirm={() => setShowPlan(false)} onClose={() => setShowPlan(false)}>
          {planLanes.map((l) => (
            <div key={l.id} className="stack-sm">
              <h3>{l.title}</h3>
              <ol>{l.steps.map((s) => <li key={s.id}>{s.title}</li>)}</ol>
            </div>
          ))}
        </Modal>
      </div>
      </>
          );
        }}
      </FleetRunner>
    </Page>
  );
}
