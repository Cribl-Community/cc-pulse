import { useEffect, useState } from 'react';
import { Alert, Button, Drawer, SelectField, Text, TextArea, TextField } from '@capra/core';
import { CRIT, saveAssetInfo, type AssetInfo, type Criticality } from '../lib/inventory';
import { usePulse } from '../state';

const CRIT_ITEMS = ([1, 2, 3, 4] as Criticality[]).map((c) => ({ id: String(c), label: CRIT[c].long,
  description: ['Revenue, security or safety impact — page someone', 'Important; fix within hours', 'Normal business hours', 'Lab, test, best effort'][c - 1] }));

/** Edit the slow-changing facts about an asset (owner, criticality…). Saved to app KV + lookup pulse_assets.csv. */
export function AssetInfoDrawer({ asset, isOpen, onClose }: { asset: string; isOpen: boolean; onClose: () => void }) {
  const { rawInventory: inventory, setInventory, clusters, rules, entities } = usePulse();
  const [f, setF] = useState<AssetInfo>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  useEffect(() => { if (isOpen) { setF(inventory[asset] ?? {}); setErr(undefined); } }, [isOpen, asset]); // eslint-disable-line
  const teams = [...new Set(Object.values(inventory).map((i) => i.team).filter(Boolean))].sort() as string[];
  const set = (k: keyof AssetInfo) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  async function save() {
    setBusy(true); setErr(undefined);
    try {
      const r = await saveAssetInfo(inventory, asset, f, { clusters, rules, seen: entities.map((x) => ({ asset: String(x.asset), input: String(x.input) })) }); setInventory(r.inv);
      if (r.lookupError) setErr(`Saved in Pulse, but the Search lookup pulse_assets.csv was not updated (alerts will not show the owner yet): ${r.lookupError}`);
      else onClose();
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  return (
    <Drawer isOpen={isOpen} onClose={onClose} title={`Asset info · ${asset}`} width={480}
      footer={<div className="row"><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" pending={busy} onClick={() => void save()}>Save</Button></div>}>
      <div className="stack">
        <Text color="subtle">Facts that rarely change. They rank the Overview, appear on every page and are added to alert messages ("Pulse [P1 · Payments] …").</Text>
        <SelectField label="Criticality" placeholder="Not classified" items={CRIT_ITEMS} value={f.criticality ? String(f.criticality) : null}
          onChange={(v) => setF((p) => ({ ...p, criticality: v ? (Number(v) as Criticality) : undefined }))} />
        <TextField label="Owning team" value={f.team ?? ''} onChange={set('team')} helperText={teams.length ? `Existing: ${teams.slice(0, 6).join(', ')}` : undefined} />
        <TextField label="Contact / on-call" value={f.contact ?? ''} onChange={set('contact')} placeholder="#team-oncall, team@example.com" />
        <div className="row2"><TextField label="Environment" value={f.environment ?? ''} onChange={set('environment')} placeholder="prod" />
          <TextField label="Location" value={f.location ?? ''} onChange={set('location')} placeholder="Paris DC2" /></div>
        <TextArea label="Description" value={f.description ?? ''} onChange={set('description')} autoSize={{ minRows: 2, maxRows: 5 }} />
        <TextField label="Runbook URL" value={f.runbook ?? ''} onChange={set('runbook')} placeholder="https://…" />
        <TextField label="Tags" value={f.tags ?? ''} onChange={set('tags')} placeholder="pci, k8s" />
        <TextField label="HA cluster" value={f.cluster ?? ''} onChange={set('cluster')} placeholder="fw-par-edge" helperText={Object.keys(clusters).length ? `Existing: ${Object.keys(clusters).slice(0, 5).join(', ')}. A silent member is covered while enough of its cluster sends.` : 'Assets that back each other up. A silent member is covered while enough of its cluster sends.'} />
        {err && <Alert appearance="warning" title="Not fully saved">{err}</Alert>}
        {f.updatedAt && <Text variant="body-xs-normal" color="subtle">Last updated {new Date(f.updatedAt).toLocaleString()}</Text>}
      </div>
    </Drawer>);
}
