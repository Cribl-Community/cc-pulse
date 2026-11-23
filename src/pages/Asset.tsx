import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, EMPTY_CELL_PLACEHOLDER, EmptyState, Modal, NumberField, Skeleton, Table, Text, ToggleButtonGroup } from '@capra/core';
import { Copilot } from '@capra/icons';
import { AssetInfoDrawer } from '../components/AssetInfoDrawer';
import { useSnapshotGap } from '../components/useSnapshotGap';
import { useHistoryOnOpen } from '../components/useHistoryOnOpen';
import { ActivityChart } from '../components/charts';
import { CritTag, Metric, Page, Section, SignalTag, ActivitySpark, StateTag, assetPath, groupPath, srcName } from '../components/ui';
import { ackOverride, setOverride } from '../lib/deploy';
import { healthOf } from '../lib/history';
import { NEXT_CYCLE, type OverrideChange } from '../lib/overrideApply';
import { rangePhrase, withRange } from '../lib/timescope';
import { describeRule } from '../lib/identity';
import { CRIT, critOf } from '../lib/inventory';
import { STATE_ORDER, diagnose, fmtDur, fmtPct, noEventsText, ruleTolerance } from '../lib/model';
import { formatClock } from '../lib/timefmt';
import { entitySeries, seriesEnd } from '../lib/series';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';
import { useScopeUrlOnMount, useTimeScope } from '../scopeContext';

const WINDOWS = { '6': { span: 300, bins: 72 }, '24': { span: 600, bins: 144 } } as const;

export function Asset() {
  const { scope } = useTimeScope(), phrase = rangePhrase(scope);
  useScopeUrlOnMount();
  useHistoryOnOpen(); // Economy: the Available metric and the activity sparks need the history (spec 033 §5)
  const { asset = '' } = useParams();
  const [params] = useSearchParams();
  const nav = useNavigate();
  const { fleet, inventory, activity, settings, applyOverride, loading, updatedAt, ledger, win: hw, truncated } = usePulse();
  const gap = useSnapshotGap(); // R1: a rejected snapshot with no rows says nothing about this asset
  const [confirmAck, setConfirmAck] = useState(false);
  const mine = useMemo(() => fleet.filter((e) => e.asset === asset).sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state)), [fleet, asset]);
  const e = mine.find((x) => x.input === params.get('input') && (!params.get('group') || x.group === params.get('group'))) ?? mine[0];
  const info = inventory[asset];
  const [win, setWin] = useState<'6' | '24'>('24');
  const [series, setSeries] = useState<number[]>();
  const [editing, setEditing] = useState(false);
  const [tol, setTol] = useState(900);
  const [busy, setBusy] = useState<string>();
  const [msg, setMsg] = useState<{ ok: boolean; text: string }>();
  const { span, bins } = WINDOWS[win];
  // Clear the chart while a new series loads: reset `series` during render when the asset key or window changes
  // (same trigger as the fetch effect below), instead of calling setSeries synchronously inside that effect.
  const seriesFor = `${e?.key}\u0000${span}`;
  const [prevSeriesFor, setPrevSeriesFor] = useState(seriesFor);
  if (prevSeriesFor !== seriesFor) { setPrevSeriesFor(seriesFor); if (e) setSeries(undefined); }

  useEffect(() => { if (!e) return;
    entitySeries(settings, e, span, bins).then(setSeries).catch(() => setSeries(new Array(bins).fill(0))); }, [e?.key, span]); // eslint-disable-line
  useEffect(() => { if (e) setTol(e.tolerance_s || 900); }, [e?.key, e?.tolerance_s]); // eslint-disable-line

  if (!e) return (<Page timed crumbs={[{ label: 'Assets', to: '/assets' }, { label: asset }]} description={`Not seen ${phrase}`}>
    <div className="span-12">{loading && !updatedAt ? <Skeleton /> : gap
      ? <EmptyState title={gap.title} description={gap.description} size="md">{gap.cta}</EmptyState>
      : <EmptyState title={`${asset} has not sent anything ${phrase}`} description="It may have been retired, renamed, or Pulse is not deployed on its source." size="md" />}</div></Page>);

  const why = diagnose(e, fleet, settings.learning);
  const siblings = fleet.filter((x) => x.group === e.group && x.input === e.input && x.key !== e.key)
    .sort((a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) || a.asset.localeCompare(b.asset));
  const health = ledger ? healthOf(e, ledger[e.key], hw) : undefined;
  const ruleTol = ruleTolerance(e.gap_s, settings.learning);

  async function act(kind: 'mute' | 'unmute' | 'threshold' | 'reset' | 'ack', hours?: number) {
    setBusy(kind); setMsg(undefined);
    const k = { input: e!.input, asset: e!.asset };
    try {
      const change: OverrideChange = kind === 'unmute' || kind === 'reset' ? { ...k, remove: true }
        : kind === 'ack' ? ackOverride(e!)
          : kind === 'mute' ? { ...k, action: 'mute', max_gap_s: 0, until: hours ? new Date(Date.now() + hours * 36e5).toISOString() : undefined }
            : { ...k, action: 'threshold', max_gap_s: tol };
      await setOverride(change);
      // T3: shown at once from the row's own fields; no recompute (the entity search is a ~50 CPU-s 24 h read).
      applyOverride(change);
      setMsg({ ok: true, text: { mute: `Muted${hours ? ` for ${hours} h` : ''}.`, unmute: 'Unmuted.', threshold: `Tolerance set to ${fmtDur(tol)}.`, reset: 'Back to the learned rule.', ack: 'Acknowledged until it sends again (a day at most).' }[kind] + ` Published to lookup pulse_overrides. ${NEXT_CYCLE}` });
    } catch (err) { setMsg({ ok: false, text: err instanceof Error ? err.message : String(err) }); }
    finally { setBusy(undefined); }
  }

  return (
    <Page timed crumbs={[{ label: 'Worker groups', to: '/groups' }, { label: e.group, to: groupPath(e.group) }, { label: srcName(e.input), to: groupPath(e.group, e.input) }, { label: asset }]}
      description={[info?.team ?? 'No owner set', info?.environment, info?.location, info?.cluster ? `HA cluster ${info.cluster}` : ''].filter(Boolean).join(' · ')}
      actions={<div className="row">
        {e.state === 'missing' && <Button variant="secondary" size="sm" pending={busy === 'ack'} onClick={() => setConfirmAck(true)}>Acknowledge</Button>}
        {e.state === 'acked' && <Button variant="secondary" size="sm" pending={busy === 'unmute'} onClick={() => void act('unmute')}>Remove acknowledgement</Button>}
        {e.state === 'muted' ? <Button variant="secondary" size="sm" pending={busy === 'unmute'} onClick={() => void act('unmute')}>Unmute</Button>
          : <Button variant="secondary" size="sm" pending={busy === 'mute'} onClick={() => void act('mute', 4)}>Mute 4 h</Button>}
        <Button variant="secondary" size="sm" onClick={() => nav(`/settings/thresholds?asset=${encodeURIComponent(e.key)}`)}>Tune threshold</Button>
        <Button variant="primary" size="sm" onClick={() => setEditing(true)}>Edit asset info</Button></div>}>

      {msg && <div className="span-12"><Alert appearance={msg.ok ? 'success' : 'danger'} title={msg.ok ? 'Saved' : 'Failed'}>{msg.text}</Alert></div>}
      <Metric label="Silent for" value={fmtDur(e.silent_s)} hint={`last event ${formatClock(e.last_seen, scope.tz)}`} />
      <Metric label="Learned cadence" value={`every ${fmtDur(e.gap_s)}`} hint={`${e.events.toLocaleString()} events, ${phrase}`} />
      <Metric label="Tolerance" value={fmtDur(e.tolerance_s)} hint={e.overridden ? 'override' : `${settings.learning.K} × cadence, clamped`} />
      <Metric label={withRange('Available', scope)} value={health ? fmtPct(health.availability) : EMPTY_CELL_PLACEHOLDER} hint={health ? `${health.incidents} incident${health.incidents === 1 ? '' : 's'}` : undefined} />

      <Section title={e.state === 'missing' ? 'Why it is missing' : e.state === 'late' ? 'Why it is late' : e.state === 'delayed' ? 'Why it is delayed' : 'Status'}
        description={`Sends to ${srcName(e.input)} on ${e.group}, identified by ${e.key_src ? describeRule(e.key_src) : 'the host field (pack older than 1.2)'}`}
        action={<div className="row"><StateTag state={e.state} /><CritTag info={info} showUnset /><SignalTag signal={e.signal} /></div>}
        stats={e.lag_now_s > 0 ? [{ label: 'Event lag now', value: fmtDur(e.lag_now_s) }] : undefined}>
        <div className="row"><Copilot size="sm" /><Text>{why.headline}</Text></div>
      </Section>

      <Section span={8} incomplete={!!truncated?.activity} title="Activity" description={`events per ${span / 60} min · shaded = silence (red when longer than the tolerance)`}
        action={<ToggleButtonGroup size="sm" aria-label="Window" disallowEmptySelection selectedKeys={new Set([win])} onSelectionChange={(k) => setWin([...k][0] as '6' | '24')}
          items={['6', '24'].map((k) => ({ key: k, text: `${k} h` }))} />} loading={!series}>
        {series && !series.some((v) => v > 0) && <span className="muted no-events">{noEventsText(e.silent_s)}</span>}
        {series && series.some((v) => v > 0) && <ActivityChart values={series} span={span} end={seriesEnd(span)} tolerance={e.tolerance_s} />}</Section>

      <Section span={4} title="Asset info" description="set by you, rarely changes"
        action={<Button variant="tertiary" size="sm" onClick={() => setEditing(true)}>Edit</Button>}>
        {!info ? <div className="stack-sm"><Text color="subtle">Nobody has described this asset yet. Add an owner and a criticality so alerts reach the right team and P1s rank first.</Text>
          <div><Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Add asset info</Button></div></div>
          : <dl className="kv">
            <dt>Criticality</dt><dd>{info.criticality ? CRIT[critOf(info)].long : EMPTY_CELL_PLACEHOLDER}</dd>
            <dt>Owning team</dt><dd>{info.team || EMPTY_CELL_PLACEHOLDER}</dd><dt>Contact</dt><dd>{info.contact || EMPTY_CELL_PLACEHOLDER}</dd>
            <dt>Environment</dt><dd>{info.environment || EMPTY_CELL_PLACEHOLDER}</dd><dt>Location</dt><dd>{info.location || EMPTY_CELL_PLACEHOLDER}</dd>
            <dt>Description</dt><dd>{info.description || EMPTY_CELL_PLACEHOLDER}</dd>
            <dt>Runbook</dt><dd>{info.runbook ? <a className="lk" href={info.runbook} target="_blank" rel="noreferrer">{info.runbook.replace(/^https?:\/\//, '').slice(0, 40)}</a> : EMPTY_CELL_PLACEHOLDER}</dd>
            <dt>Tags</dt><dd>{info.tags || EMPTY_CELL_PLACEHOLDER}</dd></dl>}</Section>

      <Section span={4} title="Checks">
        {why.checks.length ? <ul className="checks">{why.checks.map((c, i) => <li key={i} className={c.ok ? 'ck-ok' : 'ck-bad'}><span aria-hidden>{c.ok ? '✓' : '✕'}</span><span>{c.text}</span></li>)}</ul>
          : <Text color="subtle">{why.headline}</Text>}</Section>

      <Section span={4} title="Same source" description={`${srcName(e.input)}${siblings.length > 12 ? `, 12 most urgent of ${siblings.length}` : ''}`}>
        {siblings.length ? <Table density="compact" appearance="flat" items={rowsOf(siblings.slice(0, 12).map((s) => ({ ...s, id: s.key })), ['asset', 'state', 'spark'])} visibleColumns={vis(['asset', 'state', 'spark'])}
          columns={cols([{ id: 'asset', label: 'Asset', render: (v, s) => <Link className="lk" to={assetPath(s)}>{v}</Link> }, { id: 'state', label: 'State', render: (v) => <StateTag state={v} /> },
            { id: 'spark', label: 'Activity', render: (_, s) => <ActivitySpark values={activity[s.key]} silentS={s.silent_s} width={90} height={20} /> }])} />
          : <Text color="subtle">The only asset on this source.</Text>}</Section>

      <Section span={4} title="Alerting for this asset"><div className="stack-sm">
        <Text color="subtle">The rule gives {fmtDur(ruleTol)} ({settings.learning.K} × {fmtDur(e.gap_s)}, kept between {fmtDur(settings.learning.MIN_GAP)} and {fmtDur(settings.learning.MAX_GAP)}).{e.overridden ? ` An override sets ${fmtDur(e.tolerance_s)}.` : ''}</Text>
        <NumberField label="Tolerance override (seconds)" value={tol} min={60} step={60} onChange={setTol} helperText={`= ${fmtDur(tol)}`} />
        <div className="row"><Button variant="secondary" size="sm" pending={busy === 'threshold'} onClick={() => void act('threshold')}>Save override</Button>
          {e.overridden && <Button variant="tertiary" size="sm" pending={busy === 'reset'} onClick={() => void act('reset')}>Use the rule</Button>}</div>
      </div></Section>

      {mine.length > 1 && <Section title={`${asset} sends to ${mine.length} sources`}>
        <Table density="compact" appearance="flat" items={rowsOf(mine.map((m) => ({ ...m, id: m.key })), ['input', 'group', 'state', 'silent_s', 'spark'])} visibleColumns={vis(['input', 'group', 'state', 'silent_s', 'spark'])}
          columns={cols([{ id: 'input', label: 'Source', render: (v, m) => <Link className="lk" to={assetPath(m)}>{v}</Link> }, { id: 'group', label: 'Worker group' },
            { id: 'state', label: 'State', render: (v) => <StateTag state={v} /> }, { id: 'silent_s', label: 'Silent', render: (v) => fmtDur(v) },
            { id: 'spark', label: 'Activity', render: (_, m) => <ActivitySpark values={activity[m.key]} silentS={m.silent_s} /> }])} /></Section>}

      <AssetInfoDrawer asset={asset} isOpen={editing} onClose={() => setEditing(false)} />
      <Modal isOpen={confirmAck} title={`Acknowledge ${asset}?`} confirmButtonText="Acknowledge" onClose={() => setConfirmAck(false)} onConfirm={() => { setConfirmAck(false); void act('ack'); }}>
        <Text>No more alerts for this silence. It ends on its own when {asset} sends again, or after a day. Pulse updates the lookup pulse_overrides.csv.</Text></Modal>
    </Page>);
}
