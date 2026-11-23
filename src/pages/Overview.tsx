import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, CustomTooltipTrigger, EmptyState, Modal, Skeleton, Text, Tooltip } from '@capra/core';
import { Copilot } from '@capra/icons';
import { AskBar } from '../components/AskBar';
import { PlanRunner } from '../components/PlanRunner';
import { CritTag, Metric, Page, Question, Section, SignalTag, ActivitySpark, StateTag, assetPath, groupPath, srcName } from '../components/ui';
import { FleetHeartbeat, TileWall, WallLegend } from '../components/vitals';
import { ackOverride, lookupSteps, setOverride } from '../lib/deploy';
import { sourceIdentity } from '../lib/identity';
import { critOf } from '../lib/inventory';
import { ALARM, countStates, diagnose, fmtDur, fmtPct, isLive, isUp, pressure, type Entity } from '../lib/model';
import { longestSilentMissing, worstSource, worstTeam, UNASSIGNED_TEAM } from '../lib/questions';
import { usePulse } from '../state';
import { installThemeBridge, type HostTheme } from '../host-theme';
import { effectiveRollup } from '../lib/settings';
import { useSetupGuide } from '../lib/setupGuide';
import { useScopeUrlOnMount, useTimeScope } from '../scopeContext';
import { delta, deltaHidden, deltaHint, withRange } from '../lib/timescope';
import { formatTs } from '../lib/timefmt';
import { rollCallDay } from '../lib/cadence';
import { reasonMessage } from '../lib/snapshot';
import { NEXT_CYCLE } from '../lib/overrideApply';

/** Sums several activity series into one, used only to draw a Question card's sparkline. */
function sumSeries(series: (number[] | undefined)[]): number[] | undefined {
  const lists = series.filter((s): s is number[] => !!s?.length);
  if (!lists.length) return undefined;
  const len = Math.max(...lists.map((s) => s.length));
  return Array.from({ length: len }, (_, i) => lists.reduce((sum, s) => sum + (s[i] ?? 0), 0));
}

export function Overview() {
  useScopeUrlOnMount();
  const { fleet, activity, heartbeat, inventory, loading, error, updatedAt, refresh, settings, demo, truncated, setup, newestDeployment } = usePulse();
  const navigate = useNavigate();
  const { openGuide } = useSetupGuide();
  const [theme, setTheme] = useState<HostTheme>(() => (typeof document !== 'undefined' && document.body?.classList.contains('dark') ? 'dark' : 'light'));
  useEffect(() => installThemeBridge(setTheme), []);
  const first = loading && !updatedAt;
  const { scope } = useTimeScope();
  const c = countStates(fleet);
  const live = fleet.filter(isLive), up = live.filter(isUp);
  const [ask, setAsk] = useState<string>();
  const [lookupOpen, setLookupOpen] = useState(false);
  const [ack, setAck] = useState<Entity>();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string>();

  const attention = useMemo(() => fleet.filter((e) => ALARM.includes(e.state))
    .map((e) => ({ e, crit: critOf(inventory[e.asset]), why: diagnose(e, fleet, settings.learning) }))
    .sort((a, b) => ALARM.indexOf(a.e.state) - ALARM.indexOf(b.e.state) || a.crit - b.crit || pressure(b.e) - pressure(a.e)), [fleet, inventory, settings.learning]);
  const p1Missing = attention.filter((a) => a.e.state === 'missing' && a.crit === 1).length;
  const pulse = usePulse(), { availability, stateSource, stateAsOf, stateReason, stateAge } = pulse;
  // Spec 034 F8: the snapshot was rejected → say why, how old it is, and offer the one on-demand compute.
  const isDaily = settings.searchLoad === 'daily';
  const snapshotRejected =!demo && !!stateReason && stateSource !== 'snapshot';
  // The age of the stale rows keeps ticking; `now` is state so render stays pure (react(purity)), as in TimeScope.
  const [nowS, setNowS] = useState(() => Date.now() / 1000);
  useEffect(() => { const t = setInterval(() => setNowS(Date.now() / 1000), 30000); return () => clearInterval(t); }, []);

  // Spec 025: where the asset state comes from, next to "Updated". A reason tooltip explains a live fallback.
  // T2: a rejected snapshot keeps the last rows for this dataset, labelled as such with their age, never as Live.
  const sourceText = stateSource === 'stale' && stateAsOf !== undefined
    ? `From the last snapshot, as of ${formatTs(stateAsOf, scope.tz)} · ${fmtDur(Math.max(0, nowS - stateAsOf))} old`
    : stateSource === 'snapshot' && stateAsOf !== undefined
    ? (isDaily ? `Roll call as of ${formatTs(stateAsOf, scope.tz)} ${rollCallDay(stateAsOf, nowS, scope.tz)} · once a day`
      : `Snapshot as of ${formatTs(stateAsOf, scope.tz)} · ${settings.searchLoad === 'hourly' ? 'hourly' : 'every 5 min'}`) : 'Live';
  const rollupBehind = effectiveRollup(pulse.settings) === 'auto' && pulse.rollupVerdict?.use === false;
  const checkNow = isDaily && !demo
    ? <> <Text variant="body-xs-normal" color="subtle">·</Text> <Tooltip title="Runs one search over 24 h" placement="bottom"><CustomTooltipTrigger>
        <Button variant="tertiary" size="sm" pending={!!pulse.computing} onClick={() => { if (!pulse.computing) void pulse.computeNow(); }}>Check now</Button>
      </CustomTooltipTrigger></Tooltip></> : null;
  const chartsGate = isDaily && !pulse.historyLoaded
    ? <div className="charts-gate"><Text variant="body-xs-normal" color="subtle">Charts read 24 h of raw data: 3 searches.</Text>{' '}
        <Button variant="secondary" size="sm" onClick={() => void pulse.loadCharts()}>Load charts</Button></div> : null;
  const sourceLabel = <><Text variant="body-xs-normal" color="subtle">{sourceText}</Text>{checkNow}
    {rollupBehind && <Text variant="body-xs-normal" color="subtle"> · Rollup behind: reading raw data</Text>}</>;
  const sourceLine = stateReason && stateSource !== 'snapshot'
    ? <Tooltip title={reasonMessage(stateReason)} placement="bottom"><CustomTooltipTrigger><span tabIndex={0}>{sourceLabel}</span></CustomTooltipTrigger></Tooltip>
    : sourceLabel;
  // spec 014 §5: Overview carries the Availability Metric only (013 put no Incidents Metric here).
  const availDelta = deltaHidden(pulse) ? undefined : delta(availability, pulse.prevAvailability, 'ratio');

  // Plain-language headline for the AI summary card: the biggest shared-cause cluster first, then the worst single asset.
  const sentences = useMemo(() => {
    if (!fleet.length) return ['Pulse has no assets to watch yet.'];
    if (!attention.length) return [`All ${up.length} learned assets are reporting${c.covered ? `; ${c.covered} silent asset${c.covered > 1 ? 's are' : ' is'} covered by an HA peer` : ''}.`, 'Nothing needs you right now.'];
    const shared = attention.find((a) => ['shared', 'source', 'group'].includes(a.why.verdict));
    const worst = attention[0];
    const first = `${c.missing} asset${c.missing === 1 ? '' : 's'} missing${c.late + c.delayed ? `, ${c.late + c.delayed} late or delayed` : ''}.`;
    const second = shared ? `${shared.e.asset} ${shared.why.short}.`
      : worst ? `${worst.e.asset}${inventory[worst.e.asset]?.team ? ` (${inventory[worst.e.asset]!.team})` : ''}: ${worst.why.short}.` : undefined;
    return second ? [first, second] : [first];
  }, [attention, fleet.length, up.length, c, inventory]);

  const weakSources = useMemo(() => [...new Set(fleet.map((e) => `${e.group}|${e.input}`))].map((k) => {
    const l = fleet.filter((e) => `${e.group}|${e.input}` === k); return { k, input: l[0].input, id: sourceIdentity(l.map((e) => ({ asset: e.asset, key_src: e.key_src }))) };
  }).filter((s) => s.id.health === 'weak' || s.id.health === 'source'), [fleet]);
  const signals = fleet.filter((e) => e.signal && isLive(e));
  const lookupMissing = !!error && /lookup/i.test(error);

  // Row 3: the three Question cards, derived from the fleet already held in state.tsx (src/lib/questions.ts, unit-tested).
  const q1 = useMemo(() => longestSilentMissing(fleet, inventory), [fleet, inventory]);
  const q2 = useMemo(() => worstSource(fleet), [fleet]);
  const q3 = useMemo(() => worstTeam(fleet, inventory), [fleet, inventory]);
  const q2List = q2 ? fleet.filter((e) => e.group === q2.group && e.input === q2.input) : [];
  const q3List = fleet.filter((e) => ALARM.includes(e.state) && (inventory[e.asset]?.team || UNASSIGNED_TEAM) === q3?.team);

  // Spec 034 §4: shown ahead of everything else, including the not-deployed screen and in place of the "Waiting"
  // Alert: a rejected snapshot leaves the entities empty, so setup alone would hide Compute now.
  // Same Button the Alert builds from { label, onClick } (secondary, sm), plus `pending` while a compute runs.
  const snapshotAlert = snapshotRejected && stateReason ? <div className="span-12">
    <Alert appearance="warning" title="Snapshot not used" action={<Button variant="secondary" size="sm" pending={!!pulse.computing}
      onClick={() => { if (!pulse.computing) void pulse.computeNow(); }}>Compute now</Button>}>
      {reasonMessage(stateReason)}{' '}
      {stateAge !== undefined ? `The last snapshot is ${fmtDur(stateAge)} old.` : 'There is no snapshot yet.'}
    </Alert>
  </div> : null;

  async function doAck() {
    if (!ack) return; setBusy(true);
    try {
      const change = ackOverride(ack);
      await setOverride(change);
      pulse.applyOverride(change); // T3: shown as Acknowledged at once, no recompute
      setMsg(`${ack.asset} acknowledged. It alerts again the next time it goes silent. ${NEXT_CYCLE}`);
    }
    catch (e) { setMsg(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); setAck(undefined); }
  }

  if (setup === 'not-deployed') {
    return (
      <Page crumbs={[{ label: 'Overview' }]} sub="Who stopped sending to your Cribl sources, and why">
        {snapshotAlert}
        <div className="span-12">
          <EmptyState size="lg" illustration="EmptyFolder" theme={theme} title="Pulse isn't watching anything yet" description="Deploy Pulse to a worker group to start learning who sends to your sources.">
            <Button variant="primary" onClick={() => navigate('/settings/setup')}>Set up Pulse</Button>
            <Button variant="tertiary" onClick={openGuide}>What does Pulse do?</Button>
          </EmptyState>
        </div>
      </Page>
    );
  }

  return (
    <Page timed crumbs={[{ label: 'Overview' }]} sub="Who stopped sending to your Cribl sources, and why" updatedAt={updatedAt} sourceLine={sourceLine} onRefresh={() => void refresh()} refreshing={loading}>
      {snapshotAlert}
      {setup === 'waiting' && !snapshotRejected && <div className="span-12">
        <Alert appearance="info" title="Waiting for the first heartbeats" action={{ label: 'Refresh', onClick: () => void refresh() }}>
          {newestDeployment?.group
            ? `Pulse was deployed to ${newestDeployment.group}${newestDeployment.at && Number.isFinite(Date.parse(newestDeployment.at)) ? ` on ${new Date(newestDeployment.at).toLocaleString()}` : ''}. `
            : 'Pulse was deployed. '}
          Heartbeats arrive every 5 minutes, so the first assets should appear shortly.
        </Alert>
      </div>}
      {error && !lookupMissing && <div className="span-12"><Alert appearance="warning" title="Could not load Pulse data">{error}</Alert></div>}
      {lookupMissing && <div className="span-12">
        <Alert appearance="warning" title="Pulse needs its lookups in Cribl Search" action={{ label: 'Set up now', onClick: () => setLookupOpen(true) }}>
          Pulse reads and writes a few lookups (overrides, inventory) that don't exist yet in this instance.
        </Alert>
        <Modal isOpen={lookupOpen} title="Pulse needs its lookups in Cribl Search" onClose={() => setLookupOpen(false)} footer={null}>
          <PlanRunner title="Pulse needs its lookups in Cribl Search" steps={lookupSteps()} onDone={() => { setLookupOpen(false); void refresh(); }} />
        </Modal>
      </div>}
      {demo && <div className="span-12"><Alert appearance="info" title="Demo data">Running outside Cribl, so these assets are made up.</Alert></div>}
      {msg && <div className="span-12"><Alert appearance="info" title="Acknowledgement">{msg}</Alert></div>}

      {/* Row 1: AI summary + the three headline Metrics. */}
      <div className="ai-summary span-6">
        <div className="ai-summary-head"><span className="ai-ico"><Copilot size="sm" /></span><Text as="h2" variant="heading-xs" color="subtle">Summary</Text></div>
        {first ? <Skeleton title={false} paragraph={{ rows: 2 }} /> : sentences.map((s, i) => <Text key={i} variant="body-md-normal">{s}</Text>)}
        <div className="ai-summary-actions">
          <Button variant="primary" leadingIcon={Copilot} onClick={() => setAsk(attention.length ? 'Why are these assets missing, and what should I check first?' : '')}>Ask Pulse</Button>
          <Button variant="secondary" onClick={() => setAsk('Give me a deeper breakdown of what needs attention across the fleet right now.')}>Deeper insights</Button>
        </div>
      </div>
      <Metric span={2} loading={first} label="Reporting now" value={live.length ? `${Math.round((100 * up.length) / live.length)}%` : '—'} hint="now" />
      <Metric span={2} loading={first} label="Missing" value={c.missing} hint="now" tag={p1Missing ? { label: `${p1Missing} P1`, color: 'danger' } : undefined} />
      <Metric span={2} loading={first} label={withRange('Availability', scope)} value={availability === undefined ? '—' : fmtPct(availability)}
        delta={availDelta} deltaHint={deltaHint(pulse.win)} />
      {ask !== undefined && <div className="span-12"><AskBar initial={ask} onClose={() => setAsk(undefined)} /></div>}

      {/* Row 2: the fleet heartbeat, collapsible, with its own mini-stats. */}
      <Section id="overview-heartbeat" span={12} collapsible incomplete={!!truncated?.heartbeat} title="Fleet heartbeat" description="events every 5 minutes across every watched source"
        stats={[{ label: 'Reporting', value: up.length }, { label: 'Missing', value: c.missing }, { label: 'Late or delayed', value: c.late + c.delayed }, { label: 'Covered or acked', value: c.covered + c.acked }]}>
        {chartsGate ?? (heartbeat ? <FleetHeartbeat points={heartbeat} /> : <Skeleton />)}
        {!chartsGate && <div className="legend"><span><i className="lg-beat" />events</span><span><i className="lg-live" />assets reporting</span><span><i className="lg-drop" />fewer assets</span></div>}
      </Section>

      {/* Row 3: the three Question cards. */}
      <Question span={4} loading={first} question="Who stopped sending?" value={q1.count} unit={q1.count === 1 ? 'asset' : 'assets'}
        spark={q1.top ? activity[q1.top.key] : undefined} top={q1.top?.asset} to="/assets?state=missing" />
      <Question span={4} loading={first} question="Which source is losing senders?" value={q2?.count ?? 0} unit={(q2?.count ?? 0) === 1 ? 'sender' : 'senders'}
        spark={sumSeries(q2List.map((e) => activity[e.key]))} top={q2 ? srcName(q2.input) : undefined} to={q2 ? groupPath(q2.group, q2.input) : '/groups'} />
      <Question span={4} loading={first} question="Who owns the gaps?" value={q3?.count ?? 0} unit="open"
        spark={sumSeries(q3List.map((e) => activity[e.key]))} top={q3 ? (q3.team === UNASSIGNED_TEAM ? 'Unassigned' : q3.team) : undefined}
        to={`/assets?team=${encodeURIComponent(q3?.team ?? UNASSIGNED_TEAM)}`} />

      {/* Row 4: Needs attention (flat rows, no stripe) beside the fleet tile wall. */}
      <Section span={7} incomplete={!!truncated?.activity} title="Needs attention" description="missing first, then criticality, then how far past tolerance" action={<Link className="lk" to="/incidents">Incident history</Link>}
        loading={first} empty={!first && attention.length === 0 ? (fleet.length === 0 ? { title: 'No assets yet', description: 'Assets appear here once Pulse receives its first heartbeats.' } : { title: 'Every asset is reporting', description: 'No asset is late, delayed or missing against its learned cadence.' }) : undefined}>
        {chartsGate}
        <div className="attn-list">{attention.slice(0, 12).map(({ e, why }) => (
          <div key={e.key} className="attn-row">
            <div className="attn-main">
              <div className="attn-title"><Link className="lk" to={assetPath(e)}>{e.asset}</Link><StateTag state={e.state} />{inventory[e.asset]?.criticality && <CritTag info={inventory[e.asset]} />}<SignalTag signal={e.signal === 'delayed' && e.state === 'delayed' ? '' : e.signal} /></div>
              <Text variant="body-xs-normal" color="subtle">{srcName(e.input)} on {e.group}, {why.short}{inventory[e.asset]?.team ? `, ${inventory[e.asset]!.team}` : ''}</Text>
            </div>
            <div className="attn-side">
              <ActivitySpark values={activity[e.key]} silentS={e.silent_s} width={130} height={28} />
              <div className="attn-silent"><b>{e.state === 'delayed' ? fmtDur(e.lag_now_s) : fmtDur(e.silent_s)}</b><Text variant="body-xs-normal" color="subtle">{e.state === 'delayed' ? 'behind' : `of ${fmtDur(e.tolerance_s)}`}</Text></div>
              {e.state === 'missing' && <Button size="sm" variant="secondary" onClick={() => setAck(e)}>Ack</Button>}
            </div>
          </div>))}
          {attention.length > 12 && <Link className="lk" to="/assets">{attention.length - 12} more in Assets</Link>}</div>
      </Section>

      <Section span={5} title="Fleet" description={`${fleet.length} assets`} action={<Link className="lk" to="/groups">Worker groups</Link>}
        loading={first} empty={!first && !fleet.length ? { title: 'No worker group sends Pulse heartbeats yet.', cta: <Link className="lk" to="/settings/setup">Open Setup</Link> } : undefined}>
        {chartsGate}
        <div className="stack">{fleet.length ? <TileWall fleet={fleet} /> : null}<WallLegend /></div>
        {(signals.length > 0 || weakSources.length > 0) && <div className="stack-sm" style={{ marginTop: 'var(--spacing-md)' }}>
          {signals.slice(0, 5).map((e) => <div key={e.key} className="row" style={{ minWidth: 0 }}><Link className="lk ellip" to={assetPath(e)}>{e.asset}</Link><span className="sp" /><SignalTag signal={e.signal} /></div>)}
          {weakSources.slice(0, 4).map((s) => <div key={s.k} className="stack-sm"><div className="row" style={{ minWidth: 0 }}><Link className="lk ellip" to={`/identity?source=${encodeURIComponent(s.k)}`}>{srcName(s.input)}</Link><span className="sp" /><Text variant="body-xs-normal" color="subtle">{s.id.health === 'source' ? 'no sender name' : 'unreliable names'}</Text></div></div>)}
          {weakSources.length > 0 && <Link className="lk" to="/identity">Fix asset identity</Link>}
        </div>}
      </Section>

      <Modal isOpen={!!ack} title={`Acknowledge ${ack?.asset ?? ''}?`} confirmButtonText="Acknowledge" onConfirm={() => void doAck()} onClose={() => setAck(undefined)}>
        <Text>No more alerts for this silence. The acknowledgement ends on its own when {ack?.asset} sends again, or after a day, so the next silence alerts normally. Pulse updates the lookup pulse_overrides.csv.</Text>
        {busy && <Skeleton />}
      </Modal>
    </Page>
  );
}
