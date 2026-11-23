import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Text, ToggleButtonGroup } from '@capra/core';
import { getChartTheme } from '@capra/theme/visualizations';
import { SetupPulseButton } from '../components/SetupPulseButton';
import { useSnapshotGap } from '../components/useSnapshotGap';
import { useHistoryOnOpen } from '../components/useHistoryOnOpen';
import { Drill, Metric, Page, Section, StateTag, assetPath, srcName, type RankedRow } from '../components/ui';
import { installThemeBridge, type HostTheme } from '../host-theme';
import { flappers, healthOf, incidentsOf, type Health, type Ledger, type Incident } from '../lib/history';
import { hourlyByReason, maxHourly, REASON_LABEL, REASONS, type HourBucket, type Reason } from '../lib/incidents';
import { useTab } from '../lib/layout';
import { fmtDur, fmtPct, isLive, type Entity } from '../lib/model';
import type { AppSettings } from '../lib/settings';
import { usePulse } from '../state';
import { useScopeUrlOnMount, useTimeScope } from '../scopeContext';
import { delta, deltaHidden, deltaHint, rangePhrase, withRange } from '../lib/timescope';
import { formatClock, formatDay, formatHour } from '../lib/timefmt';


const TABS = [{ key: 'timeline', name: 'Timeline' }, { key: 'least-available', name: 'Least available' }, { key: 'flapping', name: 'Flapping' }];
const TAB_KEYS = TABS.map((t) => t.key);

/** "What happened": every silence past tolerance in the range, newest first, shared causes merged (spec 009).
 *  Header TabNav (spec 013 §9): Timeline (the hourly chart + feed) · Least available (a Drill) · Flapping, bound to the
 *  URL's ?tab= via Page's `tabs` prop (PageTabs renders the Capra TabNav and useTab reads the active 'tab' here). */
export function Incidents() {
  useScopeUrlOnMount();
  useHistoryOnOpen(); // Economy: opening Incidents is the ask for the gap ledger (spec 033 §5)
  const { fleet, ledger, settings, loading, error, updatedAt, refresh, win } = usePulse();
  const [tab] = useTab(TAB_KEYS, 'timeline');
  const busy = !ledger && loading && !updatedAt;
  const { scope } = useTimeScope(), phrase = rangePhrase(scope);
  const pulse = usePulse(), { incidents: list, availability: avail } = pulse;
  // spec 014 §5: no delta while history loads, without a ledger, or when the ledger was truncated.
  const hide = deltaHidden(pulse), vs = deltaHint(win);
  const incDelta = hide ? undefined : delta(list.length, pulse.prevIncidents.length, 'count');
  const availDelta = hide ? undefined : delta(avail, pulse.prevAvailability, 'ratio');
  const flap = useMemo(() => (ledger ? flappers(fleet, ledger, win) : []), [fleet, ledger, win]);
  const shared = list.filter((i) => i.entities.length > 1).length;

  return (
    <Page timed crumbs={[{ label: 'Incidents' }]} description={`Every silence that went past its tolerance ${phrase}. Silences that started together on one source are merged.`}
      tabs={TABS} defaultTab="timeline">
      <Metric span={3} label={withRange('Incidents', scope)} value={ledger ? list.length : '—'} loading={busy} hint={`${list.filter((i) => i.ongoing).length} still open`}
        delta={incDelta} deltaHint={vs}
        tag={list.some((i) => i.ongoing) ? { label: `${list.filter((i) => i.ongoing).length} open`, color: 'danger' } : undefined} />
      <Metric span={3} label="Shared causes" value={ledger ? shared : '—'} loading={busy} hint="several assets stopped within 2 min" />
      <Metric span={3} label="Flapping assets" value={ledger ? flap.length : '—'} loading={busy} hint="3+ incidents: tolerance probably too tight"
        tag={flap.length ? { label: `${flap.length} flapping`, color: 'warning' } : undefined} />
      <Metric span={3} label={withRange('Availability', scope)} value={avail === undefined ? '—' : fmtPct(avail)} loading={busy} hint="share of time assets were within tolerance"
        delta={availDelta} deltaHint={vs}
        tag={avail !== undefined && avail >= 0.999 ? { label: 'Healthy', color: 'success' } : undefined} />

      {tab === 'timeline' && <Timeline list={list} loading={busy} error={error} onRetry={refresh} />}
      {tab === 'least-available' && <LeastAvailable fleet={fleet} ledger={ledger} loading={busy} error={error} onRetry={refresh} />}
      {tab === 'flapping' && <Flapping flap={flap} settings={settings} loading={busy} error={error} onRetry={refresh} />}
    </Page>);
}

/* ---------- Timeline: "Incidents over <range>" chart + the feed (spec 013 §9) ---------- */
type SectionIO = { loading: boolean; error?: unknown; onRetry: () => void };

function Timeline({ list, loading, error, onRetry }: { list: Incident[] } & SectionIO) {
  const [show, setShow] = useState<'all' | 'open'>('all');
  const cta = usePulse().setup === 'not-deployed' ? <SetupPulseButton /> : undefined;
  const gap = useSnapshotGap(); // R1: rejected snapshot, no rows: no incident list is not "every silence stayed within tolerance"
  const scope = useTimeScope().scope, tz = scope.tz, day = (t: number) => formatDay(t, tz), phrase = rangePhrase(scope);
  const gapsCut = !!usePulse().truncated?.gaps;
  const buckets = useMemo(() => hourlyByReason(list), [list]);
  const shown = list.filter((i) => show === 'all' || i.ongoing);
  const days = [...new Set(shown.map((i) => day(i.start)))];
  return (<>
    <Section id="incidents-hourly" span={12} collapsible incomplete={gapsCut} title={phrase === 'in range' ? 'Incidents in range' : `Incidents over ${phrase.replace('last', 'the last')}`} description="stacked by reason, oldest hour on the left"
      loading={loading} error={error} onRetry={onRetry} empty={!loading && !error && !list.length}>
      <HourlyChart buckets={buckets} />
    </Section>
    <Section span={12} title="What happened" description="newest first" loading={loading} error={error} onRetry={onRetry}
      action={<ToggleButtonGroup size="sm" aria-label="Show" disallowEmptySelection selectedKeys={new Set([show])}
        onSelectionChange={(k) => setShow([...k][0] as 'all' | 'open')} items={[{ key: 'all', text: 'All' }, { key: 'open', text: 'Open' }]} />}
      empty={!loading && !error && !shown.length ? gap ?? { title: show === 'open' ? 'No open incident' : `No incident ${phrase}`, description: 'Every silence stayed within its learned tolerance.', cta } : false}>
      <div className="feed">{days.map((d) => <div key={d}>
        <div className="feed-day">{d}</div>
        {shown.filter((i) => day(i.start) === d).map((i) => <Event key={i.id} i={i} />)}</div>)}</div>
    </Section>
  </>);
}

/** 24 one-hour stacked bars by reason, coloured from the chart theme (spec 013 §8–§9). */
function HourlyChart({ buckets }: { buckets: HourBucket[] }) {
  const phrase = rangePhrase(useTimeScope().scope);
  const tz = useTimeScope().scope.tz, hourLabel = (t: number) => formatHour(t, tz);
  const [mode, setMode] = useState<HostTheme>(() => (typeof document !== 'undefined' && document.body?.classList.contains('dark') ? 'dark' : 'light'));
  useEffect(() => installThemeBridge(setMode), []);
  const palette = useMemo(() => getChartTheme({ palette: 'categorical.observable10', mode }).palette, [mode]);
  const colors = useMemo(() => Object.fromEntries(REASONS.map((r, i) => [r, palette[i]])) as Record<Reason, string>, [palette]);
  const W = 1000, H = 120, slot = W / buckets.length, bw = Math.max(1, slot - 4), max = maxHourly(buckets);
  return (<div className="c-wrap">
    <svg viewBox={`0 0 ${W} ${H + 20}`} width="100%" role="img" aria-label={`Incidents per hour, ${phrase}, stacked by reason`}>
      {buckets.map((b, i) => { let y = H; const x = i * slot + 2;
        return (<g key={b.hour}>{REASONS.map((r) => { const v = b.counts[r]; if (!v) return null;
          const h = Math.max(2, (v / max) * (H - 4)); y -= h;
          return <rect key={r} x={x} y={y} width={bw} height={h} rx={1} fill={colors[r]}><title>{`${hourLabel(b.start)}: ${v} ${REASON_LABEL[r].toLowerCase()}`}</title></rect>; })}
        </g>); })}
      {[0, 6, 12, 18, 23].map((i) => <text key={i} className="c-axis" x={i * slot + bw / 2} y={H + 15} textAnchor="middle">{hourLabel(buckets[i].start)}</text>)}
    </svg>
    <div className="legend">{REASONS.map((r) => <span key={r}><i style={{ background: colors[r] }} />{REASON_LABEL[r]}</span>)}</div>
  </div>);
}

function Event({ i }: { i: Incident }) {
  const tz = useTimeScope().scope.tz, clock = (t: number) => formatClock(t, tz);
  const lead = i.entities[0], many = i.entities.length > 1;
  const names = i.entities.slice(0, 3).map((e) => e.asset).join(', ') + (i.entities.length > 3 ? ` and ${i.entities.length - 3} more` : '');
  return (<div className="feed-ev">
    <time>{clock(i.start)}</time>
    <span className={`feed-dot ${i.ongoing ? 'st-missing' : 'st-ok'}`} />
    <div className="feed-main">
      <Text>{many ? <><b>{i.entities.length} assets</b> stopped together on {srcName(lead.input)}: {names}</> : <><Link className="lk" to={assetPath(lead)}>{lead.asset}</Link> {i.ongoing ? 'went silent' : `was silent for ${fmtDur(i.secs)}`}</>}</Text>
      <Text variant="body-xs-normal" color="subtle">{srcName(lead.input)} on {lead.group}{i.end ? `, recovered at ${clock(i.end)}` : `, silent ${fmtDur(i.secs)} so far`}{many ? '. A shared cause is likely: deploy, network segment or forwarder' : ''}</Text>
    </div>
    {i.ongoing ? <StateTag state={lead.state} /> : <StateTag state="ok" label="Recovered" />}
  </div>);
}

/* ---------- Least available: a Drill (spec 013 §6, §9) ---------- */
type Worst = Entity & { h: Health };

function LeastAvailable({ fleet, ledger, loading, error, onRetry }: { fleet: Entity[]; ledger?: Ledger } & SectionIO) {
  const nav = useNavigate(), { scope } = useTimeScope();
  const { win, truncated } = usePulse(), gapsCut = !!truncated?.gaps;
  const worst = useMemo<Worst[]>(() => (ledger
    ? fleet.filter(isLive).map((e) => ({ ...e, h: healthOf(e, ledger[e.key], win) })).filter((x) => x.h.incidents > 0).sort((a, b) => a.h.availability - b.h.availability)
    : []), [fleet, ledger, win]);
  const [picked, setPicked] = useState<string>();
  const active = worst.find((w) => w.key === picked) ?? worst[0];
  const incidents = useMemo(() => (ledger && active ? incidentsOf(fleet, ledger, win).filter((i) => i.entities.some((e) => e.key === active.key)) : []), [fleet, ledger, active, win]);
  const rows: RankedRow[] = worst.map((w) => ({ key: w.key, name: w.asset, sub: `${srcName(w.input)} · ${w.h.incidents} incident${w.h.incidents === 1 ? '' : 's'}`, value: 1 - w.h.availability, display: fmtPct(w.h.availability) }));

  return (
    <Section id="incidents-least-available" span={12} incomplete={gapsCut} title="Least available" description={`assets ranked by availability gap, ${rangePhrase(scope)}`}
      loading={loading} error={error} onRetry={onRetry} empty={!loading && !error && !worst.length ? { title: 'No asset went past its tolerance.' } : false}>
      <Drill rows={rows} activeKey={active?.key} onSelect={(r) => setPicked(r.key)} label="Assets by availability gap"
        detail={active ? (<div className="stack">
          <div className="row"><Text variant="body-md-semibold">{active.asset}</Text><span className="sp" />
            <Button size="sm" variant="tertiary" onClick={() => nav(assetPath(active))}>Open asset</Button></div>
          <Text variant="body-xs-normal" color="subtle">{srcName(active.input)} on {active.group} · available {fmtPct(active.h.availability)} · {active.h.incidents} incident{active.h.incidents === 1 ? '' : 's'} · longest {fmtDur(active.h.longest_s)}</Text>
          <div className="feed">{incidents.map((i) => <Event key={i.id} i={i} />)}</div>
        </div>) : <Text color="subtle">No asset went past its tolerance.</Text>} />
    </Section>);
}

/* ---------- Flapping (spec 013 §9) ---------- */
function Flapping({ flap, settings, loading, error, onRetry }: { flap: { e: Entity; n: number }[]; settings: AppSettings } & SectionIO) {
  const nav = useNavigate(), { scope } = useTimeScope();
  return (
    <Section id="incidents-flapping" span={12} title="Flapping" description="alerts, recovers, alerts again" loading={loading} error={error} onRetry={onRetry}
      empty={!loading && !error && !flap.length ? { title: 'No flapping asset', description: `No asset crossed its tolerance 3 or more times ${rangePhrase(scope)}.` } : false}>
      <div className="stack-sm">
        {flap.map(({ e, n }) => <div key={e.key} className="row">
          <Link className="lk" to={assetPath(e)}>{e.asset}</Link>
          <Text variant="body-xs-normal" color="subtle">{n} incidents, tolerance {fmtDur(e.tolerance_s)}</Text><span className="sp" />
          <Button size="sm" variant="tertiary" onClick={() => nav(`/settings/thresholds?asset=${encodeURIComponent(e.key)}`)}>Tune</Button></div>)}
        <Text variant="body-xs-normal" color="subtle">The same asset crossing its tolerance again and again usually means K × {settings.learning.K} is too tight for its cadence.</Text>
      </div>
    </Section>);
}
