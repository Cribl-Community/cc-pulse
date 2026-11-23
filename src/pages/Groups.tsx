import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { Table, Text } from '@capra/core';
import { SetupPulseButton } from '../components/SetupPulseButton';
import { useSnapshotGap } from '../components/useSnapshotGap';
import { TileWall } from '../components/vitals';
import { CritTag, Drill, Metric, Page, Section, StackBar, StateTag, assetPath, groupPath, srcName, type RankedRow } from '../components/ui';
import { useTab } from '../lib/layout';
import { critOf, type Inventory } from '../lib/inventory';
import { bySource, rankSources, type RankedSrc, type SrcRow } from '../lib/groups';
import { countStates, fmtPct, type Entity } from '../lib/model';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';
import { useScopeUrlOnMount } from '../scopeContext';

const srcHealth = (l: Entity[]) => { const c = countStates(l); return c.missing ? (c.missing === l.length - c.learning - c.muted ? 'down' : 'degraded') : c.late ? 'late' : c.ok ? 'healthy' : 'learning'; };
const HEALTH_STATE = { down: 'missing', degraded: 'missing', late: 'late', healthy: 'ok', learning: 'learning' } as const;

function SourcesTable({ rows, linkTo }: { rows: SrcRow[]; linkTo: (r: SrcRow) => string }) {
  return <Table density="compact" appearance="flat" items={rowsOf(rows, ['input', 'group', 'health', 'reporting', 'missing', 'mix'])} visibleColumns={vis(['input', 'group', 'health', 'reporting', 'missing', 'mix'])}
    columns={cols([
      { id: 'input', label: 'Source', render: (_, r) => <Link className="lk" to={linkTo(r)} title={r.input}>{srcName(r.input)}</Link> },
      { id: 'group', label: 'Worker group' },
      { id: 'health', label: 'Health', render: (_, r) => { const h = srcHealth(r.list); return <StateTag state={HEALTH_STATE[h]} label={h} />; } },
      { id: 'reporting', label: 'Reporting', render: (_, r) => { const c = countStates(r.list); return <span className="num">{c.ok + c.late} / {c.ok + c.late + c.missing}</span>; } },
      { id: 'missing', label: 'Missing', render: (_, r) => r.list.filter((e: Entity) => e.state === 'missing').map((e: Entity) => e.asset).join(', ') || <span className="muted">—</span> },
      { id: 'mix', label: 'Mix', render: (_, r) => <div className="mix-cell"><StackBar list={r.list} /></div> }])} />;
}


/** Worker groups list (spec 013): Page/Metric/Section only, flat cards only. Each Section owns its own
 *  loading, empty and error/Retry (re-running `refresh`). No breadcrumb or description here — those are for detail pages. */
export function Groups() {
  useScopeUrlOnMount();
  const { fleet, loading, error, updatedAt, refresh, setup } = usePulse();
  const gap = useSnapshotGap(); // R1: rejected snapshot, no rows: the reason and Compute now, not "No worker group yet"
  const busy = loading && !updatedAt;
  const groups = [...new Set(fleet.map((e) => e.group))].sort().map((g) => ({ id: g, list: fleet.filter((e) => e.group === g) }));
  const c = countStates(fleet);
  return (
    <Page timed title="Worker groups">
      <Metric span={3} label="Worker groups" value={busy || gap ? '—' : groups.length} loading={busy} />
      <Metric span={3} label="Sources" value={busy || gap ? '—' : new Set(fleet.map((e) => e.input)).size} loading={busy} />
      <Metric span={3} label="Missing" value={busy || gap ? '—' : c.missing} hint="now" loading={busy} tag={c.missing ? { label: `${c.missing} missing`, color: 'danger' } : undefined} />
      <Metric span={3} label="Late" value={busy || gap ? '—' : c.late} hint="now" loading={busy} tag={c.late ? { label: `${c.late} late`, color: 'warning' } : undefined} />

      <Section id="groups-list" span={12} title="Worker groups" description="Every group sending Pulse heartbeats — open one to see who went silent and when"
        loading={busy} error={error} onRetry={refresh}
        empty={!busy && !error && !groups.length ? gap ?? { title: 'No worker group yet', description: 'Deploy Pulse to a worker group to start learning its assets.', cta: setup === 'not-deployed' ? <SetupPulseButton /> : undefined } : false}>
        <Table density="compact" appearance="flat" items={rowsOf(groups, ['id', 'health', 'assets', 'sources', 'missing', 'late', 'mix'])} visibleColumns={vis(['id', 'health', 'assets', 'sources', 'missing', 'late', 'mix'])}
          columns={cols([
            { id: 'id', label: 'Worker group', render: (v) => <Link className="lk" to={groupPath(v)}>{v}</Link> },
            { id: 'health', label: 'Health', render: (_, g) => { const gc = countStates(g.list); return gc.missing ? <StateTag state="missing" label="degraded" /> : gc.late ? <StateTag state="late" /> : <StateTag state="ok" label="healthy" />; } },
            { id: 'assets', label: 'Assets', render: (_, g) => <span className="num">{g.list.length}</span> },
            { id: 'sources', label: 'Sources', render: (_, g) => <span className="num">{new Set(g.list.map((e: Entity) => e.input)).size}</span> },
            { id: 'missing', label: 'Missing', render: (_, g) => <span className="num">{countStates(g.list).missing}</span> },
            { id: 'late', label: 'Late', render: (_, g) => <span className="num">{countStates(g.list).late}</span> },
            { id: 'mix', label: 'Mix', render: (_, g) => <div className="mix-cell"><StackBar list={g.list} /></div> }])} />
      </Section>

      <Section id="groups-sources" span={12} title="All sources" description="every source feeding a worker group"
        loading={busy} error={error} onRetry={refresh} empty={!busy && !error && !fleet.length ? gap ? { title: gap.title } : { title: 'No source yet' } : false}>
        <SourcesTable rows={bySource(fleet)} linkTo={(r) => groupPath(r.group, r.input)} />
      </Section>
    </Page>);
}

const TABS = [{ key: 'sources', name: 'Sources' }, { key: 'assets', name: 'Assets' }];
const TAB_KEYS = TABS.map((t) => t.key);

/** Per-source detail: this source's tile wall (spec 013 §6 — the Drill detail) and its asset table. */
function SourceDetail({ group, row, inventory }: { group: string; row: RankedSrc; inventory: Inventory }) {
  const rows = [...row.list].sort((a, b) => a.asset.localeCompare(b.asset)).map((e) => ({ ...e, id: e.key }));
  return (<div className="stack">
    <div className="row"><Text variant="body-md-semibold">{srcName(row.input)}</Text><span className="sp" />
      <Text variant="body-xs-normal" color="subtle">{row.list.length} asset{row.list.length === 1 ? '' : 's'} in {group} · {row.missing} missing ({fmtPct(row.share)})</Text></div>
    <TileWall fleet={row.list} groups={[group]} />
    <Table density="compact" appearance="flat" items={rowsOf(rows, ['asset', 'crit', 'state', 'team'])} visibleColumns={vis(['asset', 'crit', 'state', 'team'])}
      columns={cols([
        { id: 'asset', label: 'Asset', render: (v, e) => <Link className="lk" to={assetPath(e)}>{v}</Link> },
        { id: 'crit', label: 'Crit', render: (_, e) => <CritTag info={inventory[e.asset]} /> },
        { id: 'state', label: 'State', render: (v) => <StateTag state={v} /> },
        { id: 'team', label: 'Owner', render: (_, e) => inventory[e.asset]?.team ?? <Text color="subtle">—</Text> }])} />
  </div>);
}

/** Sources tab: a Drill — sources ranked by missing share (descending), the detail is that source's tile wall and table.
 *  `?source=<s>` (set from the Overview "Which source is losing senders?" Question) preselects the row. */
function SourcesTab({ group, ranked, inventory, source, loading, error, onRetry }:
  { group: string; ranked: RankedSrc[]; inventory: Inventory; source?: string } & SectionIO) {
  const [picked, setPicked] = useState<string | undefined>(source);
  const active = ranked.find((r) => r.input === picked) ?? ranked[0];
  const rows: RankedRow[] = ranked.map((r) => ({ key: r.input, name: srcName(r.input), sub: `${r.list.length} asset${r.list.length === 1 ? '' : 's'} · ${r.missing} missing`, value: r.share, display: fmtPct(r.share) }));
  return (
    <Section id="group-sources" span={12} title="Sources" description="ranked by missing share, worst first"
      loading={loading} error={error} onRetry={onRetry} empty={!loading && !error && !rows.length ? { title: 'No source in this group' } : false}>
      <Drill rows={rows} activeKey={active?.input} onSelect={(r) => setPicked(r.key)} label="Sources by missing share"
        detail={active ? <SourceDetail group={group} row={active} inventory={inventory} /> : <Text color="subtle">No source yet.</Text>} />
    </Section>);
}

/** Assets tab: every asset in the group, in a Section. */
function AssetsTab({ group, all, inventory, loading, error, onRetry }:
  { group: string; all: Entity[]; inventory: Inventory } & SectionIO) {
  const rows = useMemo(() => [...all].sort((a, b) => a.asset.localeCompare(b.asset)).map((e) => ({ ...e, id: e.key })), [all]);
  return (
    <Section id="group-assets" span={12} title={`Assets in ${group}`} description={`${all.length} asset${all.length === 1 ? '' : 's'} across every source`}
      loading={loading} error={error} onRetry={onRetry} empty={!loading && !error && !all.length ? { title: 'No asset in this group' } : false}>
      <Table density="compact" appearance="flat" items={rowsOf(rows, ['asset', 'crit', 'state', 'source', 'team'])} visibleColumns={vis(['asset', 'crit', 'state', 'source', 'team'])}
        columns={cols([
          { id: 'asset', label: 'Asset', render: (v, e) => <Link className="lk" to={assetPath(e)}>{v}</Link> },
          { id: 'crit', label: 'Crit', render: (_, e) => <CritTag info={inventory[e.asset]} /> },
          { id: 'state', label: 'State', render: (v) => <StateTag state={v} /> },
          { id: 'source', label: 'Source', render: (_, e) => srcName(e.input) },
          { id: 'team', label: 'Owner', render: (_, e) => inventory[e.asset]?.team ?? <Text color="subtle">—</Text> }])} />
    </Section>);
}

type SectionIO = { loading: boolean; error?: unknown; onRetry: () => void };

/** One worker group: header TabNav Sources · Assets (spec 013 §1, bound to `?tab=` via Page's `tabs` prop, read here with
 *  `useTab` — the active 'tab' lives in the URL — while the Capra TabNav itself lives in Page/PageTabs).
 *  Sources is a Drill (spec 013 §6); `?source=<s>` preselects it,
 *  so the Overview "Which source is losing senders?" Question lands here with that source already shown. */
export function GroupDetail() {
  useScopeUrlOnMount();
  const { group = '' } = useParams();
  const [params] = useSearchParams();
  const source = params.get('source') ?? undefined;
  const [tab] = useTab(TAB_KEYS, 'sources');
  const { fleet, inventory, loading, error, updatedAt, refresh } = usePulse();
  const gap = useSnapshotGap(); // R1: rejected snapshot, no rows: not "Pulse is not deployed there"
  const busy = loading && !updatedAt;
  const all = useMemo(() => fleet.filter((e) => e.group === group), [fleet, group]);
  const ranked = useMemo(() => rankSources(bySource(all)), [all]);
  const c = countStates(all);
  const sourceCount = new Set(all.map((e) => e.input)).size;
  const p1 = all.filter((e) => e.state === 'missing' && critOf(inventory[e.asset]) === 1).length;

  if (!all.length && !busy) return (
    <Page crumbs={[{ label: 'Worker groups', to: '/groups' }, { label: group }]} description={`No Pulse data for ${group}`} timed>
      <Section span={12} loading={false} empty={gap ?? { title: `No Pulse data for ${group}`, description: 'Either Pulse is not deployed there yet, or nothing was received in the range.' }} />
    </Page>);

  return (
    <Page timed crumbs={[{ label: 'Worker groups', to: '/groups' }, { label: group }]}
      description={`${all.length} asset${all.length === 1 ? '' : 's'} across ${sourceCount} source${sourceCount === 1 ? '' : 's'}`}
      tabs={TABS} defaultTab="sources" updatedAt={updatedAt} onRefresh={refresh} refreshing={loading && !!updatedAt}>
      <Metric span={3} label="Assets" value={all.length} loading={busy} hint={`${c.learning} learning · ${c.muted} muted`} />
      <Metric span={3} label="Missing" value={c.missing} loading={busy} hint={p1 ? `${p1} critical (P1), now` : 'now'} tag={c.missing ? { label: `${c.missing} missing`, color: 'danger' } : undefined} />
      <Metric span={3} label="Late" value={c.late} loading={busy} hint="now" tag={c.late ? { label: `${c.late} late`, color: 'warning' } : undefined} />
      <Metric span={3} label="Reporting now" value={<>{c.ok + c.late}<span className="metric-of"> / {c.ok + c.late + c.missing}</span></>} loading={busy} hint="now" />

      {tab === 'sources' && <SourcesTab group={group} ranked={ranked} inventory={inventory} source={source} loading={busy} error={error} onRetry={refresh} />}
      {tab === 'assets' && <AssetsTab group={group} all={all} inventory={inventory} loading={busy} error={error} onRetry={refresh} />}
    </Page>);
}
