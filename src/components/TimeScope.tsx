import { useEffect, useState } from 'react';
import { Button, DatePickerField, DateRangePickerField, Radio, RadioGroup, Tag, Text, TextField } from '@capra/core';
import { CalendarDateTime } from '@internationalized/date';
import { ClockOutlined } from '@capra/icons';
import { useTimeScope } from '../scopeContext';
import { QUICK, rangeLabel, resolve, type TimeScope as Scope } from '../lib/timescope';
import { AROUND, RAIL, absoluteReason, absoluteScope, activeQuick, applyQuick, aroundWindow, epochToWall, pickerTab, railScope, relativeErrors, wallToEpoch, zoneInfo, type Wall } from '../lib/quickrange';

/** Spec 014 §2 header control: read-only range display + tz Tag, then the quick ranges.
 *  `onRangeClick` is the hook for the picker (opened from the range display). */
export function TimeScope({ onRangeClick }: { onRangeClick?: () => void }) {
  const { scope, setScope } = useTimeScope();
  const [nowS, setNowS] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => { const t = setInterval(() => setNowS(Math.floor(Date.now() / 1000)), 30000); return () => clearInterval(t); }, []);
  const [open, setOpen] = useState(false);
  const label = rangeLabel(scope, nowS);
  const tz = scope.tz === 'utc' ? 'UTC' : 'Local';
  const active = activeQuick(scope);
  const aria = 'Time range: ' + label + ', ' + tz + ' time';
  return <div className="time-scope" role="group" aria-label="Time range">
    <span className="range-display" role="group" aria-label={aria} onClick={() => { setOpen((o) => !o); onRangeClick?.(); }}>
      <ClockOutlined size="sm" /><span className="range-label" title={label}><Text variant="body-sm-normal">{label}</Text></span>
      <Tag size="sm" color="default">{tz}</Tag></span>
    <span className="quick-ranges">
      {QUICK.map((q) => <Button key={q} size="md" variant={active === q ? 'primary' : 'secondary'} aria-pressed={active === q}
        onClick={() => applyQuick(q, scope, setScope)}>{q}</Button>)}</span>
    {open && <TimeScopePicker key={scope.earliest + scope.latest} scope={scope} nowS={nowS} onTz={(z) => setScope({ ...scope, tz: z })} onApply={(s) => { setScope(s); setOpen(false); }} />}
  </div>;
}

const toCdt = (w: Wall) => new CalendarDateTime(w.year, w.month, w.day, w.hour, w.minute);
const toWall = (v: { year: number; month: number; day: number; hour?: number; minute?: number }): Wall =>
  ({ year: v.year, month: v.month, day: v.day, hour: v.hour ?? 0, minute: v.minute ?? 0 });

/** Picker footer: resolved zone plus the Local/UTC choice. */
export function TzFooter({ tz, onTz }: { tz: Scope['tz']; onTz?: (tz: Scope['tz']) => void }) {
  const timeZone = zoneInfo(tz); // resolved via Intl.DateTimeFormat in quickrange.ts
  return <div className="ts-footer">
    <Text variant="body-sm-normal" color="subtle">{timeZone.label} · {timeZone.offset}</Text>
    <RadioGroup name="ts-tz" aria-label="Time zone" value={tz}
      onChange={(e) => onTz?.(e.target.value === 'utc' ? 'utc' : 'local')}>
      <Radio value="local">Local</Radio><Radio value="utc">UTC</Radio></RadioGroup>
  </div>;
}

const TABS = [['relative', 'Relative'], ['range', 'Date Range'], ['around', 'Around']] as const;

/** Range picker dropdown: Quick Selections rail plus Relative / Date Range / Around tabs. */
export function TimeScopePicker({ scope, nowS, onApply, onTz }: { scope: Scope; nowS: number; onApply: (s: Scope) => void; onTz?: (tz: Scope['tz']) => void }) {
  const [tab, setTab] = useState<string>(pickerTab(scope));
  const [earliest, setEarliest] = useState(scope.earliest);
  const [latest, setLatest] = useState(scope.latest);
  const initial = resolve(scope, nowS);
  const [range, setRange] = useState<{ start: CalendarDateTime; end: CalendarDateTime } | null>(
    initial && tab === 'range' ? { start: toCdt(epochToWall(initial.from, scope.tz)), end: toCdt(epochToWall(initial.to, scope.tz)) } : null);
  const [center, setCenter] = useState<CalendarDateTime | null>(null);
  const [around, setAround] = useState(3600);
  const errs = tab === 'relative' ? relativeErrors(earliest, latest, scope.tz, nowS) : {};
  const win = tab === 'range'
    ? range && { from: wallToEpoch(toWall(range.start), scope.tz), to: wallToEpoch(toWall(range.end), scope.tz) }
    : tab === 'around' && center ? aroundWindow(wallToEpoch(toWall(center), scope.tz), around, nowS) : null;
  const reason = tab === 'relative' ? undefined : absoluteReason(win, scope.tz, nowS);
  const blocked = tab === 'relative' ? !!errs.earliest || !!errs.latest : !win || !!reason;
  const apply = () => {
    if (blocked) return;
    onApply(tab === 'relative' ? { earliest: earliest.trim(), latest: latest.trim(), tz: scope.tz } : absoluteScope(win!.from, win!.to, scope.tz));
  };
  return <div className="ts-picker" role="dialog" aria-label="Choose time range">
    <div className="ts-rail" role="group" aria-label="Quick Selections">
      {RAIL.map((g) => <div key={g.group} className="ts-rail-group"><Text variant="body-sm-semibold" color="subtle">{g.group}</Text>
        {g.tokens.map((t) => <button key={t} type="button" className="ts-rail-row" onClick={() => onApply(railScope(t, scope.tz))}>
          <span>Last {t.slice(1)}</span><span className="ts-token">{t}</span></button>)}</div>)}
    </div>
    <div className="ts-main">
      <div className="ts-tabs" role="tablist">{TABS.map(([k, n]) =>
        <button key={k} type="button" role="tab" aria-selected={tab === k} className="ts-tab" onClick={() => setTab(k)}>{n}</button>)}</div>
      {tab === 'relative'
        ? <div className="stack-sm">
            <TextField label="Earliest" value={earliest} onChange={setEarliest} placeholder="-6h" helperText={errs.earliest} />
            <TextField label="Latest" value={latest} onChange={setLatest} placeholder="now" helperText={errs.latest} /></div>
        : tab === 'range'
          ? <DateRangePickerField label="Date range" granularity={'minute' as 'second' /* Capra types omit 'minute'; it is supported at runtime */} shouldCloseOnSelect={false} value={range}
              onChange={(v) => setRange(v ? { start: toCdt(toWall(v.start)), end: toCdt(toWall(v.end)) } : null)}
              helperText={reason ?? undefined} appearance={reason ? 'danger' : 'default'} isInvalid={!!reason} />
          : <div className="stack-sm">
              <DatePickerField label="Around" granularity={'minute' as 'second'} value={center}
                onChange={(v) => setCenter(v ? toCdt(toWall(v)) : null)}
                helperText={reason ?? undefined} appearance={reason ? 'danger' : 'default'} isInvalid={!!reason} />
              <div role="group" aria-label="Plus or minus">{AROUND.map(([l, sec]) =>
                <Button key={l} variant={around === sec ? 'primary' : 'secondary'} aria-pressed={around === sec} onClick={() => setAround(sec)}>{`±${l}`}</Button>)}</div>
            </div>}
      <div className="ts-actions"><Button variant="primary" disabled={blocked}
        onClick={apply}>Apply</Button></div>
      <TzFooter tz={scope.tz} onTz={onTz} />
    </div>
  </div>;
}
