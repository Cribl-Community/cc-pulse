import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Breadcrumb, Breadcrumbs, Button, Card, EmptyState, IconButton, PageHeader, Skeleton, TabNav, Tag, Text } from '@capra/core';
import { ArrowTrendDown, ArrowTrendUp, ChevronDown, ChevronUp,ReloadOutlined } from '@capra/icons';
import { barPct, rankedMove, tabFrom, tabHref, useCollapsed } from '../lib/layout';
import { CRIT, critOf, type AssetInfo } from '../lib/inventory';
import { ID_LABEL, type IdHealth } from '../lib/identity';
import { HISTORY_INCOMPLETE, SIGNAL_LABEL, noEventsText, STATE_LABEL, STATE_ORDER, countStates, type AssetState, type Entity, type Signal } from '../lib/model';
import { STATE_COLOR } from '../state';
import { TimeScope } from './TimeScope';
import { useTimeScope } from '../scopeContext';
import { rangeLabel, rangePhrase, type Delta } from '../lib/timescope';

/* Small building blocks shared by every Pulse page. */
export const StateTag = ({ state, label }: { state: AssetState | string; label?: string }) =>
  <span className="nowrap"><Tag size="sm" color={STATE_COLOR[state as AssetState] ?? 'default'}>{label ?? STATE_LABEL[state as AssetState] ?? String(state)}</Tag></span>;
export const SignalTag = ({ signal }: { signal: Signal }) => (signal ? <span className="nowrap"><Tag size="sm" color="highlight">{SIGNAL_LABEL[signal]}</Tag></span> : null);
const ID_COLOR: Record<IdHealth, 'success' | 'info' | 'warning' | 'default'> = { strong: 'success', fallback: 'info', weak: 'warning', source: 'default' };
export const IdTag = ({ health }: { health: IdHealth }) => <span className="nowrap"><Tag size="sm" color={ID_COLOR[health]}>{ID_LABEL[health]}</Tag></span>;

export function CritTag({ info, showUnset }: { info?: AssetInfo & { fromRule?: string }; showUnset?: boolean }) {
  if (!info?.criticality) return showUnset ? <Tag size="sm" color="default">unset</Tag> : <span className="muted">—</span>;
  return <span title={info.fromRule ? `from rule “${info.fromRule}”` : undefined}><Tag size="sm" color={CRIT[critOf(info)].color}>{CRIT[critOf(info)].label}</Tag></span>;
}

export const enc = encodeURIComponent;
export const assetPath = (e: Pick<Entity, 'asset' | 'input' | 'group'>) => `/assets/${enc(e.asset)}?input=${enc(e.input)}&group=${enc(e.group)}`;
export const groupPath = (g: string, source?: string) => `/groups/${enc(g)}${source ? `?source=${enc(source)}` : ''}`;
export const AssetLink = ({ e, children }: { e: Pick<Entity, 'asset' | 'input' | 'group'>; children?: ReactNode }) =>
  <Link className="lk" to={assetPath(e)}>{children ?? e.asset}</Link>;
/** "syslog:in_syslog:tcp" → "in_syslog": the id people recognise from the Sources page. */
export const srcName = (input: string) => input.split(':')[1] ?? input;

export type Crumb = { label: string; to?: string };
export type PageTab = { key: string; name: string };
export type PageProps = {
  /** Page title, drawn at heading size. Defaults to the last crumb. */
  title?: ReactNode;
  /** Breadcrumb trail. Only parents are shown (the last crumb is the title); none on top-level pages. */
  crumbs?: Crumb[];
  /** One-line subtle description. Use it on detail pages only. */
  description?: ReactNode;
  /** @deprecated alias of `description`, kept while pages move to spec 013. */
  sub?: ReactNode;
  /** "Updated hh:mm" plus a refresh button, shown when either is given. */
  updatedAt?: Date | null;
  /** Extra line drawn next to "Updated" (the Overview's Snapshot as of … / Live source line). */
  sourceLine?: ReactNode;
  onRefresh?: () => void;
  refreshing?: boolean;
  /** Page actions (Export when present), drawn between the refresh and the range display. */
  actions?: ReactNode;
  /** Header tabs (Capra TabNav) bound to `?tab=`. Read the active one in the page with `useTab`. */
  tabs?: PageTab[];
  defaultTab?: string;
  /** Custom header navigation (e.g. the path-based Settings TabNav). Wins over `tabs`. */
  nav?: ReactNode;
  /** Time-bound page: renders the TimeScope control at the trailing edge of the header. */
  timed?: boolean;
  children: ReactNode;
};

const hhmm = (d: Date) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });


/** Header tabs: Capra TabNav whose links write `?tab=` (other query params are kept). */
export function PageTabs({ tabs, defaultTab }: { tabs: PageTab[]; defaultTab?: string }) {
  const { pathname, search } = useLocation();
  const keys = tabs.map((t) => t.key);
  return <TabNav aria-label="Page sections" activeKey={tabFrom(search, keys, defaultTab)}
    items={tabs.map((t) => ({ key: t.key, name: t.name, href: tabHref(pathname, search, t.key) }))} />;
}

/** Page frame (spec 013 §1): a fixed one-line header band, optional tabs, then the 12-column grid body. */
/** Set inside a host Page (Settings tabs): a nested Page drops its own header band and draws a one-line toolbar. */
const EmbeddedCtx = createContext(false);
/** Hosts whole pages as tab content: their Page renders as a toolbar row plus its body, inside the host's grid. */
export function EmbeddedPage({ children }: { children: ReactNode }) {
  return <EmbeddedCtx.Provider value={true}>{children}</EmbeddedCtx.Provider>;
}

export function Page({ title, crumbs = [], description, sub, updatedAt, sourceLine, onRefresh, refreshing, actions, tabs, defaultTab, nav, timed, children }: PageProps) {
  const embedded = useContext(EmbeddedCtx);
  const { scope: pageScope } = useTimeScope();
  const [nowS0] = useState(() => Date.now() / 1000);
  const past = !!timed && pageScope.latest.trim() !== 'now';
  const pastAlert = past && <div className="span-12"><Alert appearance="info">{`Viewing ${rangeLabel(pageScope, nowS0)}. Asset status is live, as of now.`}</Alert></div>;
  const heading = title ?? crumbs[crumbs.length - 1]?.label;
  const parents = title === undefined ? crumbs.slice(0, -1) : crumbs;
  const desc = description ?? sub;
  const updated = (updatedAt || onRefresh) && <span className="page-updated">
    {updatedAt && <Text variant="body-sm-normal" color="subtle">Updated {hhmm(updatedAt)}</Text>}
    {updatedAt && sourceLine}
    {onRefresh && <IconButton icon={ReloadOutlined} aria-label="Refresh" variant="tertiary" size="sm" pending={refreshing} onClick={() => onRefresh()} />}</span>;
  if (embedded) return (<>
    <div className="span-12 page-embedded">
      {desc ? <Text variant="body-sm-normal" color="subtle" FORCE__className="page-desc">{desc}</Text> : <span />}
      {(updated || actions) && <div className="page-actions">{updated}{actions}</div>}</div>
    {children}
  </>);
  return (<>
    <div className="page-band">
      <PageHeader
        breadcrumbs={<div className="title">
          {parents.length > 0 && <Breadcrumbs>{parents.map((c, i) => <Breadcrumb key={i} href={c.to} isDisabled={false}>{c.label}</Breadcrumb>)}</Breadcrumbs>}
          <Text as="h1" variant="heading-sm" FORCE__className="page-title">{heading}</Text>
          {desc && <Text variant="body-sm-normal" color="subtle" FORCE__className="page-desc">{desc}</Text>}</div>}
        actions={<div className="page-actions">
          {updated}
          {actions}
          {timed && <TimeScope />}</div>}
        navigation={nav ?? (tabs?.length ? <PageTabs tabs={tabs} defaultTab={defaultTab} /> : undefined)} />
    </div>
    <div className="page-body grid">{pastAlert}{children}</div>
  </>);
}

/* ---------- Metric (spec 013 §3) ---------- */
export type MetricTag = { label: string; color?: 'danger' | 'warning' | 'success' | 'info' | 'default' };
export type MetricProps = {
  label: ReactNode;
  /** Always drawn in the default foreground: severity goes in `tag`, never in the number. */
  value: ReactNode;
  hint?: ReactNode;
  span?: number;
  loading?: boolean;
  /** Top-right state Tag, e.g. { label: '2 missing', color: 'danger' }. */
  tag?: MetricTag;
  /** Top-right delta Tag (spec 014 §5): the result of timescope `delta()`. undefined leaves the slot empty. */
  delta?: Delta;
  /** Names the comparison ('vs previous 6 h'); appended to the hint only while a delta shows. */
  deltaHint?: string;
  /** Turns the whole card into a link to a filtered view. */
  to?: string;
};

/** good → success, bad → danger, flat → default; the icon follows `dir` (none when flat). */
function deltaTagProps(d: Delta): { color: 'success' | 'danger' | 'default'; icon?: typeof ArrowTrendUp } {
  if (d.dir === 'flat') return { color: 'default' };
  return { color: d.good ? 'success' : 'danger', icon: d.dir === 'up' ? ArrowTrendUp : ArrowTrendDown };
}

export function Metric({ label, value, hint, span = 3, loading, tag, delta, deltaHint, to }: MetricProps) {
  const d = loading ? undefined : delta;
  const deltaTag = d ? <Tag size="sm" {...deltaTagProps(d)}>{d.text}</Tag> : null;
  const stateTag = tag ? <Tag size="sm" color={tag.color ?? 'default'}>{tag.label}</Tag> : null;
  const shownHint = d && deltaHint ? (hint ? <>{hint} · {deltaHint}</> : deltaHint) : hint;
  const body = (<>
    <span className="metric-head"><Text variant="body-sm-normal" color="subtle">{label}</Text>
      {(deltaTag || stateTag) && <span className="metric-corner">{stateTag}{deltaTag}</span>}</span>
    {loading ? <Skeleton title={false} paragraph={{ rows: 1 }} /> : <span className="metric-val">{value}</span>}
    {shownHint && <Text variant="body-xs-normal" color="subtle">{shownHint}</Text>}
  </>);
  return to
    ? <Link to={to} className={`metric metric-link span-${span}`}>{body}</Link>
    : <div className={`metric span-${span}`}>{body}</div>;
}

/* ---------- Section (spec 013 §4) ---------- */
export type SectionStat = { label: ReactNode; value: ReactNode };
export type SectionEmpty = boolean | { title: string; description?: string; cta?: ReactNode };
export type SectionProps = {
  /** Stable id. With `collapsible`, the collapsed state persists in KV at ui/collapsed/<id>. */
  id?: string;
  span?: number;
  title?: ReactNode;
  /** One line under the title. */
  description?: ReactNode;
  /** Right side of the header: links, ToggleButtonGroup… (the Hide/Show button goes after it). */
  action?: ReactNode;
  collapsible?: boolean;
  defaultCollapsed?: boolean;
  /** Mini-stat row drawn under the header, before the children. */
  stats?: SectionStat[];
  loading?: boolean;
  /** A history series hit its row limit: shows 'History incomplete for this range — narrow it'. */
  incomplete?: boolean;
  /** `true` → centred subtle "No data"; an object → EmptyState with an optional CTA. */
  empty?: SectionEmpty;
  /** This section's query failed: an inline Alert replaces the body. The rest of the page still renders. */
  error?: unknown;
  /** Re-runs only this section's query. */
  onRetry?: () => void;
  className?: string;
  children?: ReactNode;
};

const errText = (e: unknown) => (e instanceof Error ? e.message : typeof e === 'string' ? e : 'The query for this section failed.');

/** Hook-free Section markup; `Section` adds the persisted collapse state. */
export function SectionView({ span = 12, title, description, action, collapsible, collapsed = false, onToggle, stats, loading, incomplete, empty, error, onRetry, className = '', children }:
  Omit<SectionProps, 'id' | 'defaultCollapsed'> & { collapsed?: boolean; onToggle?: (collapsed: boolean) => void }) {
  const toggle = collapsible
    ? <Button variant="tertiary" size="sm" trailingIcon={collapsed ? ChevronDown : ChevronUp} aria-expanded={!collapsed} onClick={() => onToggle?.(!collapsed)}>{collapsed ? 'Show' : 'Hide'}</Button>
    : null;
  const hasHeader = title || description || action || toggle;
  let body: ReactNode;
  if (error) body = <Alert layout="inline" appearance="danger" title="Couldn't load this section" action={onRetry ? { label: 'Retry', onClick: () => onRetry() } : undefined}>{errText(error)}</Alert>;
  else if (loading) body = <Skeleton active title={false} paragraph={{ rows: 4 }} />;
  else if (empty) body = empty === true
    ? <div className="section-empty"><Text color="subtle">No data</Text></div>
    : <EmptyState title={empty.title} description={empty.description}>{empty.cta}</EmptyState>;
  else body = <>{stats?.length ? <div className="section-stats">{stats.map((s, i) =>
    <div key={i} className="section-stat"><Text variant="body-sm-normal" color="subtle">{s.label}</Text><span className="section-stat-val">{s.value}</span></div>)}</div> : null}{children}</>;
  return (<div className={`section span-${span} ${className}`}><Card className="section-card">
    {hasHeader && <Card.Header>{title && <Card.Title>{title}</Card.Title>}{description && <Card.Description>{description}</Card.Description>}
      {(action || toggle) && <Card.Action>{action}{toggle}</Card.Action>}</Card.Header>}
    {!(collapsible && collapsed) && <Card.Content>{incomplete && !error && !loading && <Text variant="body-xs-normal" color="warning" FORCE__className="history-incomplete">{HISTORY_INCOMPLETE}</Text>}{body}</Card.Content>}</Card></div>);
}

export function Section({ id, collapsible, defaultCollapsed = false, ...rest }: SectionProps) {
  const [collapsed, setCollapsed] = useCollapsed(collapsible ? id : undefined, defaultCollapsed);
  return <SectionView {...rest} collapsible={collapsible} collapsed={collapsible ? collapsed : false} onToggle={setCollapsed} />;
}

/** Proportional state mix, with a 2px gap between segments. */
export function StackBar({ list }: { list: Entity[] }) {
  const c = countStates(list);
  return <div className="stackbar" role="img" aria-label={STATE_ORDER.filter((s) => c[s]).map((s) => `${c[s]} ${STATE_LABEL[s]}`).join(', ')}>
    {STATE_ORDER.filter((s) => c[s]).map((s) => <i key={s} className={`st-${s}`} style={{ flexGrow: c[s] }} title={`${c[s]} ${STATE_LABEL[s]}`} />)}</div>;
}

/** Activity sparkline over the range. Zero bins after the first event are drawn as red "silence" ticks. */
export function Spark({ values, width = 120, height = 24, label }: { values?: number[]; width?: number; height?: number; label?: string }) {
  if (!values?.length) return <span className="muted">—</span>;
  const max = Math.max(1, ...values), bw = width / values.length, first = values.findIndex((v) => v > 0);
  return (<svg className="spark-svg" width={width} height={height} role="img" aria-label={label ?? 'Activity'}>
    {values.map((v, i) => v > 0
      ? <rect key={i} className="spark-bar" x={i * bw} y={height - Math.max(2, (v / max) * height)} width={Math.max(bw - 1, 1)} height={Math.max(2, (v / max) * height)} rx={1} />
      : first >= 0 && i > first ? <rect key={i} className="spark-gap" x={i * bw} y={height - 2} width={Math.max(bw - 1, 1)} height={2} /> : null)}
  </svg>);
}

/** Spark that says so when the range holds no events (zero rows), instead of an empty chart. */
export function ActivitySpark({ values, silentS, ...rest }: { values?: number[]; silentS?: number; width?: number; height?: number; label?: string }) {
  if (values && values.length > 0 && !values.some((v) => v > 0)) return <span className="muted no-events">{noEventsText(silentS)}</span>;
  return <Spark values={values} {...rest} />;
}

export const Legend = ({ items }: { items: { cls: string; label: string }[] }) =>
  <div className="legend">{items.map((i) => <span key={i.label}><i className={i.cls} />{i.label}</span>)}</div>;

/* ---------- Question card (spec 013 §5) ---------- */
export type QuestionProps = {
  /** The question, drawn as the card title ("Who stopped sending?"). */
  question: ReactNode;
  /** Headline number. */
  value: ReactNode;
  /** Unit word after the value ("assets"). */
  unit?: ReactNode;
  /** Range series for the sparkline (Pulse Spark). */
  spark?: number[];
  /** The top item, drawn as a Tag. */
  top?: string;
  /** The drill the View button opens (a filtered list or a tab). */
  to: string;
  span?: number;
  loading?: boolean;
};

/** Hook-free Question markup; `onView` runs when View is clicked. */
export function QuestionView({ question, value, unit, spark, top, to, span = 4, loading, onView, phrase = 'in range' }: QuestionProps & { onView: (to: string) => void; phrase?: string }) {
  return (<div className={`question span-${span}`}>
    <span className="question-title"><Text variant="body-md-semibold">{question}</Text></span>
    {loading ? <Skeleton title={false} paragraph={{ rows: 1 }} /> : (<>
      <span className="question-head">
        <span className="question-val"><span className="metric-val">{value}</span>{unit && <Text variant="body-sm-normal" color="subtle">{unit}</Text>}</span>
        <span className="question-spark"><Spark values={spark} label={typeof question === 'string' ? `${question} — ${phrase}` : undefined} /></span>
      </span>
      <span className="question-foot">
        <span className="question-top">{top ? <Tag size="sm" color="default">{top}</Tag> : null}</span>
        <Button variant="secondary" size="sm" onClick={() => onView(to)}>View</Button>
      </span>
    </>)}
  </div>);
}

export function Question(props: QuestionProps) {
  const navigate = useNavigate();
  const { scope } = useTimeScope();
  return <QuestionView {...props} phrase={rangePhrase(scope)} onView={(to) => { void navigate(to); }} />;
}

/* ---------- Ranked list and Drill (spec 013 §6) ---------- */
export type RankedRow = { key: string; name: ReactNode; sub?: ReactNode; value: number; display?: ReactNode };
export type RankedProps = {
  rows: RankedRow[];
  /** Key of the selected row: drawn on the accent background. */
  activeKey?: string;
  onSelect?: (row: RankedRow) => void;
  label?: string;
  /** Bars are scaled to this; defaults to the largest row value. */
  max?: number;
};

/** Hook-free Ranked markup: `focus` is the roving-tabindex row, `onFocusRow` moves it. */
export function RankedView({ rows, activeKey, onSelect, label = 'Ranked list', max, focus = 0, onFocusRow, rowRef }:
  RankedProps & { focus?: number; onFocusRow?: (i: number) => void; rowRef?: (i: number, el: HTMLButtonElement | null) => void }) {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value));
  const onKey = (i: number, row: RankedRow) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect?.(row); return; }
    const next = rankedMove(e.key, i, rows.length);
    if (next !== null) { e.preventDefault(); onFocusRow?.(next); }
  };
  return (<div className="ranked" role="list" aria-label={label}>
    {rows.map((r, i) => {
      const active = r.key === activeKey;
      return (<div role="listitem" key={r.key}>
        <button type="button" ref={rowRef ? (el) => rowRef(i, el) : undefined} className={`ranked-row${active ? ' ranked-active' : ''}`}
          aria-current={active ? 'true' : undefined} tabIndex={i === focus ? 0 : -1}
          onClick={() => { onFocusRow?.(i); onSelect?.(r); }} onKeyDown={onKey(i, r)} onFocus={() => { if (i !== focus) onFocusRow?.(i); }}>
          <span className="ranked-line">
            <span className="ranked-text"><span className="ranked-name">{r.name}</span>{r.sub && <span className="ranked-sub">{r.sub}</span>}</span>
            <span className="ranked-val">{r.display ?? r.value}</span>
          </span>
          <span className="ranked-track" aria-hidden="true"><span className="ranked-bar" style={{ width: `${barPct(r.value, top)}%` }} /></span>
        </button>
      </div>);
    })}
  </div>);
}

export function Ranked(props: RankedProps) {
  const activeIndex = props.rows.findIndex((r) => r.key === props.activeKey);
  const [focus, setFocus] = useState(activeIndex >= 0 ? activeIndex : 0);
  const [moved, setMoved] = useState(false);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const at = Math.min(focus, Math.max(props.rows.length - 1, 0));
  useEffect(() => { if (moved) refs.current[at]?.focus(); }, [at, moved]);
  return <RankedView {...props} focus={at} onFocusRow={(i) => { setMoved(true); setFocus(i); }} rowRef={(i, el) => { refs.current[i] = el; }} />;
}

export type DrillProps = RankedProps & {
  /** The detail for the active row; it fades in (140 ms) each time the selection changes. */
  detail: ReactNode;
  className?: string;
};

/** Ranked list (span 4) beside its detail pane (span 8); stacks below 1100 px. */
export function Drill({ detail, className = '', ...ranked }: DrillProps) {
  return (<div className={`drill span-12 ${className}`}>
    <div className="drill-list"><Ranked {...ranked} /></div>
    <div className="drill-detail" key={ranked.activeKey ?? ''} aria-live="polite">{detail}</div>
  </div>);
}
