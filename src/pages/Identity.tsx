import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Alert, Button, Drawer, EmptyState, Skeleton, Table, Text, TextField } from '@capra/core';
import { SetupPulseButton } from '../components/SetupPulseButton';
import { useSnapshotGap } from '../components/useSnapshotGap';
import { PlanRunner } from '../components/PlanRunner';
import { IdTag, Metric, Page, Section, groupPath, srcName } from '../components/ui';
import { runSearch, type Row } from '../lib/api';
import { keyFor, keyPlan, loadKeys, nextKeys } from '../lib/deploy';
import { PRESETS, candidates, describeRule, describeSpec, resolve, sourceIdentity, type Sample } from '../lib/identity';
import { samplesQuery } from '../lib/kql';
import type { Entity } from '../lib/model';
import { cols, rowsOf, vis } from '../lib/table';
import { usePulse } from '../state';

type Src = { id: string; group: string; input: string; list: Entity[]; health: ReturnType<typeof sourceIdentity>; how: string };

/** Spec 003: how each source's assets are identified, and a Key Advisor to fix the ones that are not. */
export function Identity() {
  const { fleet, demo, loading, error, updatedAt, refresh, setup } = usePulse();
  const busy = loading && !updatedAt;
  const gap = useSnapshotGap(); // R1: rejected snapshot, no rows: the reason and Compute now, not "No source yet"
  const [params, setParams] = useSearchParams();
  const [keys, setKeys] = useState<Record<string, Record<string, string>>>({});
  const groups = useMemo(() => [...new Set(fleet.map((e) => e.group))].sort(), [fleet]);
  useEffect(() => { (async () => {
    if (import.meta.env.DEV && demo) { setKeys((await import('../lib/demo')).keys()); return; }
    setKeys(Object.fromEntries(await Promise.all(groups.map(async (g) => [g, await loadKeys(g).catch(() => ({}))] as const))));
  })(); }, [groups.join(','), demo]); // eslint-disable-line

  const srcs = useMemo<Src[]>(() => [...new Set(fleet.map((e) => `${e.group}|${e.input}`))].sort().map((id) => {
    const [group, input] = id.split('|'); const list = fleet.filter((e) => e.group === group && e.input === input);
    const by: Record<string, number> = {}; list.forEach((e) => { by[e.key_src || 'unknown'] = (by[e.key_src || 'unknown'] ?? 0) + 1; });
    const how = Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k === 'unknown' ? 'pack older than 1.2' : describeRule(k)}${Object.keys(by).length > 1 ? ` (${n})` : ''}`).join(', ');
    return { id, group, input, list, health: sourceIdentity(list.map((e) => ({ asset: e.asset, key_src: e.key_src }))), how };
  }).sort((a, b) => ['weak', 'source', 'fallback', 'strong'].indexOf(a.health.health) - ['weak', 'source', 'fallback', 'strong'].indexOf(b.health.health)), [fleet]);
  const open = srcs.find((s) => s.id === params.get('source'));
  const n = (h: string) => srcs.filter((s) => s.health.health === h).length;

  return (
    <Page crumbs={[{ label: 'Identity' }]} sub="How Pulse names the sender of each event, per source — and how to fix it when the host field is missing or useless">
      <Metric label="Sources watched" value={srcs.length} loading={busy} />
      <Metric label="Identified" value={n('strong')} loading={busy} hint="host or a key you chose" />
      <Metric label="By source IP only" value={n('fallback')} loading={busy} tag={n('fallback') ? { label: "Relays and NAT", color: "info" } : undefined} hint="relays and NAT can hide senders" />
      <Metric label="Needs a key" value={n('weak') + n('source')} loading={busy} tag={n('weak') + n('source') ? { label: "Action", color: "warning" } : undefined} hint="placeholder names or one entity for the whole source" />

      <Section title="Sources" description="worst first" loading={busy} error={error} onRetry={refresh}>
        {!srcs.length && gap ? <EmptyState title={gap.title} description={gap.description} size="md">{gap.cta}</EmptyState>
          : !srcs.length ? <EmptyState title="No source yet" description="Deploy Pulse to a worker group first." size="md">{setup === 'not-deployed' ? <SetupPulseButton /> : null}</EmptyState>
          : <Table density="compact" appearance="flat" items={rowsOf(srcs, ['input', 'health', 'assets', 'how', 'examples', 'key', 'act'])} visibleColumns={vis(['input', 'health', 'assets', 'how', 'examples', 'key', 'act'])}
            columns={cols([
              { id: 'input', label: 'Source', render: (_, s: Src) => <div className="cell2"><Link className="lk" to={groupPath(s.group, s.input)}>{srcName(s.input)}</Link><Text variant="body-xs-normal" color="subtle">{s.group}</Text></div> },
              { id: 'health', label: 'Identity', render: (_, s: Src) => <span title={s.health.why}><IdTag health={s.health.health} /></span> },
              { id: 'assets', label: 'Assets', render: (_, s: Src) => <span className="num">{s.list.length}</span> },
              { id: 'how', label: 'Found by', render: (_, s: Src) => <span className="why-cell">{s.how}</span> },
              { id: 'examples', label: 'Asset names', render: (_, s: Src) => <span className="why-cell mono">{s.list.slice(0, 3).map((e) => e.asset).join(', ')}{s.list.length > 3 ? '…' : ''}</span> },
              { id: 'key', label: 'Key rule', render: (_, s: Src) => <span className="why-cell">{describeSpec(keyFor(keys[s.group] ?? {}, s.input))}</span> },
              { id: 'act', label: '', render: (_, s: Src) => <Button size="sm" variant={s.health.health === 'strong' ? 'tertiary' : 'secondary'} onClick={() => setParams({ source: s.id })}>{s.health.health === 'strong' ? 'Change' : 'Choose key'}</Button> }])} />}
      </Section>

      <Section span={12} title="When the host field is missing" description="the rules Pulse tries, in order, for every event">
        <div className="row2">
          <ol className="stack-sm" style={{ paddingLeft: 18 }}>
            <li><Text><b>host</b>, unless it is a placeholder such as localhost, 127.0.0.1 or unknown</Text></li>
            <li><Text>Common host fields: hostname, host.name, ComputerName, Computer, device_name, dvchost, devname, agent.hostname</Text></li>
            <li><Text>The hostname in a syslog header, for raw TCP/UDP sources that do not parse it</Text></li>
            <li><Text>devname= or dvchost= inside the raw event (Fortinet, CEF)</Text></li>
            <li><Text>The sending IP address</Text></li>
            <li><Text>Nothing found: the source is watched as one entity, so it still alerts when it goes quiet</Text></li>
          </ol>
          <div className="stack-sm"><Text>A key rule per source replaces this order: a CSV column (Palo Alto serial), a key=value field, a JSON path, a field, a regular expression, or a chain such as <span className="mono">kv:devname | ip</span>.</Text>
            <Text color="subtle">Every heartbeat records which rule matched (asset_src), so this page shows how each asset was found. The Key Advisor tests rules on samples the pack sends every 15 minutes (3 events per source, truncated).</Text></div>
        </div>
      </Section>

      {open && <KeyAdvisor src={open} current={keys[open.group] ?? {}} onClose={() => setParams({})} onSaved={(next) => setKeys((k) => ({ ...k, [open.group]: next }))} />}
    </Page>);
}

function KeyAdvisor({ src, current, onClose, onSaved }: { src: Src; current: Record<string, string>; onClose: () => void; onSaved: (k: Record<string, string>) => void }) {
  const { settings, demo, refresh } = usePulse();
  const [samples, setSamples] = useState<Sample[]>();
  const [err, setErr] = useState<string>();
  const [spec, setSpec] = useState(keyFor(current, src.input));
  useEffect(() => { (async () => {
    try {
      const rows: Row[] = import.meta.env.DEV && demo ? (await import('../lib/demo')).samples(src.input) : await runSearch(samplesQuery(settings, src.input), '-24h', 'now', 120_000, 300);
      setSamples(rows.map((r) => { let fields: Record<string, unknown> = {}; try { fields = JSON.parse(String(r.fields_json ?? '{}')); } catch { /* keep empty */ }
        return { raw: String(r.raw_sample ?? ''), fields, src_ip: String(r.src_ip ?? '') }; }));
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); setSamples([]); }
  })(); }, [src.id]); // eslint-disable-line
  const cands = useMemo(() => (samples ? candidates(samples) : []), [samples]);
  const preview = useMemo(() => (samples ?? []).slice(0, 8).map((s) => ({ s, r: resolve({ ...s.fields, _raw: s.raw, src_ip: s.src_ip }, spec) })), [samples, spec]);
  const distinct = new Set(preview.map((p) => p.r.asset)).size;
  const steps = useMemo(() => keyPlan(src.group, src.input, spec, current), [src, spec, current]);
  const changed = spec !== keyFor(current, src.input);

  return (
    <Drawer isOpen onClose={onClose} title={`Asset key · ${srcName(src.input)}`} width={620}>
      <div className="stack">
        <Alert appearance={src.health.health === 'strong' ? 'success' : 'warning'} title={src.health.health === 'strong' ? 'Assets are identified' : 'Asset names are not reliable'}>{src.health.why}</Alert>
        <Text variant="heading-xs">Suggested from {samples ? `${samples.length} samples` : 'samples'}</Text>
        {!samples ? <Skeleton /> : err ? <Alert appearance="warning" title="Samples not available">{err}</Alert>
          : !samples.length ? <Text color="subtle">No samples yet. Samples come from pack cribl-pulse 1.2 or later: upgrade it on the Deploy page, then wait about 15 minutes.</Text>
          : <div className="stack-sm">{cands.slice(0, 5).map((c) => (
            <button key={c.spec} className={`cand ${spec === c.spec ? 'on' : ''}`} onClick={() => setSpec(c.spec)}>
              <span className="stack-sm" style={{ gap: 2 }}><Text variant="body-sm-semibold">{c.label}</Text>
                <span className="mono muted">{c.examples.join(', ')}</span><Text variant="body-xs-normal" color="subtle">{c.note}</Text></span>
              <span className="stack-sm" style={{ alignItems: 'flex-end', gap: 4 }}><span className="meter"><i style={{ width: `${Math.round(c.coverage * 100)}%` }} /></span>
                <Text variant="body-xs-normal" color="subtle">{Math.round(c.coverage * 100)}% of events</Text></span>
            </button>))}</div>}

        <Text variant="heading-xs">Or a known format</Text>
        <div className="chips">{PRESETS.map((p) => <button key={p.spec} className="chip" title={p.hint} onClick={() => setSpec(p.spec)}>{p.label}</button>)}</div>
        <TextField label="Key rule" value={spec} onChange={setSpec} helperText={`${describeSpec(spec)}. Chain fallbacks with " | ".`} />

        {preview.length > 0 && <div className="stack-sm"><Text variant="heading-xs">Preview on samples</Text>
          <Text variant="body-xs-normal" color="subtle">{distinct} distinct asset{distinct === 1 ? '' : 's'} in {preview.length} samples</Text>
          {preview.slice(0, 4).map(({ s, r }, i) => <div key={i} className="stack-sm" style={{ gap: 4 }}>
            <div className="row"><Text variant="body-sm-semibold">{r.asset}</Text><Text variant="body-xs-normal" color="subtle">via {describeRule(r.src)}</Text></div>
            <div className="sample mono">{highlight(s.raw.slice(0, 400), r.asset)}</div></div>)}</div>}

        <PlanRunner title="Apply to the worker group" steps={changed ? steps : []} onDone={() => { onSaved(nextKeys(current, src.input, spec)); void refresh(); }} />
        <Text variant="body-xs-normal" color="subtle">Existing assets on this source keep their history under the old names; new heartbeats use the new key within a minute of the deploy.</Text>
      </div>
    </Drawer>);
}

function highlight(text: string, needle: string) {
  if (!needle || needle === '(source)') return text;
  const i = text.indexOf(needle);
  return i < 0 ? text : <>{text.slice(0, i)}<span className="mark">{needle}</span>{text.slice(i + needle.length)}</>;
}
