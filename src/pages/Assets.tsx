import { useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Button, CustomTooltipTrigger, Drawer, EMPTY_CELL_PLACEHOLDER, FilterToolbar, IconButton, Menu, SelectPillter, Table, Text, Tooltip } from '@capra/core';
import { EllipsisVertical, FilterOutlined } from '@capra/icons';
import { AssetInfoDrawer } from '../components/AssetInfoDrawer';
import { SetupPulseButton } from '../components/SetupPulseButton';
import { useSnapshotGap } from '../components/useSnapshotGap';
import { useHistoryOnOpen } from '../components/useHistoryOnOpen';
import { CritTag, Metric, Page, Section, StateTag, enc } from '../components/ui';
import { runSearch, type Row } from '../lib/api';
import { DRAWER_KEYS, NONE, UNASSIGNED, activeCount, assetRows, emptyFilters, filterAssets, filtersToParams, optionValues, parseFilters, sourceOf, withFilter,
  type AssetFilters, type AssetRow, type ListKey } from '../lib/assetFilters';
import { healthOf } from '../lib/history';
import { describeRule } from '../lib/identity';
import { retiredQuery } from '../lib/kql';
import { CRIT } from '../lib/inventory';
import { STATE_ORDER, STATE_LABEL, fmtDur, fmtPct } from '../lib/model';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';
import { useScopeUrlOnMount, useTimeScope } from '../scopeContext';
import { withRange } from '../lib/timescope';

type Opt = { label: string; value: string };
const COLS = ['asset', 'crit', 'state', 'team', 'owner', 'cluster', 'sources', 'avail', 'silent', 'actions'];
const RETIRED_COLS = ['asset', 'input', 'worker_group', 'last'];

/** A single-line cell: long values are cut with an ellipsis and the full text is in a tooltip. Empty → EMPTY_CELL_PLACEHOLDER. */
function Truncated({ text }: { text?: string }) {
  if (!text) return <Text color="subtle">{EMPTY_CELL_PLACEHOLDER}</Text>;
  return <Tooltip title={text} placement="top"><CustomTooltipTrigger><span className="cell-trunc" tabIndex={0}>{text}</span></CustomTooltipTrigger></Tooltip>;
}

export function Assets() {
  useScopeUrlOnMount();
  useHistoryOnOpen(); // Economy: the Available column needs the gap ledger (spec 033 §5)
  const { scope } = useTimeScope();
  const { fleet, inventory, loading, updatedAt, ledger, settings, demo, error, refresh, win, setup } = usePulse();
  const gap = useSnapshotGap(); // R1: rejected snapshot, no rows: say why and offer Compute now, not "No assets yet"
  const [params, setParams] = useSearchParams();
  const f = useMemo(() => parseFilters(params), [params]);
  /** Every filter change goes through here, so the URL is the single source of truth. */
  const setFilters = (next: AssetFilters) => setParams(filtersToParams(next, params), { replace: true });
  const set = (key: keyof AssetFilters, v: string | string[]) => setFilters(withFilter(f, key, v));
  const [drawer, setDrawer] = useState(DRAWER_KEYS.some((k) => f[k].length > 0));
  const [edit, setEdit] = useState<string>();

  const [retired, setRetired] = useState<Row[]>();
  const [retErr, setRetErr] = useState<string>();
  const [retBusy, setRetBusy] = useState(false);
  async function loadRetired() { setRetErr(undefined); setRetBusy(true);
    try { setRetired(demo ? [{ worker_group: 'prod-eu', input: 'syslog:in_syslog:tcp', asset: 'sw-old-core-01', last_seen: Date.now() / 1000 - 3 * 86400, key_src: 'host' }] : await runSearch(retiredQuery(settings), '-7d', 'now', 180_000, 2000)); }
    catch (e) { setRetErr(e instanceof Error ? e.message : String(e)); setRetired([]); } finally { setRetBusy(false); } }

  const rows = useMemo<AssetRow[]>(() => assetRows(fleet, inventory), [fleet, inventory]);
  const shown = useMemo(() => filterAssets(rows, f, inventory), [rows, f, inventory]);
  const count = (g: Partial<AssetFilters>) => filterAssets(rows, { ...emptyFilters(), ...g }, inventory).length;
  const booting = loading && !updatedAt;

  const opts = (key: ListKey, label: (v: string) => string, noneLabel: string, noneValue = NONE): Opt[] => {
    const o = optionValues(rows, inventory, key);
    const list = o.values.map((v) => ({ value: v, label: label(v) }));
    // A value that came from the URL stays selectable even when no row has it, so the control reflects the filter.
    for (const v of f[key]) if (v !== noneValue && v !== NONE && !o.values.includes(v)) list.push({ value: v, label: label(v) });
    return o.none || f[key].includes(noneValue) ? [...list, { value: noneValue, label: noneLabel }] : list;
  };
  const pillter = (key: ListKey, label: string, options: Opt[]) =>
    <SelectPillter key={key} label={label} multiSelect options={options} selectedValues={f[key]} onChange={(v) => set(key, v)} onClear={() => set(key, [])} />;
  const stateOpts = STATE_ORDER.map((s) => ({ value: s, label: STATE_LABEL[s] }));
  const critOpts = [...([1, 2, 3, 4] as const).map((c) => ({ value: String(c), label: CRIT[c].long })), { value: NONE, label: 'Not classified' }];
  const drawerCount = activeCount(f, DRAWER_KEYS);
  const anyFilter = activeCount(f) > 0 || !!f.q.trim();

  const table = !rows.length && !booting ? null
    : <div className="assets-table"><Table density="compact" appearance="flat" aria-label="Assets" items={rowsOf(shown, COLS)} isLoading={booting} visibleColumns={vis(COLS)}
      columns={cols([
        { id: 'asset', label: 'Asset', render: (_, r: AssetRow) => <Link className="lk lk-cell" to={`/assets/${enc(r.asset)}`}>{r.asset}</Link> },
        { id: 'crit', label: 'Crit', render: (_, r: AssetRow) => <CritTag info={inventory[r.asset]} showUnset /> },
        { id: 'state', label: 'State', render: (_, r: AssetRow) => <StateTag state={r.worst.state} /> },
        { id: 'team', label: 'Team', render: (_, r: AssetRow) => <Truncated text={inventory[r.asset]?.team} /> },
        { id: 'owner', label: 'Owner', render: (_, r: AssetRow) => <Truncated text={inventory[r.asset]?.contact} /> },
        { id: 'cluster', label: 'HA cluster', render: (_, r: AssetRow) => <Truncated text={inventory[r.asset]?.cluster || r.entities.find((e) => e.cluster)?.cluster} /> },
        { id: 'sources', label: 'Source', render: (_, r: AssetRow) => <Truncated text={[...new Set(r.entities.map((e) => sourceOf(e.input)))].join(', ')} /> },
        { id: 'avail', label: withRange('Available', scope), render: (_, r: AssetRow) => (ledger
          ? <span className="num">{fmtPct(Math.min(...r.entities.map((e) => healthOf(e, ledger[e.key], win).availability)))}</span>
          : <Text color="subtle">{EMPTY_CELL_PLACEHOLDER}</Text>) },
        { id: 'silent', label: 'Silent', render: (_, r: AssetRow) => <span className="num">{fmtDur(r.worst.silent_s)}</span> },
        { id: 'actions', label: '', render: (_, r: AssetRow) => (
          <Menu trigger={<IconButton icon={EllipsisVertical} aria-label={`Actions for ${r.asset}`} variant="tertiary" size="sm" />}>
            <Menu.Item as="button" label="Edit" onPress={() => setEdit(r.asset)} />
          </Menu>) }])} /></div>;

  const filtersDrawer = (
    <Drawer mode="inline" placement="right" width={360} isOpen={drawer} onClose={() => setDrawer(false)} title="Filters"
      footer={drawerCount ? <Button variant="tertiary" size="sm" onClick={() => setFilters({ ...f, owner: [], cluster: [], source: [], identity: [] })}>Clear these filters</Button> : undefined}>
      <div className="stack drawer-filters">
        {pillter('owner', 'Owner', opts('owner', (v) => v, 'Nobody'))}
        {pillter('cluster', 'HA cluster', opts('cluster', (v) => v, 'Not in a cluster'))}
        {pillter('source', 'Source', opts('source', (v) => v, 'No source'))}
        {pillter('identity', 'Identity', opts('identity', describeRule, 'Not reported'))}
      </div>
    </Drawer>);

  return (
    <Page timed title="Assets">
      <Metric label="Assets" value={rows.length} loading={booting} />
      <Metric label="Critical (P1)" value={count({ crit: ['1'] })} to="/assets?crit=1" hint={`${count({ crit: ['1'], state: ['missing'] })} missing now`} />
      <Metric label="Without owner" value={count({ owner: [NONE] })} to="/assets?owner=none" hint="alerts say “unassigned”" />
      <Metric label="Not classified" value={count({ crit: [NONE] })} to="/assets?crit=none" hint="ranked as P3 until set" />
      <Section span={12} className="assets-section" error={rows.length ? undefined : error} onRetry={() => void refresh()}
        empty={gap ?? (!rows.length && !booting ? { title: 'No assets yet', description: 'Assets appear once a deployed source receives events.', cta: setup === 'not-deployed' ? <SetupPulseButton /> : undefined } : undefined)}>
        <Drawer.InlineLayout drawer={filtersDrawer}>
          <div className="stack">
            <FilterToolbar selectedKeys={new Set()} filterInputProps={{ 'aria-label': 'Filter assets', placeholder: 'Filter assets', value: f.q, onChange: (v: string) => set('q', v) }}
              renderActions={() => <div className="row filter-pillters">
                {pillter('state', 'State', stateOpts)}
                {pillter('crit', 'Criticality', critOpts)}
                {pillter('team', 'Team', opts('team', (v) => v, 'Unassigned', UNASSIGNED))}
                <Button variant="secondary" size="sm" leadingIcon={FilterOutlined} aria-expanded={drawer} onClick={() => setDrawer(!drawer)}>{drawerCount ? `Filters (${drawerCount})` : 'Filters'}</Button>
                {anyFilter && <Button variant="tertiary" size="sm" onClick={() => setFilters(emptyFilters())}>Clear all</Button>}
              </div>} />
            {anyFilter && <Text variant="body-xs-normal" color="subtle">{`${shown.length} of ${rows.length} assets match`}</Text>}
            {table}
          </div>
        </Drawer.InlineLayout>
      </Section>
      <Section title="Gone quiet for longer than the detection window" description={`seen in the last 7 days but not in the last ${settings.learning.LOOKBACK.replace('-', '')}: alerted once, now out of sight`}
        action={<Button size="sm" variant="secondary" pending={retBusy} onClick={() => void loadRetired()}>{retired ? 'Refresh' : 'Look back 7 days'}</Button>}
        error={retErr} onRetry={() => void loadRetired()}>
        {!retired ? <Text color="subtle">Assets silent for more than a day drop out of the live view. Run a 7-day search to list them before you decide to retire or chase them.</Text>
          : !retired.length ? <Text color="subtle">Nothing went quiet for longer than a day.</Text>
          : <div className="assets-table"><Table density="compact" appearance="flat" aria-label="Assets gone quiet" items={rowsOf(retired.map((r, i) => ({ id: i, ...r })), RETIRED_COLS)} visibleColumns={vis(RETIRED_COLS)}
            columns={cols([{ id: 'asset', label: 'Asset' }, { id: 'input', label: 'Source', render: (v) => <Truncated text={sourceOf(String(v))} /> }, { id: 'worker_group', label: 'Worker group' },
              { id: 'last', label: 'Last seen', render: (_, r) => `${fmtDur(Date.now() / 1000 - Number(r.last_seen))} ago` }])} /></div>}
      </Section>
      <AssetInfoDrawer asset={edit ?? ''} isOpen={!!edit} onClose={() => setEdit(undefined)} />
    </Page>);
}
