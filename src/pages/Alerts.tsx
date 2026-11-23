import { useEffect, useMemo, useState } from 'react';
import { Link as RouterLink, Link } from 'react-router-dom';
import { CaretDown, CaretUp, DeleteOutlined, EditOutlined } from '@capra/icons';
import { MAX_ROUTES, moveRoute, previewCount, whenSentence, type AlertRow, type Route, type RouteKind } from '../lib/routes';
import { critOf } from '../lib/inventory';
import { Alert, Button, Checkbox, Drawer, IconButton, Link as CapraLink, RadioGroup, RadioTile, SelectField, NumberField, Switch, Table, Tag, Text, TextField } from '@capra/core';
import { installedLoad, normalizeLoad, type SearchLoad } from '../lib/cadence';
import { channelRows } from '../lib/channels';
import { AddChannelModal } from '../components/AddChannelModal';
// Each channel row has a Send test action (SendTest) next to Open in Cribl.
import { SendTest } from '../components/SendTest';
import { Page, Section } from '../components/ui';
import { listTargets, savedStatus, type SavedStatus } from '../lib/deploy';
import { hostMode } from '../lib/host';
import { costLine, pulseCpuHours } from '../lib/searchCost';
import { listSearchJobs } from '../lib/searchJobs';
import { fmtDur } from '../lib/model';
import { defaultEvents, normalizeRemindH, saveSettings } from '../lib/settings';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';

const LOAD_NAME: Record<SearchLoad, string> = { standard: 'Standard', hourly: 'Hourly', daily: 'Economy' };
const LOAD_TILES: { id: SearchLoad; title: string; description: string; tag?: string }[] = [
  { id: 'standard', title: 'Standard · every 5 minutes', description: 'Alerts 5–10 min after an asset goes silent · 1,176 searches a day', tag: 'Default' },
  { id: 'hourly', title: 'Hourly', description: 'The same alerts, within about an hour · 97 searches a day · about 1/10 of Standard' },
  { id: 'daily', title: 'Economy · once a day', description: 'One roll call each morning: who is reporting, who is missing. No incident alerts · 1 search a day', tag: 'Pay-as-you-go Search' },
];
const HOUR_ITEMS = Array.from({ length: 24 }, (_, h) => ({ id: String(h), label: `${String(h).padStart(2, '0')}:00` }));
const ANY = '_any';
const KIND_ITEMS = [{ id: 'missing', label: 'Missing asset' }, { id: 'source_down', label: 'Source down' }, { id: 'digest', label: 'Digest' }];
const SEV_ITEMS = ['critical', 'error', 'warning', 'info'].map((s) => ({ id: s, label: s }));
const CRIT_MAX_ITEMS = [{ id: ANY, label: 'Any criticality' }, ...([1, 2, 3, 4] as const).map((c) => ({ id: String(c), label: c === 1 ? 'P1 only' : `P1–P${c}` }))];

function RouteDrawer({ route, routes, channels, onClose, onSave }: { route: Route; routes: Route[]; channels: { id: string; type: string }[]; onClose: () => void; onSave: (r: Route) => void }) {
  const { inventory, fleet, incidents, settings } = usePulse();
  const [f, setF] = useState<Route>(route);
  const [opened] = useState(() => Date.now() / 1000);
  const w = f.when;
  const setW = (p: Partial<Route['when']>) => setF((x) => ({ ...x, when: { ...x.when, ...p } }));
  const teams = [...new Set(Object.values(inventory).map((i) => i.team).filter(Boolean))].sort() as string[];
  const inputs = [...new Set(fleet.map((e) => e.input))].sort();
  const hasPd = f.targets.some((t) => channels.find((c) => c.id === t)?.type === 'pager_duty');
  // Incident history (spec 009) overlapping the last 24 h, one alert per silent asset.
  const rows = useMemo<AlertRow[]>(() => {
    return incidents.filter((i) => (i.end ?? Infinity) >= opened - 86400).flatMap((i) => i.entities.map((e) => ({ kind: 'missing' as const, criticality: critOf(inventory[e.asset]), team: inventory[e.asset]?.team, input: e.input })));
  }, [incidents, inventory, opened]);
  // Final routes above this one take their alerts first (a new route goes last, below every route).
  const at = routes.findIndex((r) => r.id === route.id);
  const above = (at < 0 ? routes : routes.slice(0, at)).filter((r) => r.final).map((r) => r.when);
  const { x, y } = previewCount(w, rows, above, defaultEvents(settings));
  // A route's email goes to the recipients set under Notify: offer it only once there are some.
  const offered = channels.filter((c) => c.id !== 'system_email' || settings.notify.email.trim());
  const full = !route.id && routes.length >= MAX_ROUTES;
  const free = ['r1', 'r2', 'r3', 'r4', 'r5'].find((id) => !routes.some((r) => r.id === id));
  const save = () => {
    if (full || !free && !route.id || !f.name.trim()) return;
    const { severity, ...rest } = f;
    // The Severity field shows 'error' until changed: save what it shows.
    onSave({ ...rest, id: route.id || free!, name: f.name.trim(), ...(hasPd ? { severity: severity ?? 'error' } : {}) });
  };
  return (
    <Drawer isOpen onClose={onClose} title={route.id ? `Edit route ${route.id}` : 'Add route'} width={480}
      footer={<div className="row"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={full || !f.name.trim() || !f.targets.length} onClick={save}>Save</Button></div>}>
      <div className="stack">
        {full && <Alert appearance="warning" title="Route limit">At most {MAX_ROUTES} routes.</Alert>}
        <TextField label="Name" value={f.name} onChange={(v) => setF({ ...f, name: v })} />
        <SelectField label="Alert kinds" selectionMode="multiple" placeholder="All kinds" items={KIND_ITEMS} value={w.kinds ?? []} onChange={(v) => setW({ kinds: [...v] as RouteKind[] })} />
        <SelectField label="Max criticality" items={CRIT_MAX_ITEMS} value={w.maxCriticality ? String(w.maxCriticality) : ANY} onChange={(k) => setW({ maxCriticality: !k || k === ANY ? undefined : (Number(k) as 1 | 2 | 3 | 4) })} />
        <SelectField label="Team" items={[{ id: ANY, label: 'Any team' }, ...teams.map((t) => ({ id: t, label: t }))]} value={w.team || ANY} onChange={(k) => setW({ team: !k || k === ANY ? undefined : String(k) })} />
        <SelectField label="Source" items={[{ id: ANY, label: 'Any source' }, ...inputs.map((t) => ({ id: t, label: t }))]} value={w.input || ANY} onChange={(k) => setW({ input: !k || k === ANY ? undefined : String(k) })} />
        <SelectField label="Send to" selectionMode="multiple" placeholder="Choose channels" items={offered.map((c) => ({ id: c.id, label: c.id }))} value={f.targets} onChange={(v) => setF({ ...f, targets: [...v].map(String) })} />
        {hasPd && <SelectField label="Severity" items={SEV_ITEMS} value={f.severity ?? 'error'} onChange={(k) => k && setF({ ...f, severity: String(k) as Route['severity'] })} />}
        <div className="row"><Switch aria-label="Final" checked={f.final} onChange={(e) => setF({ ...f, final: e.target.checked })} /><Text>Final: stop at this route (skip later routes and the default targets)</Text></div>
        <Text>In the last 24 h, this route would have received {x} of {y} alerts</Text>
      </div>
    </Drawer>);
}

export function Alerts() {
  const { settings, setSettings } = usePulse();
  const [status, setStatus] = useState<SavedStatus[]>([]);
  const [targets, setTargets] = useState<{ id: string; type: string }[]>([]); // full target objects from Cribl, fed to channelRows
  const [addOpen, setAddOpen] = useState(false);
  const [err, setErr] = useState<string>();
  const load = () => { setErr(undefined); return savedStatus(settings).then(setStatus).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e))); };
  useEffect(() => { void load(); listTargets().then(setTargets).catch(() => undefined); }, []); // eslint-disable-line
  const upd = (patch: Partial<typeof settings>) => { const s = { ...settings, ...patch }; setSettings(s); void saveSettings(s); };
  const outdated = status.filter((r) => r.extra && r.exists).length;
  const tgl = (id: string) => upd({ notify: { ...settings.notify, targets: settings.notify.targets.includes(id) ? settings.notify.targets.filter((t) => t !== id) : [...settings.notify.targets, id] } });
  const oldLoad = installedLoad(status);
  const [cost, setCost] = useState<string | null>(null);
  useEffect(() => {
    if (hostMode() === 'demo') return;
    let live = true;
    listSearchJobs().then((jobs) => { if (live) setCost(costLine(pulseCpuHours(jobs, Date.now(), settings.dataset))); }).catch(() => { if (live) setCost(null); });
    return () => { live = false; };
  }, [settings.dataset]);
  const L = settings.learning;
  const isOn = (id: string) => id === 'system_email' ? !!settings.notify.email.trim() : settings.notify.targets.includes(id);
  const chRows = useMemo(() => channelRows(targets).map((r) => ({ ...r, sentErr: `${r.sent ?? 0} / ${r.errors ?? 0}`, use: '', actions: '' })), [targets]);
  const chIds = ['id', 'kind', 'where', 'tone', 'sentErr', 'use', 'actions'];
  const onlySystem = targets.length > 0 && targets.every((t) => t.id === 'system_notifications' || t.id === 'system_email');

  const routes = settings.notify.routes;
  const setRoutes = (next: Route[]) => upd({ notify: { ...settings.notify, routes: next } });
  const [editing, setEditing] = useState<string>(); // placeholder until the route Drawer (F9)
  const rtIds = ['n', 'name', 'when', 'targets', 'severity', 'final', 'actions'];
  const elseTargets = [...settings.notify.targets, ...(settings.notify.email.trim() ? ['system_email'] : [])];
  const rtRows = [
    ...routes.map((r, i) => ({ id: r.id, i, fixed: false, n: String(i + 1), name: r.name, when: whenSentence(r.when), targets: r.targets.join(', '), targetList: r.targets, severity: r.severity ?? '—', final: r.final, actions: '' })),
    { id: '_else', i: routes.length, fixed: true, n: '', name: 'Everything else →', when: settings.notify.recovery === false ? 'opened, reminder (no recoveries)' : '', targets: elseTargets.join(', '), targetList: elseTargets, severity: '', final: false, actions: '' },
  ];

  return (
    <Page crumbs={[{ label: 'Alerts' }]} sub="Scheduled detection and notifications in Cribl Search">
      <div className="span-12 stack">
        <div className="row">
          <Text color="subtle">Changes here apply when you deploy from Setup. </Text>
          <CapraLink as={RouterLink} to="/settings/setup">Deploy from Setup</CapraLink>
          {outdated > 0 ? <Tag size="sm" color="warning">{`${outdated} searches outdated`}</Tag> : null}
        </div>
      </div>
      <Section span={12} title="Search load">
        <div className="stack">
          <RadioGroup name="search-load" aria-label="Search load" value={settings.searchLoad} layout="vertical" onChange={(e) => upd({ searchLoad: normalizeLoad(e.target.value) })}>
            {LOAD_TILES.map((l) => (
              <RadioTile key={l.id} value={l.id} description={l.description}>{l.title}{l.tag && <> <Tag size="sm" color="default">{l.tag}</Tag></>}</RadioTile>))}
          </RadioGroup>
          {settings.searchLoad === 'daily' && <>
            <SelectField label="Send the roll call at" items={HOUR_ITEMS} value={String(settings.rollCall.hour)} helperText={`in ${settings.rollCall.tz} (your browser's time zone)`}
              onChange={(k) => k != null && upd({ rollCall: { ...settings.rollCall, hour: Number(k) } })} />
            <Checkbox checked={settings.rollCall.allClear} onChange={(e) => upd({ rollCall: { ...settings.rollCall, allClear: e.target.checked } })}>Also send when every asset reports</Checkbox>
            <Text color="subtle">The roll call goes to the Notify targets below. It lists an asset until it reports again, is muted or retired, or has been silent 30 days. The Overview opens from the latest roll call and draws charts when you ask.</Text>
          </>}
          {cost && <Text color="subtle">{cost}</Text>}
          {oldLoad && oldLoad !== settings.searchLoad && <Alert appearance="warning" title="Search load changed">
            Search load changed: {LOAD_NAME[oldLoad]} → {LOAD_NAME[settings.searchLoad]}. Deploy from Setup to switch the schedules. Until then Cribl Search keeps the {LOAD_NAME[oldLoad]} schedule.</Alert>}
        </div>
      </Section>
      <Section span={12} title="Pulse searches in Cribl Search" error={err} onRetry={() => void load()}>
        <Table density="compact" appearance="flat" items={rowsOf(status.filter((r) => !r.extra || r.exists), ['id', 'desc', 'cron', 'exists', 'enabled'])} visibleColumns={vis(['id', 'desc', 'cron', 'exists', 'enabled'])} columns={cols([
          { id: 'id', label: 'Saved search' }, { id: 'desc', label: 'Purpose' }, { id: 'cron', label: 'Schedule' },
          { id: 'exists', label: 'Installed', render: (v) => <Tag size="sm" color={v ? 'success' : 'default'}>{v ? 'yes' : 'no'}</Tag> },
          { id: 'enabled', label: 'Enabled', render: (v, item) => (item?.extra && v
            ? <Tag size="sm" color="warning">installed, the plan disables it</Tag>
            : <Tag size="sm" color={v ? 'success' : 'warning'}>{v ? 'on' : 'off'}</Tag>) }])} />
      </Section>
      {addOpen && <AddChannelModal existingIds={targets.map((t) => t.id)} onClose={() => setAddOpen(false)}
        onCreated={async (id) => {
          upd({ notify: { ...settings.notify, targets: settings.notify.targets.includes(id) ? settings.notify.targets : [...settings.notify.targets, id] } });
          await listTargets().then(setTargets).catch(() => undefined);
        }} />}
      <Section span={12} title="Channels" action={<Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>Add channel</Button>}>
        <div className="stack">
          {onlySystem && <Alert appearance="info" title="Add a channel">Your org only has email and in-product notifications. Add Slack, Teams, PagerDuty or a webhook to get Pulse alerts where your team works.
            <div><Button variant="secondary" size="sm" onClick={() => setAddOpen(true)}>Add channel</Button></div></Alert>}
          <Table density="compact" appearance="flat" items={rowsOf(chRows, chIds)} visibleColumns={vis(chIds)} columns={cols([
            { id: 'id', label: 'Target' },
            { id: 'kind', label: 'Type', render: (v) => <Tag size="sm" color="default">{v}</Tag> },
            { id: 'where', label: 'Where' },
            { id: 'tone', label: 'Health', render: (v) => <Tag size="sm" color={v}>{v === 'success' ? 'Green' : v === 'warning' ? 'Yellow' : v === 'danger' ? 'Red' : 'No status'}</Tag> },
            { id: 'sentErr', label: 'Sent / errors' },
            { id: 'use', label: 'Alerts use it', render: (_v, r) => <Switch aria-label={`Alerts use ${r.id}`} checked={isOn(r.id)} disabled={r.id === 'system_email'} onChange={() => tgl(r.id)} /> },
            { id: 'actions', label: 'Actions', render: (_v, r) => <><a className="lk" href="/settings/notification-targets" target="_top" aria-label={`Open ${r.id} in Cribl`}>Open in Cribl</a> <SendTest targetId={r.id} /></> }])} />
        </div>
      </Section>
      <Section span={12} title="Routing" action={<Button variant="secondary" size="sm" disabled={routes.length >= MAX_ROUTES} onClick={() => setEditing('new')}>Add route</Button>}>
        <div className="stack">
          {editing && <RouteDrawer key={editing} route={routes.find((r) => r.id === editing) ?? { id: '', name: '', when: {}, targets: [], final: false }} routes={routes} channels={targets} onClose={() => setEditing(undefined)}
            onSave={(r) => { setRoutes(routes.some((x) => x.id === r.id) ? routes.map((x) => (x.id === r.id ? r : x)) : [...routes, r].slice(0, MAX_ROUTES)); setEditing(undefined); }} />}
          <Table density="compact" appearance="flat" items={rowsOf(rtRows, rtIds)} visibleColumns={vis(rtIds)} columns={cols([
            { id: 'n', label: '#', render: (_v, r) => r.fixed ? '' : <><IconButton icon={CaretUp} aria-label={`Move ${r.name} up`} variant="tertiary" size="sm" disabled={r.i === 0} onClick={() => setRoutes(moveRoute(routes, r.i, -1))} />
              <IconButton icon={CaretDown} aria-label={`Move ${r.name} down`} variant="tertiary" size="sm" disabled={r.i === routes.length - 1} onClick={() => setRoutes(moveRoute(routes, r.i, 1))} /> {r.i + 1}</> },
            { id: 'name', label: 'Name' },
            { id: 'when', label: 'When' },
            { id: 'targets', label: 'Send to', render: (_v, r) => <>{r.targetList.map((t: string) => <Tag key={t} size="sm" color="default">{t}</Tag>)}</> },
            { id: 'severity', label: 'Severity' },
            { id: 'final', label: 'Final', render: (_v, r) => r.fixed ? '' : r.final ? <Tag size="sm" color="warning">final</Tag> : <Text color="subtle">no</Text> },
            { id: 'actions', label: 'Actions', render: (_v, r) => r.fixed ? '' : <><IconButton icon={EditOutlined} aria-label={`Edit ${r.name}`} variant="tertiary" size="sm" onClick={() => setEditing(r.id)} />
              <IconButton icon={DeleteOutlined} aria-label={`Remove ${r.name}`} variant="tertiary" size="sm" onClick={() => setRoutes(routes.filter((x) => x.id !== r.id))} /></> }])} />
        </div>
      </Section>
      <Section span={5} title="Notify"><div className="stack">
        <TextField label="Email recipients (comma separated)" value={settings.notify.email} onChange={(v) => upd({ notify: { ...settings.notify, email: v } })} />
        <div className="row"><Switch aria-label="Send recovery notifications" checked={settings.notify.recovery !== false} onChange={(e) => upd({ notify: { ...settings.notify, recovery: e.target.checked } })} /><Text>Send recovery notifications</Text></div>
        <NumberField label="Remind every (hours)" value={settings.notify.remindH ?? 0} min={0} step={1} onChange={(v) => upd({ notify: { ...settings.notify, remindH: normalizeRemindH(v) } })}
          helperText={settings.notify.remindH ? `Send a reminder every ${settings.notify.remindH} h while an incident stays open` : '0 = off: no reminders'} />
        <div className="rule-summary"><Text variant="body-sm-semibold">Rule</Text>
          <Text color="subtle">tolerance = clamp({L.K} × learned gap, {fmtDur(L.MIN_GAP)}, {fmtDur(L.MAX_GAP)}) — <Link className="lk" to="/settings/thresholds">tune it in the threshold lab →</Link></Text></div>
        <NumberField label="Learning period (active minutes before alerting)" value={L.LEARN_MIN} min={1} onChange={(v) => upd({ learning: { ...L, LEARN_MIN: v } })} />
        <NumberField label="Grace before alerting (seconds missing)" value={L.GRACE_S} min={0} step={60} onChange={(v) => upd({ learning: { ...L, GRACE_S: v } })}
          helperText={L.GRACE_S ? `An asset must stay missing ${fmtDur(L.GRACE_S)} past its tolerance; a blip that recovers sooner never alerts` : 'Alert as soon as the tolerance is exceeded'} />
        <div className="row2">
          <NumberField label="Delayed when events arrive later than (s)" value={L.LAG_MAX} min={60} step={60} onChange={(v) => upd({ learning: { ...L, LAG_MAX: v } })} helperText={fmtDur(L.LAG_MAX)} />
          <NumberField label="Clock ahead by more than (s)" value={L.FUTURE_S} min={30} step={30} onChange={(v) => upd({ learning: { ...L, FUTURE_S: v } })} helperText={fmtDur(L.FUTURE_S)} />
        </div>
        <NumberField label="Low volume below (% of the usual hourly volume)" value={Math.round(L.VOL_MIN * 100)} min={1} max={99} step={5} onChange={(v) => upd({ learning: { ...L, VOL_MIN: v / 100 } })} />
        <div className="rule-summary"><Text variant="body-sm-semibold">One alert for a collective silence</Text>
          <Text color="subtle">When at least {L.SRC_MIN} assets of a source and {Math.round(L.SRC_PCT * 100)}% of them go silent together, Pulse sends one source alert instead of one per asset.</Text>
          <div className="row2"><NumberField label="Minimum assets" value={L.SRC_MIN} min={2} onChange={(v) => upd({ learning: { ...L, SRC_MIN: v } })} />
            <NumberField label="Share silent (%)" value={Math.round(L.SRC_PCT * 100)} min={10} max={100} step={5} onChange={(v) => upd({ learning: { ...L, SRC_PCT: v / 100 } })} /></div></div>
        <Text variant="body-xs-normal" color="subtle">Alert messages include the asset's criticality and owning team from the Assets page (lookup pulse_assets.csv).</Text>
      </div></Section>
    </Page>
  );
}
