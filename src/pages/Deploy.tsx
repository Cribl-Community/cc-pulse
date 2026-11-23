import { Page, Section } from '../components/ui';
import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Checkbox, Radio, RadioGroup, SelectField, Tag, Text, TextField } from '@capra/core';
import { PlanRunner } from '../components/PlanRunner';
import { kvGet, listDatasets, listGroups, listInputs, listPacks, type Group, type Input, type LakeDataset } from '../lib/api';
import { PACK_ID, PACK_VERSION, deployPlan, destinationFor, formatOf as datasetFormat, routeOnly, routePlan, sourceDelta, type Deployment, type Step } from '../lib/deploy';
import { defaultSourceMode, OBSERVER_US_PER_EVENT } from '../lib/routeFilter';
import { saveSettings } from '../lib/settings';
import { useChanged } from '../lib/changed';
import { usePulse } from '../state';

const NEW = '__new__';
/** Datasets granted in config/policies.yml (Search needs them by name). */
const READABLE_DATASETS = ['pulse_metrics', 'pulse_metrics_pq'];
/** Spec 015: where a JSON install moves to. A Lake dataset's format is never changed in place (CRIBL-37604). */
const PARQUET_TARGET = 'pulse_metrics_pq';
const FORMAT_LABEL: Record<string, string> = { json: 'JSON', parquet: 'Parquet', ddss: 'DDSS' };
const DATASET_RE = /^[a-z][a-z0-9_]{1,62}$/;

type DeployProps = { /** Fixed worker group: no group picker; loads this group's data only. */ group?: string; /** Omit the Page header band (e.g. inside a Drawer). */ embedded?: boolean };

export function Deploy({ group: fixedGroup, embedded }: DeployProps = {}) {
  const { settings, setSettings, refresh, fleet } = usePulse();
  const [groups, setGroups] = useState<(Group & { pulse?: string })[]>([]);
  const [group, setGroup] = useState<string>();
  const [inputs, setInputs] = useState<Input[]>([]);
  const [prevDeploy, setPrevDeploy] = useState<Deployment | null>();
  const [mode, setMode] = useState<'all' | 'selected'>('selected');
  const [picked, setPicked] = useState<string[]>([]);
  const [datasets, setDatasets] = useState<LakeDataset[]>([]);
  const [dsChoice, setDsChoice] = useState<string>(settings.dataset);
  const [dsNew, setDsNew] = useState('');
  const [err, setErr] = useState<string>();
  const [full, setFull] = useState(false);

  const activeGroup = fixedGroup ?? group;
  useEffect(() => { (async () => { try {
    if (fixedGroup) {
      const pulse = (await listPacks(fixedGroup)).find((p) => p.id === PACK_ID)?.version;
      setGroups([{ id: fixedGroup, workerCount: 1, pulse }]);
      return;
    }
    const gs = await listGroups();
    const withPack = await Promise.all(gs.map(async (g) => { try { return { ...g, pulse: (await listPacks(g.id)).find((p) => p.id === PACK_ID)?.version }; } catch { return g; } }));
    setGroups(withPack); setGroup(withPack.find((g) => g.workerCount)?.id ?? withPack[0]?.id);
  } catch (e) { setErr(String(e)); } })(); }, [fixedGroup]);
  useEffect(() => { listDatasets().then(setDatasets).catch((e) => setErr(String(e))); }, []);
  // Reset during render (not in an effect): the dataset picker follows the saved dataset, and ticked sources (and the
  // remembered previous deployment) clear whenever a worker group is chosen, before that group's own data arrives.
  const datasetChanged = useChanged(settings.dataset);
  if (datasetChanged) setDsChoice(settings.dataset);
  const groupChanged = useChanged(activeGroup);
  if (groupChanged && activeGroup) { setPicked([]); setMode('selected'); setPrevDeploy(undefined); setFull(false); }
  useEffect(() => { if (activeGroup) listInputs(activeGroup).then(setInputs).catch((e) => setErr(String(e))); }, [activeGroup]);
  useEffect(() => { if (activeGroup) kvGet<Deployment | null>(`deployments/${activeGroup}`, null).then(setPrevDeploy); }, [activeGroup]);
  // Once the previous deployment for this group has loaded, derive the starting mode/ticks from it (during render,
  // not inside the effect above): the source mode follows defaultSourceMode, and its inputs start ticked.
  const prevChanged = useChanged(prevDeploy);
  if (prevChanged && prevDeploy !== undefined) { setMode(defaultSourceMode(prevDeploy ?? undefined)); setPicked(prevDeploy?.inputs ?? []); }

  const dataset = dsChoice === NEW ? dsNew.trim() : dsChoice;
  const dsValid = DATASET_RE.test(dataset);
  const formatOf = (id: string) => datasetFormat(datasets, id);
  const isNewDs = !formatOf(dataset);
  const curFormat = formatOf(settings.dataset);
  // Moving between formats needs a new destination too: an existing one is never switched in place (CRIBL-37604).
  const destination = destinationFor(settings, datasets, dataset);
  const blocked = !activeGroup || !dsValid || (mode === 'selected' && picked.length === 0);
  const sources = useMemo(() => (mode === 'all' ? [] : picked), [mode, picked]);
  // Spec 016: same pack, dataset and destination as the last deployment → only the route (the source filter) changes.
  const installed = groups.find((g) => g.id === activeGroup)?.pulse;
  const onlyRoute = !full && dataset === settings.dataset && routeOnly(prevDeploy, installed, settings, dataset, destination);
  const delta = sourceDelta(prevDeploy?.inputs, sources);
  const deployed = new Set(prevDeploy?.inputs ?? []);
  const deltaText = mode === 'all' ? 'Watches every non-internal source (instead of the ticked ones).'
    : prevDeploy && !prevDeploy.inputs.length ? `Watches only ${sources.join(', ')} (instead of every source).`
    : `${delta.added.length ? `Adds ${delta.added.join(', ')}.` : ''}${delta.added.length && delta.removed.length ? ' ' : ''}${delta.removed.length ? `Stops watching ${delta.removed.join(', ')}.` : ''}`;

  const steps = useMemo<Step[]>(() => {
    if (blocked) return [];
    if (onlyRoute) return sourceDelta(prevDeploy?.inputs, sources).same ? [] : routePlan(activeGroup!, sources, settings);
    const moving = dataset !== settings.dataset;
    // A move is a cut-over (spec 015): Search can't dcount across two datasets, and a union keeps only 50,000 events,
    // so Pulse can't read the old dataset alongside the new one. History restarts; the old data stays in Lake.
    const s = moving ? { ...settings, dataset, destination } : settings;
    const plan = deployPlan(activeGroup!, sources, s);
    if (!moving) return plan;
    return [...plan, { id: 'settings', title: `Use dataset ${dataset} in Pulse`, volatile: true, needs: ['dest', 'route', 'deploy'],
      detail: `app settings: dataset ${settings.dataset} → ${dataset}${destination !== settings.destination ? `, destination ${settings.destination} → ${destination}` : ''}. Pulse history restarts in ${dataset}; ${settings.dataset} keeps its data for its retention period. Re-apply the Alerts plan afterwards.`,
      run: async () => { await saveSettings(s); setSettings(s); return `saved — ${settings.destination !== destination ? `${settings.destination} is no longer routed to; delete it in Stream once you are done with it` : 'done'}`; } }];
  }, [blocked, onlyRoute, prevDeploy, activeGroup, sources, settings, dataset, destination, setSettings]);

  // ev/s for an input: the sum of events_1h across its Pulse entities (in this group), averaged over the hour.
  // Matches routeFilterFor's own id or "id:" prefix, since an entity's input can carry a transport suffix.
  const evPerSec = (id: string) => {
    const matches = fleet.filter((e) => e.group === activeGroup && (e.input === id || e.input.startsWith(`${id}:`)));
    if (!matches.length) return undefined;
    return Math.round(matches.reduce((t, e) => t + e.events_1h, 0) / 3600);
  };
  // Every input of the group, plus any deployed source the group no longer lists (so it can still be unticked).
  const sourceRows = [...inputs.map((i) => { const key = `${i.type}:${i.id}`, evs = evPerSec(key);
    return { key, label: `${i.id}  (${i.type}${i.port ? ` :${i.port}` : ''})${evs === undefined ? '' : ` · ~${evs} ev/s`}` }; }),
    ...[...deployed].filter((k) => !inputs.some((i) => `${i.type}:${i.id}` === k)).map((key) => ({ key, label: `${key} · not found on this group` }))];
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const dsItems = [...new Set([settings.dataset, ...datasets.map((d) => d.id)])].map((d) => { const f = formatOf(d);
    return { id: d, label: `${d}${f ? ` · ${FORMAT_LABEL[f] ?? f}` : ' · will be created'}${d === settings.dataset ? ' · current' : ''}` }; });
  const moveToParquet = () => { if (formatOf(PARQUET_TARGET)) setDsChoice(PARQUET_TARGET); else { setDsChoice(NEW); setDsNew(PARQUET_TARGET); } };

  const content = (<>
      {err && <div className="span-12"><Alert appearance="danger" title="Cribl API error">{err}</Alert></div>}
      <Section span={embedded ? 12 : 5} title="1 · Where"><div className="stack">
        {!fixedGroup && <SelectField label="Worker group" items={groups.map((g) => ({ id: g.id, label: `${g.id}${g.workerCount ? ` · ${g.workerCount} worker(s)` : ''}${g.pulse ? ` · Pulse ${g.pulse}${g.pulse !== PACK_VERSION ? ` (update to ${PACK_VERSION} available)` : ''}` : ' · Pulse not installed'}` }))}
          value={group ?? null} onChange={(k) => k && setGroup(String(k))} />}

        <SelectField label="Lake dataset (heartbeat metrics)" items={[...dsItems, { id: NEW, label: '+ New dataset…' }]}
          value={dsChoice} onChange={(k) => k && setDsChoice(String(k))} />
        {dsChoice === NEW && <TextField label="New dataset name" value={dsNew} onChange={setDsNew} placeholder="pulse_metrics_prod" />}
        {dataset && !dsValid && <Text variant="body-xs-normal" color="attention">Lowercase letters, digits and _ only; must start with a letter (2–63 chars).</Text>}
        {curFormat === 'json' && dataset === settings.dataset && <Alert appearance="info" title={`${settings.dataset} is stored as JSON`}>
          <div className="stack-sm"><Text variant="body-sm-normal">{`Parquet is faster to query. A Lake dataset can't safely change format in place, so Pulse writes to a new Parquet dataset (${PARQUET_TARGET}) through a new destination, and switches reads to it. History in Pulse restarts there: assets leave learning after ${settings.learning.LEARN_MIN} active minutes, and incidents and availability refill over the following day. ${settings.dataset} keeps its data for its retention period.`}</Text>
            <div><Button size="sm" variant="secondary" onClick={moveToParquet}>Move to Parquet</Button></div></div></Alert>}
        {dsValid && isNewDs && <Text variant="body-xs-normal" color="subtle">{`${dataset} will be created in Lake (Parquet, Search v2, 30 days).`}</Text>}
        {dsValid && !READABLE_DATASETS.includes(dataset) && <Alert appearance="warning" title="Pulse can't read this dataset yet">
          {`Search only lets the app query datasets named in config/policies.yml. Add GET /m/default_search/search/datasets/${dataset} and GET /m/default_search/search/datasets/${dataset}_5m (the rollup) there and upgrade the app, or the Overview stays empty.`}</Alert>}

        <Text variant="body-sm-semibold">Sources to watch</Text>
        <RadioGroup name="srcmode" value={mode} layout="vertical" onChange={(e) => setMode(e.target.value as 'all' | 'selected')}>
          <Radio value="all">All non-internal sources (new sources picked up automatically)</Radio>
          <Radio value="selected">Only the sources I tick (recommended)</Radio>
        </RadioGroup>
        {mode === 'all' && <Alert appearance="warning" title="Every event, on every source, is copied into the Pulse pack">
          {`That costs ~${OBSERVER_US_PER_EVENT} µs of worker CPU per event, about ${OBSERVER_US_PER_EVENT / 100} core per 10k events/s. Watch only the sources whose senders you need to track.`}</Alert>}
        {mode === 'selected' && (<>
          <div className="row">
            <Button size="sm" variant="secondary" onClick={() => setPicked(inputs.map((i) => `${i.type}:${i.id}`))}>Tick all</Button>
            <Button size="sm" variant="secondary" onClick={() => setPicked([])}>Clear</Button>
            <Text variant="body-xs-normal" color="subtle">{`${picked.length}/${inputs.length} selected`}</Text>
          </div>
          <div className="inputs">{sourceRows.map((r) => { const on = picked.includes(r.key), was = deployed.has(r.key);
            // Spec 016: the deployed sources start ticked; the tag says what the plan does to each one.
            const tag = was ? (on ? <Tag size="sm" color="success">deployed</Tag> : <Tag size="sm" color="warning">will stop</Tag>)
              : on && prevDeploy ? <Tag size="sm" color="info">will be added</Tag> : null;
            return <div key={r.key} className="row"><Checkbox checked={on} onChange={() => toggle(r.key)}>{r.label}</Checkbox>{tag}</div>; })}</div>
          {picked.length === 0 && <Text variant="body-xs-normal" color="attention">Tick at least one source.</Text>}
        </>)}
        {prevDeploy && <Text variant="body-xs-normal" color="subtle">{`Last deployed ${new Date(prevDeploy.at).toLocaleString()}: ${prevDeploy.inputs.length ? `${prevDeploy.inputs.length} source(s)` : 'all sources'}, pack ${prevDeploy.pack}.`}</Text>}
        {onlyRoute && !blocked && (delta.same
          ? <Alert appearance="info" title="Nothing to change">{'The sources match the last deployment. Tick or untick a source to change what Pulse watches, or tick Full re-deploy below.'}</Alert>
          : <Alert appearance="info" title="Only the route changes">{`${deltaText} The pack, the dataset and the destination are already in place and are not touched.`}</Alert>)}
        {prevDeploy && installed === PACK_VERSION && dataset === settings.dataset &&
          <Checkbox checked={full} onChange={() => setFull((f) => !f)}>{'Full re-deploy (pack, dataset and destination too)'}</Checkbox>}
        <div className="stack-sm"><Text variant="body-sm-semibold">What Pulse watches on these sources</Text>
          <div className="row wrap"><Tag color="accent">Missing asset</Tag><Tag color="accent">Collective silence</Tag><Tag color="accent">Delayed data</Tag><Tag color="accent">Low volume</Tag><Tag color="accent">Clock ahead</Tag></div>
          <Text variant="body-xs-normal" color="subtle">{`Pack ${PACK_ID} ${PACK_VERSION} also names senders when the host field is missing, and sends a few samples per source every 15 minutes for the Key Advisor on the Identity page.`}</Text></div>
      </div></Section>
      <div className={embedded ? 'span-12' : 'span-7'}><PlanRunner key={`${activeGroup}|${dataset}|${mode}|${picked.join(',')}|${full}`} title={`2 · Plan for ${activeGroup ?? '…'}`} steps={steps} onDone={() => void refresh()} /></div>
  </>);
  if (embedded) return <div className="grid">{content}</div>;
  return (
    <Page crumbs={[{ label: 'Deploy' }]} sub="One worker group at a time: dataset moves and full re-deploys">{content}</Page>
  );
}
