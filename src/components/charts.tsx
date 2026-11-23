import { useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { fmtDur, stateFor, type AssetState, type Entity } from '../lib/model';
import { StateTag, assetPath } from './ui';
import { formatClock } from '../lib/timefmt';
import { useTimeScope } from '../scopeContext';
import { rangePhrase } from '../lib/timescope';

/* Hand-built SVG charts (Capra ships tokens, not a chart library). Colours come from CSS classes in
   App.css that use token(), so light/dark follow the Cribl shell. */


function Tip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  return <div className="c-tip" style={{ left: x, top: y }}>{children}</div>;
}
/** Tracks the pointer inside a wrapper so a tooltip can sit next to it. */
function useHover<T>() {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState<{ x: number; y: number; d: T }>();
  const move = (ev: React.PointerEvent, d: T) => { const r = ref.current!.getBoundingClientRect(); setH({ x: ev.clientX - r.left + 12, y: ev.clientY - r.top + 12, d }); };
  return { ref, h, move, clear: () => setH(undefined) };
}

/** Silence runs (consecutive zero bins after the first event) with their length in seconds. */
function silenceRuns(values: number[], span: number) {
  const runs: { from: number; to: number; secs: number }[] = []; const first = values.findIndex((v) => v > 0);
  if (first < 0) return runs;
  for (let i = first; i < values.length; i++) {
    if (values[i] > 0) continue;
    let j = i; while (j + 1 < values.length && values[j + 1] === 0) j++;
    runs.push({ from: i, to: j, secs: (j - i + 1) * span }); i = j;
  }
  return runs;
}

/* ---------- Asset activity: bars + silence bands + last-event marker ---------- */
export function ActivityChart({ values, span, end, tolerance }: { values: number[]; span: number; end: number; tolerance: number }) {
  const scope = useTimeScope().scope, tz = scope.tz, phrase = rangePhrase(scope), clockLabel = (e: number) => formatClock(e, tz);
  const W = 760, H = 170, B = 22, plotH = H - B, bw = W / values.length;
  const max = Math.max(1, ...values), start = end - (values.length - 1) * span;
  const runs = silenceRuns(values, span);
  const lastIdx = values.reduce((acc, v, i) => (v > 0 ? i : acc), -1);
  const { ref: hvRef, ...hv } = useHover<number>();
  return (
    <div className="c-wrap" ref={hvRef} onPointerLeave={hv.clear}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Events per bin, ${phrase}, silences shaded`}>
        {[0.5, 1].map((f) => <line key={f} className="c-grid" x1={0} x2={W} y1={plotH - f * (plotH - 12)} y2={plotH - f * (plotH - 12)} />)}
        <line className="c-base" x1={0} x2={W} y1={plotH} y2={plotH} />
        {runs.map((r) => <rect key={r.from} className={r.secs > tolerance ? 'c-sil-long' : 'c-sil'} x={r.from * bw} y={0} width={(r.to - r.from + 1) * bw} height={plotH} />)}
        {values.map((v, i) => v > 0 && <rect key={i} className="c-bar" x={i * bw + 0.5} y={plotH - (v / max) * (plotH - 12)} width={Math.max(bw - 1, 1)} height={(v / max) * (plotH - 12)} rx={1.5} />)}
        {lastIdx >= 0 && lastIdx < values.length - 1 && <>
          <line className="c-alert-line" x1={(lastIdx + 1) * bw} x2={(lastIdx + 1) * bw} y1={0} y2={plotH} />
          <text className="c-label" x={(lastIdx + 1) * bw - 6} y={12} textAnchor="end">last event {clockLabel(start + lastIdx * span)}</text></>}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <text key={f} className="c-axis" x={f * W} y={H - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>
          {f === 1 ? 'now' : clockLabel(start + f * (values.length - 1) * span)}</text>)}
        {values.map((_, i) => <rect key={`h${i}`} x={i * bw} y={0} width={bw} height={plotH} fill="transparent" onPointerMove={(ev) => hv.move(ev, i)} />)}
        {hv.h && <line className="c-cross" x1={(hv.h.d + 0.5) * bw} x2={(hv.h.d + 0.5) * bw} y1={0} y2={plotH} />}
      </svg>
      {hv.h && <Tip x={hv.h.x} y={hv.h.y}><b>{clockLabel(start + hv.h.d * span)}</b> · {values[hv.h.d] ? `${values[hv.h.d].toLocaleString()} events` : 'no events'}</Tip>}
    </div>);
}

/* ---------- Worker group: who went silent and when ---------- */
export function Swimlanes({ rows, span, end }: { rows: { e: Entity; values?: number[] }[]; span: number; end: number }) {
  const tz = useTimeScope().scope.tz, clockLabel = (e: number) => formatClock(e, tz);
  const bins = rows.find((r) => r.values)?.values?.length ?? 48, start = end - (bins - 1) * span;
  const { ref: hvRef, ...hv } = useHover<{ e: Entity; i: number; v: number }>();
  return (
    <div className="lanes c-wrap" ref={hvRef} onPointerLeave={hv.clear}>
      {rows.map(({ e, values }) => { const max = Math.max(1, ...(values ?? [1])), first = values?.findIndex((v) => v > 0) ?? -1;
        return (<div className="lane" key={e.key}>
          <div className="lane-name"><Link className="lk" to={assetPath(e)}>{e.asset}</Link><span className="muted">{e.input.split(':')[1] ?? e.input}</span></div>
          <svg viewBox={`0 0 ${bins} 10`} preserveAspectRatio="none" className="lane-svg" role="img" aria-label={`${e.asset} activity`}>
            {(values ?? []).map((v, i) => <rect key={i} x={i} y={0} width={1.02} height={10}
              className={v > 0 ? 'ln-on' : i > first && first >= 0 ? 'ln-off' : 'ln-none'} style={v > 0 ? { opacity: 0.35 + 0.65 * (v / max) } : undefined}
              onPointerMove={(ev) => hv.move(ev, { e, i, v })} />)}
          </svg>
          <StateTag state={e.state} /></div>); })}
      <div className="lane"><span /><div className="lane-axis">{[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{f === 1 ? 'now' : clockLabel(start + f * (bins - 1) * span)}</span>)}</div><span /></div>
      {hv.h && <Tip x={hv.h.x} y={hv.h.y}><b>{hv.h.d.e.asset}</b><br />{clockLabel(start + hv.h.d.i * span)} · {hv.h.d.v ? `${hv.h.d.v.toLocaleString()} events` : 'silent'}</Tip>}
    </div>);
}

/* ---------- Threshold lab: every asset against the tolerance rule (log–log) ---------- */
export type Rule = { K: number; MIN_GAP: number; MAX_GAP: number };
export type LabPoint = { e: Entity; tol: number; liveTol: number; next: AssetState; now: AssetState };
const ruleTol = (g: number, r: Rule) => Math.max(r.MIN_GAP, Math.min(r.K * g, r.MAX_GAP));

export function ToleranceScatter({ points, rule, live, selected, onSelect }: { points: LabPoint[]; rule: Rule; live: Rule; selected?: string; onSelect: (k: string) => void }) {
  const W = 680, H = 380, L = 54, R = 14, T = 12, Bm = 40;
  const xs = [5, ...points.map((p) => p.e.gap_s)], ys = [5, ...points.map((p) => Math.max(p.e.silent_s, 5)), rule.MAX_GAP, live.MAX_GAP];
  const x0 = Math.log10(Math.max(1, Math.min(...xs) / 2)), x1 = Math.log10(Math.max(...xs) * 3);
  const y0 = Math.log10(Math.max(1, Math.min(...ys) / 2)), y1 = Math.log10(Math.max(...ys) * 2.5);
  const lx = (v: number) => L + ((Math.log10(Math.max(v, 1)) - x0) / (x1 - x0)) * (W - L - R);
  const ly = (v: number) => H - Bm - ((Math.log10(Math.max(v, 1)) - y0) / (y1 - y0)) * (H - Bm - T);
  const curve = (r: Rule, f = 1) => Array.from({ length: 81 }, (_, i) => { const g = Math.pow(10, x0 + (i / 80) * (x1 - x0));
    return `${i ? 'L' : 'M'}${lx(g).toFixed(1)},${ly(ruleTol(g, r) * f).toFixed(1)}`; }).join('');
  const ticks = [1, 10, 60, 300, 900, 3600, 14400, 86400].filter((t) => Math.log10(t) >= x0 && Math.log10(t) <= x1);
  const yticks = [1, 10, 60, 300, 900, 3600, 14400, 86400].filter((t) => Math.log10(t) >= y0 && Math.log10(t) <= y1);
  const { ref: hvRef, ...hv } = useHover<LabPoint>();
  return (
    <div className="c-wrap" ref={hvRef} onPointerLeave={hv.clear}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Each asset's learned gap against its current silence, with the alert line of the proposed rule">
        {ticks.map((t) => <g key={`x${t}`}><line className="c-grid" x1={lx(t)} x2={lx(t)} y1={T} y2={H - Bm} /><text className="c-axis" x={lx(t)} y={H - Bm + 16} textAnchor="middle">{fmtDur(t)}</text></g>)}
        {yticks.map((t) => <g key={`y${t}`}><line className="c-grid" x1={L} x2={W - R} y1={ly(t)} y2={ly(t)} /><text className="c-axis" x={L - 6} y={ly(t) + 3} textAnchor="end">{fmtDur(t)}</text></g>)}
        <path className="c-zone" d={`${curve(rule)} L${W - R},${T} L${L},${T} Z`} />
        <path className="c-live-line" d={curve(live)} />
        <path className="c-late-line" d={curve(rule, 0.6)} />
        <path className="c-alert-line" d={curve(rule)} />
        <text className="c-label" x={W - R - 4} y={ly(ruleTol(Math.pow(10, x1), rule)) - 6} textAnchor="end">alert line</text>
        {points.map((p) => { const cx = lx(p.e.gap_s), cy = ly(Math.max(p.e.silent_s, 5)), changed = p.next !== p.now, sel = selected === p.e.key;
          return (<g key={p.e.key} className="c-dot-g" onClick={() => onSelect(p.e.key)} onPointerMove={(ev) => hv.move(ev, p)}>
            <circle cx={cx} cy={cy} r={14} fill="transparent" />
            {(changed || sel) && <circle className={sel ? 'c-ring-sel' : 'c-ring'} cx={cx} cy={cy} r={11} />}
            <circle className={`c-dot d-${p.next} ${p.e.overridden ? 'd-override' : ''}`} cx={cx} cy={cy} r={changed || sel ? 7 : 5.5} />
            {(changed || sel) && <text className="c-label" x={cx + 14} y={cy + 4}>{p.e.asset}</text>}
          </g>); })}
        <text className="c-axis" x={(W + L) / 2} y={H - 6} textAnchor="middle">learned gap between events →</text>
        <text className="c-axis" x={12} y={(H - Bm) / 2} textAnchor="middle" transform={`rotate(-90 12 ${(H - Bm) / 2})`}>silent for →</text>
      </svg>
      {hv.h && <Tip x={hv.h.x} y={hv.h.y}><b>{hv.h.d.e.asset}</b> <span className="muted">{hv.h.d.e.input}</span><br />
        silent {fmtDur(hv.h.d.e.silent_s)} · learned gap {fmtDur(hv.h.d.e.gap_s)}<br />
        tolerance {fmtDur(hv.h.d.tol)}{hv.h.d.e.overridden ? ' (override)' : ''} · live {fmtDur(hv.h.d.liveTol)}<br />
        {hv.h.d.now === hv.h.d.next ? `stays ${hv.h.d.now}` : `${hv.h.d.now} → ${hv.h.d.next}`}</Tip>}
    </div>);
}

/* ---------- Replay: gaps of one asset over the range against the proposed and live tolerance ---------- */
export type Gap = { start: number; secs: number; ongoing: boolean };
/** Gaps between active minutes (values = events per minute, ending now). Ignores gaps ≤ `floor` seconds. */
export function gapsFrom(values: number[], end: number, floor = 120): Gap[] {
  const start = end - (values.length - 1) * 60, act = values.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);
  const gaps: Gap[] = [];
  for (let k = 1; k < act.length; k++) { const secs = (act[k] - act[k - 1]) * 60; if (secs > floor) gaps.push({ start: start + act[k - 1] * 60, secs, ongoing: false }); }
  if (act.length) { const secs = (values.length - 1 - act[act.length - 1]) * 60; if (secs > floor) gaps.push({ start: start + act[act.length - 1] * 60, secs, ongoing: true }); }
  return gaps;
}
export const alertsFor = (gaps: Gap[], tol: number) => gaps.filter((g) => g.secs > tol).length;

export function GapReplay({ gaps, end, tol, liveTol }: { gaps: Gap[]; end: number; tol: number; liveTol: number }) {
  const scope = useTimeScope().scope, tz = scope.tz, phrase = rangePhrase(scope), clockLabel = (e: number) => formatClock(e, tz);
  const W = 1000, H = 160, B = 22, T = 10, plotH = H - B, start = end - 86400;
  const top = Math.log10(Math.max(tol, liveTol, ...gaps.map((g) => g.secs)) * 2), bot = Math.log10(60);
  const y = (s: number) => plotH - ((Math.log10(Math.max(s, 60)) - bot) / (top - bot)) * (plotH - T);
  const x = (t: number) => ((t - start) / 86400) * W;
  const { ref: hvRef, ...hv } = useHover<Gap>();
  const line = (s: number, cls: string, label: string, dy: number) => <g><line className={cls} x1={0} x2={W} y1={y(s)} y2={y(s)} /><text className="c-label" x={W - 4} y={y(s) + dy} textAnchor="end">{label}</text></g>;
  return (
    <div className="c-wrap" ref={hvRef} onPointerLeave={hv.clear}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={`Gaps between events, ${phrase}, compared with the tolerance`}>
        <line className="c-base" x1={0} x2={W} y1={plotH} y2={plotH} />
        {gaps.map((g) => { const over = g.secs > tol;
          return <rect key={g.start} className={over ? 'c-gap-over' : 'c-gap'} x={x(g.start)} y={y(g.secs)} width={Math.max(4, (g.secs / 86400) * W)} height={plotH - y(g.secs)} rx={2}
            onPointerMove={(ev) => hv.move(ev, g)} />; })}
        {tol === liveTol ? line(tol, 'c-alert-line', `tolerance ${fmtDur(tol)}`, -5) : <>
          {line(liveTol, 'c-live-line', `live ${fmtDur(liveTol)}`, tol > liveTol ? 14 : -5)}
          {line(tol, 'c-alert-line', `proposed ${fmtDur(tol)}`, tol > liveTol ? -5 : 14)}</>}
        {[0, 0.25, 0.5, 0.75, 1].map((f) => <text key={f} className="c-axis" x={f * W} y={H - 6} textAnchor={f === 0 ? 'start' : f === 1 ? 'end' : 'middle'}>{f === 1 ? 'now' : clockLabel(start + f * 86400)}</text>)}
      </svg>
      {!gaps.length && <div className="c-empty muted">{`No gap longer than 2 minutes ${phrase}.`}</div>}
      {hv.h && <Tip x={hv.h.x} y={hv.h.y}><b>{fmtDur(hv.h.d.secs)}</b> silent from {clockLabel(hv.h.d.start)}{hv.h.d.ongoing ? ' (still silent)' : ''}<br />
        {hv.h.d.secs > tol ? 'would alert' : 'no alert'} with proposed · {hv.h.d.secs > liveTol ? 'alerts' : 'no alert'} with live</Tip>}
    </div>);
}

export function useLabPoints(fleet: Entity[], rule: Rule, live: Rule) {
  return useMemo(() => fleet.filter((e) => e.state !== 'learning' && e.state !== 'muted').map((e): LabPoint => {
    const tol = e.overridden ? e.tolerance_s : ruleTol(e.gap_s, rule), liveTol = e.overridden ? e.tolerance_s : ruleTol(e.gap_s, live);
    return { e, tol, liveTol, next: stateFor(e.silent_s, tol), now: stateFor(e.silent_s, liveTol) };
  }), [fleet, rule, live]);
}
