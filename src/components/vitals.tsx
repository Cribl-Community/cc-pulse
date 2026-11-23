import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Text } from '@capra/core';
import { getChartTheme } from '@capra/theme/visualizations';
import { installThemeBridge, type HostTheme } from '../host-theme';
import { STATE_LABEL, STATE_ORDER, byUrgency, fmtDur, type AssetState, type Entity } from '../lib/model';
import type { FleetPoint } from '../state';
import { assetPath, srcName } from './ui';
import { formatClock } from '../lib/timefmt';
import { useTimeScope } from '../scopeContext';
import { rangePhrase } from '../lib/timescope';

/* Overview hero (spec 004, mockup A "Vital signs") + the tile wall (from mockup B). */

/** The theme the page starts in (the bridge in main.tsx toggles `body.dark`); later changes arrive via installThemeBridge. */
const startMode = (): HostTheme => (typeof document !== 'undefined' && document.body?.classList.contains('dark') ? 'dark' : 'light');

/** Fleet heartbeat: events per bin over the range as a 1.5 px trace with a 10 % area fill, assets reporting as a dashed line,
 *  and red bands where fewer assets reported than usual. Real data only — no decorative beats.
 *  Series colour comes from Capra's chart theme for the host's light/dark mode; SVG chrome stays on token() CSS. */
export function FleetHeartbeat({ points }: { points: FleetPoint[] }) {
  const scope = useTimeScope().scope, tz = scope.tz, clock = (t: number) => formatClock(t, tz);
  const [mode, setMode] = useState<HostTheme>(startMode);
  useEffect(() => installThemeBridge(setMode), []);
  const trace = useMemo(() => getChartTheme({ palette: 'categorical.observable10', mode }).palette[0], [mode]);
  const W = 1000, H = 150, B = 20, ref = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState<{ i: number; x: number; y: number }>();
  const model = useMemo(() => {
    if (points.length < 3) return undefined;
    const maxE = Math.max(1, ...points.map((p) => p.events)) * 1.12, maxA = Math.max(1, ...points.map((p) => p.assets));
    const sorted = [...points.map((p) => p.assets)].sort((a, b) => a - b), med = sorted[Math.floor(sorted.length / 2)];
    const x = (i: number) => (i / (points.length - 1)) * W, y = (v: number) => H - (v / maxE) * (H - 14), ya = (v: number) => H - (v / maxA) * (H - 30) - 8;
    const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.events).toFixed(1)}`).join('');
    const aline = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${ya(p.assets).toFixed(1)}`).join('');
    // Drops: consecutive bins with fewer assets than the median. The last bin is partial (Lake roll), so it never starts a drop.
    const drops: { from: number; to: number; lost: number }[] = [];
    // A drop must lose at least 2% of the usual assets (and 1) for 10 minutes, so per-bin jitter does not paint bands.
    const floor = med - Math.max(1, Math.ceil(med * 0.02));
    for (let i = 0; i < points.length - 1; i++) {
      if (points[i].assets > floor) continue;
      let j = i; while (j + 1 < points.length - 1 && points[j + 1].assets <= floor) j++;
      if (j > i || j >= points.length - 3) drops.push({ from: i, to: j, lost: med - Math.min(...points.slice(i, j + 1).map((p) => p.assets)) });
      i = j;
    }
    return { x, y, line, aline, drops, med };
  }, [points]);
  if (!model) return <div className="c-wrap" style={{ height: H + B }}><div className="c-empty muted">The fleet heartbeat appears once Pulse has a few minutes of data.</div></div>;
  const { x, y, line, aline, drops, med } = model, last = points.length - 1, lastDrop = drops[drops.length - 1];
  const move = (ev: React.PointerEvent) => { const r = ref.current!.getBoundingClientRect(); const i = Math.max(0, Math.min(last, Math.round(((ev.clientX - r.left) / r.width) * last)));
    setHov({ i, x: Math.min(ev.clientX - r.left + 12, r.width - 200), y: ev.clientY - r.top + 12 }); };
  return (
    <div className="c-wrap" ref={ref} onPointerMove={move} onPointerLeave={() => setHov(undefined)}>
      <svg viewBox={`0 0 ${W} ${H + B}`} width="100%" role="img" aria-label={`Events and assets reporting across the fleet, ${rangePhrase(scope)}`}>
        {[0.33, 0.66].map((f) => <line key={f} className="c-grid" x1={0} x2={W} y1={H * f} y2={H * f} />)}
        {drops.map((d) => <rect key={d.from} className="ecg-drop" x={x(d.from)} y={0} width={Math.max(3, x(d.to + 1) - x(d.from))} height={H} />)}
        <path className="ecg-fill" d={`${line}L${W},${H}L0,${H}Z`} fill={trace} fillOpacity={0.1} />
        <path className="ecg-assets" d={aline} />
        <path className="ecg" d={line} stroke={trace} strokeWidth={1.5} />
        {lastDrop && <>
          <line className="ecg-drop-line" x1={x(lastDrop.from)} x2={x(lastDrop.from)} y1={0} y2={H} />
          <text className="ecg-ann" x={x(lastDrop.from) - 6} y={13} textAnchor={x(lastDrop.from) > 160 ? 'end' : 'start'} dx={x(lastDrop.from) > 160 ? 0 : 12}>
            {clock(points[lastDrop.from].t)} · {lastDrop.lost} fewer asset{lastDrop.lost > 1 ? 's' : ''} reporting{lastDrop.to >= last - 1 ? ', still now' : ''}</text></>}
        <circle className="ecg-now" cx={W - 3} cy={y(points[last].events)} r={4} fill={trace} />
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <text key={f} className="c-axis" x={f * W} y={H + 15} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
          {f === 1 ? 'now' : clock(points[Math.round(f * last)].t)}</text>)}
        {hov && <line className="c-cross" x1={x(hov.i)} x2={x(hov.i)} y1={0} y2={H} />}
      </svg>
      {hov && <div className="c-tip" style={{ left: hov.x, top: hov.y }}>
        <b>{clock(points[hov.i].t)}</b><br />{points[hov.i].events.toLocaleString()} events · {points[hov.i].assets} of {med} assets reporting</div>}
    </div>);
}

/** Every asset as a tile, grouped by worker group then source. Click a tile to open the asset. */
export function TileWall({ fleet, groups }: { fleet: Entity[]; groups?: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [hov, setHov] = useState<{ e: Entity; x: number; y: number }>();
  const gs = groups ?? [...new Set(fleet.map((e) => e.group))].sort();
  const tile = fleet.length > 400 ? 11 : fleet.length > 150 ? 13 : 16;
  return (
    <div className="wall c-wrap" ref={ref} onPointerLeave={() => setHov(undefined)} style={{ ['--tile' as string]: `${tile}px` }}>
      {gs.map((g) => { const inG = fleet.filter((e) => e.group === g), srcs = [...new Set(inG.map((e) => e.input))].sort();
        return (<div key={g} className="stack-sm">
          {!groups || groups.length > 1 ? <div className="row"><Text variant="body-sm-semibold">{g}</Text><Text variant="body-xs-normal" color="subtle">{inG.length} assets</Text></div> : null}
          <div className="wall-srcs">{srcs.map((s) => { const l = inG.filter((e) => e.input === s).sort(byUrgency);
            const cols = Math.min(14, Math.max(3, Math.ceil(Math.sqrt(l.length * 2.2))));
            return (<div key={s} className="wall-src"><span className="wall-src-name" title={s}>{srcName(s)}</span>
              <div className="tiles" style={{ gridTemplateColumns: `repeat(${cols}, ${tile}px)` }}>
                {l.map((e) => <Link key={e.key} to={assetPath(e)} className={`tile st-${e.state}`} aria-label={`${e.asset}: ${STATE_LABEL[e.state]}`}
                  onPointerMove={(ev) => { const r = ref.current!.getBoundingClientRect(); setHov({ e, x: Math.min(ev.clientX - r.left + 14, r.width - 230), y: ev.clientY - r.top + 14 }); }}
                  onFocus={() => setHov(undefined)} />)}
              </div></div>); })}</div></div>); })}
      {hov && <div className="c-tip" style={{ left: hov.x, top: hov.y }}>
        <b>{hov.e.asset}</b> · {STATE_LABEL[hov.e.state]}<br /><span className="muted">{srcName(hov.e.input)}</span> · silent {fmtDur(hov.e.silent_s)} of {fmtDur(hov.e.tolerance_s)}</div>}
    </div>);
}

export const WallLegend = () => <div className="legend">{(['missing', 'late', 'covered', 'ok', 'muted'] as AssetState[]).map((s) =>
  <span key={s}><i className={`st-${s}`} style={s === 'ok' ? { opacity: .5 } : undefined} />{s === 'late' ? 'Late or delayed' : s === 'covered' ? 'Covered, acked or learning' : s === 'muted' ? 'Muted or maintenance' : STATE_LABEL[s]}</span>)}</div>;
export { STATE_ORDER };
