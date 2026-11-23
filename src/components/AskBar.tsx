import { useEffect, useState } from 'react';
import { AgentPrompt, Alert, Button, Card, Table, Text } from '@capra/core';
import { Copilot } from '@capra/icons';
import { rangeLabel } from '../lib/timescope';
import { useTimeScope } from '../scopeContext';
import { runSearch, type Row } from '../lib/api';
import { diagnose } from '../lib/model';
import { complete, isChange, parseAsk, runQueryAction, systemPrompt, type Action } from '../lib/ai';
import { ackOverride, alertsPlan, deployPlan, setOverride, type Step } from '../lib/deploy';
import { hostOrigin } from '../lib/host';
import { saveWindows } from '../lib/maintenance';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';
import { PlanRunner } from './PlanRunner';

const SUGGESTIONS = ['Why are these assets missing?', 'Which source lost the most assets today?', 'Which P1 assets have no owner?', 'Watch all sources on group 04-2025'];

export function AskBar({ initial, onClose }: { initial?: string; onClose?: () => void } = {}) {
  const { settings, ai, entities, sources, fleet, inventory, windows, setWindows, refresh } = usePulse();
  const { scope } = useTimeScope();
  const [state, setState] = useState<'default' | 'processing'>('default');
  const [answer, setAnswer] = useState<string>();
  const [rows, setRows] = useState<Row[]>([]);
  const [steps, setSteps] = useState<Step[]>([]);
  const [error, setError] = useState<string>();
  const [value, setValue] = useState(initial ?? '');
  useEffect(() => { if (initial) void ask(initial); }, []); // eslint-disable-line

  function toSteps(a: Action): Step[] {
    switch (a.type) {
      case 'deploy': return deployPlan(a.group, a.inputs ?? [], settings);
      case 'install_alerts': return alertsPlan(settings, a.enabled !== false, undefined, [], { origin: hostOrigin(), base: window.CRIBL_BASE_PATH });
      case 'mute': return [{ id: `mute-${a.asset}`, title: `Mute ${a.asset}`, detail: `${a.input}${a.days ? `, for ${a.days} day(s)` : ''}`, volatile: true,
        run: async () => { await setOverride({ input: a.input, asset: a.asset, action: 'mute', max_gap_s: 0, note: a.note,
          until: a.days ? new Date(Date.now() + a.days * 864e5).toISOString() : undefined }); return 'muted'; } }];
      case 'unmute': return [{ id: `unmute-${a.asset}`, title: `Unmute ${a.asset}`, detail: a.input, volatile: true,
        run: async () => { await setOverride({ input: a.input, asset: a.asset, remove: true }); return 'unmuted'; } }];
      case 'ack': { const e = fleet.find((x) => x.asset === a.asset && (!a.input || x.input === a.input));
        return e ? [{ id: `ack-${a.asset}`, title: `Acknowledge ${a.asset}`, detail: `${e.input} — ends when it sends again or after a day`, volatile: true,
          run: async () => { await setOverride(ackOverride(e)); return 'acknowledged'; } }] : []; }
      case 'maintenance': { const start = Math.floor(Date.now() / 1000), end = start + Math.round((a.hours ?? 2) * 3600);
        return [{ id: `mw-${a.scope}`, title: `Maintenance window on ${a.scope}`, detail: `${a.hours ?? 2} h from now — ${a.reason ?? 'maintenance'}`, volatile: true,
          run: async () => { setWindows(await saveWindows([...windows, { id: crypto.randomUUID(), scope: a.scope, start, end, reason: a.reason ?? 'maintenance', created: new Date().toISOString() }])); return 'scheduled'; } }]; }
      case 'threshold': return [{ id: `thr-${a.asset}`, title: `Tolerance ${a.max_gap_s}s for ${a.asset}`, detail: a.input, volatile: true,
        run: async () => { await setOverride({ input: a.input, asset: a.asset, action: 'threshold', max_gap_s: a.max_gap_s }); return 'saved'; } }];
      default: return [];
    }
  }

  async function ask(q: string) {
    if (!q.trim()) return;
    setState('processing'); setError(undefined); setAnswer(undefined); setRows([]); setSteps([]);
    try {
      const count = (s: string) => entities.filter((e) => e.state === s).length;
      const suspicious = fleet.filter((e) => e.state === 'missing' || e.state === 'late').slice(0, 30).map((e) => {
        const inv = inventory[e.asset];
        return `${e.asset}@${e.input}(${e.group}) ${e.state} ${Math.round(e.silent_s / 60)}min crit=${inv?.criticality ? 'P' + inv.criticality : 'unset'} team=${inv?.team ?? 'unset'} why="${diagnose(e, fleet, settings.learning).short}"`;
      }).join('; ');
      const unowned = fleet.filter((e) => !inventory[e.asset]?.team).map((e) => e.asset);
      const ctx = `assets=${entities.length} ok=${count('ok')} late=${count('late')} delayed=${count('delayed')} missing=${count('missing')} acked=${count('acked')} maintenance=${count('maintenance')} learning=${count('learning')} muted=${count('muted')}; ` +
        `sources=${sources.map((s) => `${s.input}(${s.worker_group}) ${s.current}/${s.expected}`).join(', ')}; suspicious: ${suspicious || 'none'}; ` +
        `inventory: ${Object.entries(inventory).slice(0, 60).map(([a, i]) => `${a}=P${i.criticality ?? '?'}/${i.team ?? '?'}`).join(', ') || 'empty'}; no owner: ${[...new Set(unowned)].slice(0, 40).join(', ') || 'none'}`;
      const r = parseAsk(await complete(ai, systemPrompt(settings, ctx, { label: rangeLabel(scope, Math.floor(Date.now() / 1000)), earliest: scope.earliest, latest: scope.latest }), q));
      setAnswer(r.answer);
      const query = r.actions.find((a) => a.type === 'query');
      if (query && query.type === 'query') setRows(await runQueryAction(query, scope, (k, e, l) => runSearch(k, e, l)));
      setSteps(r.actions.filter(isChange).flatMap(toSteps));
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setState('default'); }
  }

  const keys = rows[0] ? Object.keys(rows[0]).filter((k) => !k.startsWith('_') || k === '_time').slice(0, 8) : [];
  return (
    <section className="ask">
      <div className="ask-hero">
        <Copilot size="md" />
        <Text variant="heading-sm">Ask Pulse</Text>
        <Text color="subtle">Questions run on your Pulse metrics. Changes come back as a plan you approve.</Text>
        <span className="sp" />{onClose && <Button size="sm" variant="tertiary" onClick={onClose}>Close</Button>}
      </div>
      <AgentPrompt state={state} value={value} onChange={setValue} onSubmit={(v) => void ask(v)}
        placeholder="Ask anything — “which assets are missing on syslog?”, “watch the paloalto source”…" />
      {!answer && !error && state === 'default' && (
        <div className="chips">{SUGGESTIONS.map((s) => <button key={s} className="chip" onClick={() => { setValue(s); void ask(s); }}>{s}</button>)}</div>)}
      {error && <Alert appearance="danger" title="Pulse could not answer">{error}</Alert>}
      {answer && <Card><Card.Content><div className="pre"><Text>{answer}</Text></div>
        {rows.length > 0 && <Table density="compact" appearance="flat" items={rowsOf(rows.map((r, i) => ({ id: i, ...r })))}
          columns={cols(keys.map((c) => ({ id: c, label: c })))} visibleColumns={vis(keys)} />}
      </Card.Content></Card>}
      {steps.length > 0 && <PlanRunner title="Proposed plan" steps={steps} onDone={() => void refresh()} />}
    </section>
  );
}
