import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Alert, Button, EmptyState, SelectField, Skeleton, Text } from '@capra/core';
import { GapReplay, ToleranceScatter, alertsFor, gapsFrom, useLabPoints, type Gap, type Rule } from '../components/charts';
import { AssetLink, Page, Section, StateTag } from '../components/ui';
import { critOf } from '../lib/inventory';
import { useLiveRule } from '../lib/liveRule';
import { fmtDur, type AssetState } from '../lib/model';
import { entitySeries, seriesEnd } from '../lib/series';
import { saveSettings } from '../lib/settings';
import { usePulse } from '../state';
import { useTimeScope } from '../scopeContext';
import { rangePhrase } from '../lib/timescope';

/** Range input + live value. Capra has no slider, so this is a native range styled with tokens in App.css. */
function Slider({ label, value, min, max, step, fmt, live, onChange, log }: { label: string; value: number; min: number; max: number; step: number; fmt: (v: number) => string; live: number; onChange: (v: number) => void; log?: boolean }) {
  const toPos = (v: number) => (log ? Math.log(v / min) / Math.log(max / min) * 1000 : v);
  const fromPos = (p: number) => { if (!log) return p; const v = min * Math.pow(max / min, p / 1000); return Math.max(min, Math.round(v / step) * step); };
  return (<label className="slider">
    <span className="slider-top"><Text variant="body-sm-semibold">{label}</Text><span><b>{fmt(value)}</b>{value !== live && <Text variant="body-xs-normal" color="subtle"> (live {fmt(live)})</Text>}</span></span>
    <input type="range" min={log ? 0 : min} max={log ? 1000 : max} step={log ? 1 : step} value={toPos(value)} onChange={(ev) => onChange(fromPos(Number(ev.target.value)))} />
  </label>);
}
const delta = (a: number, b: number) => (a === b ? null : <span className={a > b ? 'up' : 'dn'}>{a > b ? '+' : '−'}{Math.abs(a - b)}</span>);

export function Thresholds() {
  const { fleet, settings, setSettings, inventory, loading, error, updatedAt, refresh } = usePulse();
  const [params, setParams] = useSearchParams();
  const nav = useNavigate();
  const phrase = rangePhrase(useTimeScope().scope);
  const live: Rule = { K: settings.learning.K, MIN_GAP: settings.learning.MIN_GAP, MAX_GAP: settings.learning.MAX_GAP };
  const { rule, setRule, dirty } = useLiveRule(live);
  const [scope, setScope] = useState('*');
  const [saved, setSaved] = useState(false);

  const groups = [...new Set(fleet.map((e) => e.group))].sort();
  const all = useLabPoints(fleet, rule, live);
  const points = all.filter((p) => scope === '*' || (scope === 'p1' ? critOf(inventory[p.e.asset]) === 1 : p.e.group === scope));
  const count = (s: AssetState, k: 'now' | 'next') => points.filter((p) => p[k] === s).length;
  const changed = points.filter((p) => p.now !== p.next);

  const selKey = params.get('asset') ?? undefined;
  const sel = all.find((p) => p.e.key === selKey) ?? [...points].sort((a, b) => b.e.silent_s / b.tol - a.e.silent_s / a.tol)[0];
  const [gaps, setGaps] = useState<Record<string, Gap[]>>({});
  const [replayAll, setReplayAll] = useState<{ done: number; total: number }>();
  const loadGaps = async (key: string) => { const p = all.find((x) => x.e.key === key); if (!p || gaps[key]) return;
    const s = await entitySeries(settings, p.e, 60, 1440); setGaps((g) => ({ ...g, [key]: gapsFrom(s, seriesEnd(60)) })); };
  useEffect(() => { if (sel) void loadGaps(sel.e.key).catch(() => undefined); }, [sel?.e.key]); // eslint-disable-line

  async function replayEverything() {
    const todo = points.filter((p) => !gaps[p.e.key]).slice(0, 40); setReplayAll({ done: 0, total: todo.length });
    for (let i = 0; i < todo.length; i += 4) {
      await Promise.all(todo.slice(i, i + 4).map((p) => loadGaps(p.e.key).catch(() => undefined)));
      setReplayAll({ done: Math.min(i + 4, todo.length), total: todo.length });
    }
  }
  const replayed = points.filter((p) => gaps[p.e.key]);
  const alertsNew = replayed.reduce((n, p) => n + alertsFor(gaps[p.e.key], p.tol), 0), alertsLive = replayed.reduce((n, p) => n + alertsFor(gaps[p.e.key], p.liveTol), 0);

  async function apply() {
    const s = { ...settings, learning: { ...settings.learning, ...rule } }; setSettings(s); await saveSettings(s); setSaved(true);
  }
  const selGaps = sel && gaps[sel.e.key];

  return (
    <Page crumbs={[{ label: 'Thresholds' }]} sub="Preview the effect of a rule before it goes live — nothing changes until you save"
      actions={<div className="row"><Button variant="secondary" size="sm" disabled={!dirty} onClick={() => setRule(live)}>Reset to live</Button>
        <Button variant="primary" size="sm" disabled={!dirty} onClick={() => void apply()}>Save rule</Button></div>}>
      {saved && !dirty && <div className="span-12"><Alert appearance="success" title="Rule saved">Pulse pages use it now. The scheduled alert searches still run the previous rule until you re-apply alerting.
        <div className="row" style={{ marginTop: 8 }}><Button size="sm" variant="secondary" onClick={() => nav('/settings/setup')}>Re-apply alerting →</Button></div></Alert></div>}

      <Section span={3} title="Rule"><div className="stack">
        <Slider label="K × learned gap" value={rule.K} min={1} max={10} step={0.5} live={live.K} fmt={(v) => `${v} ×`} onChange={(K) => setRule({ ...rule, K })} />
        <Slider label="Minimum tolerance" value={rule.MIN_GAP} min={60} max={3600} step={60} live={live.MIN_GAP} fmt={fmtDur} log onChange={(MIN_GAP) => setRule({ ...rule, MIN_GAP: Math.min(MIN_GAP, rule.MAX_GAP) })} />
        <Slider label="Maximum tolerance" value={rule.MAX_GAP} min={900} max={172800} step={900} live={live.MAX_GAP} fmt={fmtDur} log onChange={(MAX_GAP) => setRule({ ...rule, MAX_GAP: Math.max(MAX_GAP, rule.MIN_GAP) })} />
        <div className="formula"><Text variant="body-xs-normal" color="subtle">tolerance = clamp(K × learned gap, min, max) · late at 60 % · per-asset overrides win</Text></div>
        <SelectField label="Show" value={scope} onChange={(v) => setScope(String(v ?? '*'))}
          items={[{ id: '*', label: 'All assets' }, { id: 'p1', label: 'Critical (P1) only' }, ...groups.map((g) => ({ id: g, label: `Group ${g}` }))]} />
      </div></Section>

      <Section span={6} title="Every asset against the rule" error={error} onRetry={refresh} description="log scales · above the red line = missing · click a dot to replay it" action={<div className="legend"><span><i className="d-missing" />missing</span><span><i className="d-late" />late</span><span><i className="d-ok" />ok</span><span><i className="lg-live" />live rule</span></div>}>{loading && !updatedAt ? <Skeleton /> : points.length
          ? <ToleranceScatter points={points} rule={rule} live={live} selected={sel?.e.key} onSelect={(k) => setParams({ asset: k })} />
          : <EmptyState title="Nothing to tune yet" description="Assets appear here once they leave the learning phase." size="md" />}</Section>

      <div className="span-3 stack"><Section title="Impact vs live"><div className="impact">
        <div><Text variant="body-xs-normal" color="subtle">Missing now</Text><div className="impact-val">{count('missing', 'next')} {delta(count('missing', 'next'), count('missing', 'now'))}</div></div>
        <div><Text variant="body-xs-normal" color="subtle">Late now</Text><div className="impact-val">{count('late', 'next')} {delta(count('late', 'next'), count('late', 'now'))}</div></div>
        <div><Text variant="body-xs-normal" color="subtle">{`Alerts ${phrase} (replayed)`}</Text>
          {replayed.length ? <div className="impact-val">{alertsNew} {delta(alertsNew, alertsLive)}<Text variant="body-xs-normal" color="subtle"> on {replayed.length}/{points.length} assets</Text></div> : <div className="impact-val muted">—</div>}
          {replayed.length < points.length && <Button size="sm" variant="tertiary" pending={!!replayAll && replayAll.done < replayAll.total} onClick={() => void replayEverything()}>
            {replayAll && replayAll.done < replayAll.total ? `Replaying ${replayAll.done}/${replayAll.total}…` : 'Replay all assets'}</Button>}</div>
      </div></Section>
        <Section title="Changes state">
          {changed.length ? <div className="changes">{changed.map((p) => <div key={p.e.key} className="change"><AssetLink e={p.e} /><span className="row"><StateTag state={p.now} />→<StateTag state={p.next} /></span></div>)}</div>
            : <Text color="subtle">{dirty ? 'No asset changes state right now.' : 'Move a slider to preview.'}</Text>}</Section></div>

      {sel && <Section span={12} title={`Replay · ${sel.e.asset}`} description={`every silence longer than 2 min ${phrase} — bar width = how long, height = log scale`} action={<>{selGaps && <Text>would alert <b>{alertsFor(selGaps, sel.tol)}×</b> <Text color="subtle">(live rule {alertsFor(selGaps, sel.liveTol)}×)</Text></Text>}</>}>{selGaps ? <GapReplay gaps={selGaps} end={seriesEnd(60)} tol={sel.tol} liveTol={sel.liveTol} /> : <Skeleton />}
          <Text variant="body-xs-normal" color="subtle">Learned gap {fmtDur(sel.e.gap_s)} → tolerance {fmtDur(sel.tol)}{sel.e.overridden ? ' (per-asset override — the rule does not apply)' : ''}. Pick another asset by clicking its dot.</Text>
        </Section>}
    </Page>);
}
