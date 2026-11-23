import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, EmptyState, Modal, NumberField, SelectField, Text, TextField, ToggleButtonGroup } from '@capra/core';
import { Page, Section, StateTag, assetPath, srcName } from '../components/ui';
import { kvPut } from '../lib/api';
import { CRIT, publishInventory, ruleMatches, saveClusters, saveRules, type ClassRule, type Criticality } from '../lib/inventory';
import { saveWindows, scopeLabel, status, type Window } from '../lib/maintenance';
import { fmtDur, isUp } from '../lib/model';
import { NEXT_CYCLE } from '../lib/overrideApply';
import { usePulse } from '../state';

type Tab = 'maintenance' | 'clusters' | 'rules';
const when = (t: number) => new Date(t * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Specs 006 + 008: maintenance windows, HA clusters and classification rules — the policies that decide who gets paged. */
export function Policies() {
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) ?? 'maintenance';
  return (
    <Page crumbs={[{ label: 'Policies' }]} sub="Decide when silence is expected, which assets cover for each other, and how new assets are classified"
      actions={<ToggleButtonGroup size="sm" aria-label="Policy" disallowEmptySelection selectedKeys={new Set([tab])} onSelectionChange={(k) => setParams({ tab: String([...k][0]) })}
        items={[{ key: 'maintenance', text: 'Maintenance' }, { key: 'clusters', text: 'HA clusters' }, { key: 'rules', text: 'Classification' }]} />}>
      {tab === 'maintenance' ? <Maintenance /> : tab === 'clusters' ? <Clusters /> : <Rules />}
    </Page>);
}

/* ---------- maintenance windows ---------- */
function Maintenance() {
  const { fleet, windows, setWindows, demo, applyWindows } = usePulse();
  const scopes = useMemo(() => [{ id: '*', label: 'Everything' },
    ...[...new Set(fleet.map((e) => e.group))].sort().map((g) => ({ id: `g:${g}`, label: `Worker group ${g}` })),
    ...[...new Set(fleet.map((e) => `${e.group}|${e.input}`))].sort().map((k) => ({ id: `i:${k}`, label: `Source ${srcName(k.split('|')[1])} on ${k.split('|')[0]}` }))], [fleet]);
  const [scope, setScope] = useState('*');
  const [startIn, setStartIn] = useState('0');
  const [hours, setHours] = useState(2);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const [del, setDel] = useState<Window>();
  const sorted = [...windows].sort((a, b) => ['active', 'scheduled', 'ended'].indexOf(status(a)) - ['active', 'scheduled', 'ended'].indexOf(status(b)) || a.start - b.start);

  async function save(next: Window[], text: string) {
    setBusy(true); setMsg(undefined);
    try {
      const saved = demo ? next : await saveWindows(next);
      setWindows(saved);
      // T3: the assets the windows cover (or stop covering) change state at once; no recompute.
      await applyWindows(saved);
      setMsg({ ok: true, text: `${text} ${NEXT_CYCLE}` });
    }
    catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  }
  const startOf = () => { const now = Math.floor(Date.now() / 1000); if (startIn === 'night') { const d = new Date(); d.setHours(22, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); return Math.floor(d.getTime() / 1000); } return now + Number(startIn) * 3600; };
  const affected = fleet.filter((e) => scope === '*' || scope === `g:${e.group}` || scope === `i:${e.group}|${e.input}`).length;

  return (<>
    {msg && <div className="span-12"><Alert appearance={msg.ok ? 'success' : 'danger'} title={msg.ok ? 'Saved' : 'Not saved'}>{msg.text}</Alert></div>}
    <Section span={5} title="New window" description="silence inside it is expected: no alert, shown as Maintenance">
      <div className="stack">
        <SelectField label="Applies to" items={scopes} value={scope} onChange={(k) => k && setScope(String(k))} helperText={`${affected} asset${affected === 1 ? '' : 's'} today`} />
        <div className="row2">
          <SelectField label="Starts" value={startIn} onChange={(k) => k && setStartIn(String(k))}
            items={[{ id: '0', label: 'Now' }, { id: '1', label: 'In 1 hour' }, { id: 'night', label: 'Tonight at 22:00' }, { id: '24', label: 'In a day' }]} />
          <NumberField label="Lasts (hours)" value={hours} min={0.25} step={0.25} onChange={setHours} />
        </div>
        <TextField label="Reason" value={reason} onChange={setReason} placeholder="Patch Tuesday, firewall upgrade…" />
        <div><Button variant="primary" pending={busy} onClick={() => { const start = startOf();
          void save([...windows, { id: crypto.randomUUID(), scope, start, end: start + Math.round(hours * 3600), reason: reason || 'maintenance', created: new Date().toISOString() }],
            `${scopeLabel(scope)}: ${when(start)} for ${fmtDur(hours * 3600)}. Published to lookup pulse_maintenance.csv.`); }}>Schedule window</Button></div>
        <Text variant="body-xs-normal" color="subtle">The most specific window wins (source, then worker group, then everything). One window per scope is active at a time.</Text>
      </div>
    </Section>
    <Section span={7} title="Windows" description="this week">
      {!sorted.length ? <EmptyState title="No maintenance window" description="Schedule one before planned work so nobody is paged for an expected silence." size="md" />
        : <div>{sorted.map((w) => <div key={w.id} className="pol-row">
          <div className="stack-sm" style={{ gap: 2 }}><div className="row"><Text variant="body-sm-semibold">{scopeLabel(w.scope)}</Text>
            <StateTag state={status(w) === 'active' ? 'maintenance' : status(w) === 'scheduled' ? 'learning' : 'ok'} label={status(w) === 'active' ? 'Active' : status(w) === 'scheduled' ? 'Scheduled' : 'Ended'} /></div>
            <Text variant="body-xs-normal" color="subtle">{when(w.start)} to {when(w.end)}, {w.reason}</Text></div>
          {status(w) !== 'ended' && <Button size="sm" variant="tertiary" onClick={() => setDel(w)}>{status(w) === 'active' ? 'End now' : 'Cancel'}</Button>}
        </div>)}</div>}
    </Section>
    <Modal isOpen={!!del} title={del && status(del) === 'active' ? 'End this window now?' : 'Cancel this window?'} confirmButtonText={del && status(del) === 'active' ? 'End now' : 'Cancel window'}
      onClose={() => setDel(undefined)} onConfirm={() => { const w = del!; setDel(undefined);
        void save(status(w) === 'active' ? windows.map((x) => (x.id === w.id ? { ...x, end: Math.floor(Date.now() / 1000) } : x)) : windows.filter((x) => x.id !== w.id), `${scopeLabel(w.scope)}: window ${status(w) === 'active' ? 'ended' : 'cancelled'}.`); }}>
      <Text>{del && scopeLabel(del.scope)} will alert normally again. Pulse republishes the lookup pulse_maintenance.csv.</Text>
    </Modal>
  </>);
}

/* ---------- HA clusters ---------- */
function Clusters() {
  const { fleet, rawInventory, inventory, setInventory, clusters, setClusters, rules, demo, entities } = usePulse();
  const names = [...new Set([...Object.keys(clusters), ...Object.values(inventory).map((i) => i.cluster).filter(Boolean) as string[]])].sort();
  const [name, setName] = useState('');
  const [members, setMembers] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const seen = entities.map((r) => ({ asset: String(r.asset), input: String(r.input) }));

  async function persist(nextInv: typeof rawInventory, nextCl: typeof clusters, text: string) {
    setBusy(true); setMsg(undefined);
    try {
      if (!demo) { await kvPut('inventory', nextInv); await saveClusters(nextCl); await publishInventory(nextInv, nextCl, rules, seen); }
      setInventory(nextInv); setClusters(nextCl); setMsg({ ok: true, text });
    } catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  }
  const create = () => {
    const list = members.split(/[\s,]+/).filter(Boolean); if (!name || list.length < 2) { setMsg({ ok: false, text: 'Give the cluster a name and at least two members.' }); return; }
    const inv = { ...rawInventory }; list.forEach((a) => { inv[a] = { ...inv[a], cluster: name }; });
    void persist(inv, { ...clusters, [name]: { min_pct: 50 } }, `Cluster ${name} with ${list.length} members. Published to lookup pulse_assets.csv.`);
  };

  return (<>
    {msg && <div className="span-12"><Alert appearance={msg.ok ? 'success' : 'danger'} title={msg.ok ? 'Saved' : 'Not saved'}>{msg.text}</Alert></div>}
    <div className="span-8 stack">
      {!names.length && <Section title="No HA cluster yet"><Text color="subtle">Group assets that back each other up — a firewall pair, domain controllers, a load-balanced pool. A silent member then stays “Covered by HA” while enough of the others send, and Pulse only alerts when the cluster itself is at risk.</Text></Section>}
      {names.map((c) => { const m = fleet.filter((e) => (inventory[e.asset]?.cluster || e.cluster) === c), up = m.filter(isUp).length, min = clusters[c]?.min_pct ?? 50;
        const ok = m.length ? (up * 100) / m.length >= min : true;
        return (<Section key={c} title={c} description={clusters[c]?.description ?? `${m.length} members`} action={<StateTag state={!m.length ? 'learning' : up === m.length ? 'ok' : ok ? 'covered' : 'missing'} label={!m.length ? 'No data' : up === m.length ? 'All up' : ok ? 'Degraded, covered' : 'At risk'} />}>
          <div className="stack-sm">
            <div className="row wrap">{m.map((e) => <span key={e.key} className="row" style={{ gap: 4 }}><Link className="lk" to={assetPath(e)}>{e.asset}</Link><StateTag state={e.state} /></span>)}</div>
            <div className="row"><Text variant="body-xs-normal" color="subtle">{up} of {m.length} sending. Alerts when fewer than</Text>
              <div style={{ width: 120 }}><NumberField aria-label="Minimum share up" value={min} min={5} max={100} step={5} onChange={(v) => void persist(rawInventory, { ...clusters, [c]: { ...clusters[c], min_pct: v } }, `${c}: alerts below ${v}% of members up.`)} /></div>
              <Text variant="body-xs-normal" color="subtle">% of members send.</Text></div>
          </div></Section>); })}
    </div>
    <Section span={4} title="New cluster">
      <div className="stack">
        <TextField label="Name" value={name} onChange={setName} placeholder="fw-par-edge" />
        <TextField label="Members" value={members} onChange={setMembers} placeholder="fw-par-edge-01, fw-par-edge-02" helperText="Asset names, separated by commas" />
        <div><Button variant="primary" pending={busy} onClick={create}>Create cluster</Button></div>
        <Text variant="body-xs-normal" color="subtle">Membership is stored with each asset (Assets page, field “HA cluster”); classification rules can set it too.</Text>
      </div>
    </Section>
  </>);
}

/* ---------- classification rules ---------- */
function Rules() {
  const { fleet, rules, setRules, rawInventory, clusters, demo, entities } = usePulse();
  const [match, setMatch] = useState('');
  const [input, setInput] = useState('');
  const [team, setTeam] = useState('');
  const [crit, setCrit] = useState<string>('3');
  const [env, setEnv] = useState('');
  const [cluster, setCluster] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const assets = [...new Map(fleet.map((e) => [e.asset, e])).values()];
  const draft: ClassRule = { id: match, match, input: input || undefined, set: { criticality: Number(crit) as Criticality, ...(team ? { team } : {}), ...(env ? { environment: env } : {}), ...(cluster ? { cluster } : {}) } };
  const hits = match ? assets.filter((e) => ruleMatches(draft, e.asset, e.input)) : [];
  const seen = entities.map((r) => ({ asset: String(r.asset), input: String(r.input) }));

  async function persist(next: ClassRule[], text: string) {
    setBusy(true); setMsg(undefined);
    try { if (!demo) { await saveRules(next); await publishInventory(rawInventory, clusters, next, seen); } setRules(next); setMsg({ ok: true, text }); }
    catch (e) { setMsg({ ok: false, text: errText(e) }); }
    finally { setBusy(false); }
  }

  return (<>
    {msg && <div className="span-12"><Alert appearance={msg.ok ? 'success' : 'danger'} title={msg.ok ? 'Saved' : 'Not saved'}>{msg.text}</Alert></div>}
    <Section span={7} title="Rules" description="first match wins; values typed on the Assets page always win over a rule">
      {!rules.length ? <EmptyState title="No rule yet" description="Classify assets by name so new ones get an owner and a criticality the moment they appear." size="md" />
        : <div>{rules.map((r, i) => { const n = assets.filter((e) => ruleMatches(r, e.asset, e.input)).length;
          return (<div key={`${r.id}-${i}`} className="pol-row"><div className="stack-sm" style={{ gap: 2 }}>
            <div className="row"><span className="mono">{r.match}</span>{r.input && <Text variant="body-xs-normal" color="subtle">on sources matching <span className="mono">{r.input}</span></Text>}</div>
            <Text variant="body-xs-normal" color="subtle">{[r.set.criticality ? CRIT[r.set.criticality].long : '', r.set.team, r.set.environment, r.set.cluster ? `cluster ${r.set.cluster}` : ''].filter(Boolean).join(', ')}. Matches {n} asset{n === 1 ? '' : 's'}.</Text></div>
            <Button size="sm" variant="tertiary" pending={busy} onClick={() => void persist(rules.filter((_, j) => j !== i), `Rule ${r.match} removed.`)}>Remove</Button></div>); })}</div>}
    </Section>
    <Section span={5} title="New rule">
      <div className="stack">
        <div className="row2"><TextField label="Asset name matches" value={match} onChange={setMatch} placeholder="^fw-|^pa-" helperText="Regular expression, case-insensitive" />
          <TextField label="On sources matching" value={input} onChange={setInput} placeholder="optional, e.g. syslog" /></div>
        <div className="row2"><SelectField label="Criticality" value={crit} onChange={(k) => k && setCrit(String(k))} items={([1, 2, 3, 4] as Criticality[]).map((c) => ({ id: String(c), label: CRIT[c].long }))} />
          <TextField label="Owning team" value={team} onChange={setTeam} /></div>
        <div className="row2"><TextField label="Environment" value={env} onChange={setEnv} placeholder="prod" /><TextField label="HA cluster" value={cluster} onChange={setCluster} placeholder="optional" /></div>
        {match && <Text variant="body-xs-normal" color="subtle">Matches {hits.length} asset{hits.length === 1 ? '' : 's'} today{hits.length ? `: ${hits.slice(0, 5).map((e) => e.asset).join(', ')}${hits.length > 5 ? '…' : ''}` : ''}</Text>}
        <div><Button variant="primary" pending={busy} disabled={!match} onClick={() => void persist([...rules, draft], `Rule ${match} added; ${hits.length} assets classified. Published to lookup pulse_assets.csv.`)}>Add rule</Button></div>
      </div>
    </Section>
  </>);
}
