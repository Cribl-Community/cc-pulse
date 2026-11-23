import { useState } from 'react';
import { Alert, Button, Modal, PasswordField, Radio, RadioGroup, SelectField, Text, TextField } from '@capra/core';
import { SendTest } from './SendTest';
import { createTarget } from '../lib/channelsApi';
import { PD_V2_HELP, confirmText, nextTargetId, validChannel, withPrefix, type ChannelForm, type Preset } from '../lib/channels';

const LABELS: Record<Preset, string> = { slack: 'Slack', teams: 'Microsoft Teams', pagerduty: 'PagerDuty', pagerduty_v2: 'PagerDuty (Events v2, auto-resolve)', webhook: 'Webhook' };
const SEVERITY = ['critical', 'error', 'warning', 'info'].map((id) => ({ id, label: id }));
const AUTH = ['none', 'bearer', 'basic'].map((id) => ({ id, label: id }));
const SNS = 'sns';

// Local state only: unmounting the modal (the parent renders it while open) drops every field, secrets included.
export function AddChannelModal({ existingIds, onClose, onCreated }: { existingIds: string[]; onClose: () => void; onCreated: (id: string) => Promise<void> | void }) {
  const [choice, setChoice] = useState<string>('slack');
  const [preset, setPreset] = useState<Preset>();
  const [form, setForm] = useState<ChannelForm>({ id: '' });
  const set = (patch: Partial<ChannelForm>) => setForm((f) => ({ ...f, ...patch }));
  const next = () => {
    if (choice === SNS) return;
    setPreset(choice as Preset);
    setForm({ id: nextTargetId(choice as Preset, existingIds), severity: 'error', auth: 'none' });
  };
  const err = preset ? validChannel(preset, form, existingIds) : null;
  const idErr = err && (/ID/.test(err) || /already exists/.test(err)) ? err : undefined;
  const fieldErr = err && !idErr ? err : undefined;
  const bad = !preset || err !== null;
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [created, setCreated] = useState<string>();
  const create = async () => {
    if (!preset) return;
    setBusy(true); setFailure(undefined);
    try {
      await createTarget(preset, form, existingIds);
      setCreated(form.id);
      await onCreated(form.id);
    } catch (e) {
      setFailure(e instanceof Error ? e.message : String(e));
      setConfirming(false);
    } finally { setBusy(false); }
  };

  if (created && preset) {
    return (
      <Modal isOpen size="md" title="Add channel" onClose={onClose} footer={<Button onClick={onClose}>Done</Button>}>
        <div className="stack">
          <Alert appearance="success" title="Channel created">{`${created} (${LABELS[preset]}) was created and is now used for Pulse alerts.`}</Alert>
          <SendTest targetId={created} />
        </div>
      </Modal>
    );
  }

  if (confirming && preset) {
    return (
      <Modal isOpen size="md" title="Confirm" onClose={onClose} footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button disabled={busy} onClick={() => { void create(); }}>Create</Button>
        </>
      }>
        <Text>{confirmText(form.id, LABELS[preset])}</Text>
      </Modal>
    );
  }

  const footer = (
    <>
      <Button variant="secondary" onClick={onClose}>Cancel</Button>
      {preset ? <Button disabled={bad} onClick={() => setConfirming(true)}>Create</Button>
        : <Button disabled={choice === SNS} onClick={next}>Next</Button>}
    </>
  );

  return (
    <Modal isOpen size="md" title="Add channel" onClose={onClose} footer={footer}>
      {!preset ? (
        <div className="stack">
          <RadioGroup name="channel-preset" aria-label="Channel type" value={choice} layout="vertical" onChange={(e) => setChoice(e.target.value)}>
            {(Object.keys(LABELS) as Preset[]).map((p) => <Radio key={p} value={p}>{LABELS[p]}</Radio>)}
            <Radio value={SNS}>AWS SNS → create in Cribl</Radio>
          </RadioGroup>
          {choice === 'pagerduty_v2' && <Text>{PD_V2_HELP}</Text>}
          {choice === SNS &&<Text>Pulse can't create SNS targets. <a href="/settings/notification-targets" target="_top">Create one in Cribl</a>, then it shows up here.</Text>}
        </div>
      ) : (
        <div className="stack">
          {failure && <Alert appearance="danger" title="Couldn't create the channel">{failure}</Alert>}
          <TextField label="Target ID" value={form.id} onChange={(v) => set({ id: withPrefix(v) })}
            appearance={idErr ? 'danger' : 'default'} helperText={idErr} />
          {preset === 'pagerduty_v2' && <Text>{PD_V2_HELP}</Text>}
          {preset === 'pagerduty_v2' ? (
            <PasswordField label="Routing key" value={form.routingKey ?? ''} onChange={(v) => set({ routingKey: v })} appearance={fieldErr ? 'danger' : 'default'} helperText={fieldErr} />
          ) : preset === 'pagerduty' ? (
            <>
              <PasswordField label="Routing key" value={form.routingKey ?? ''} onChange={(v) => set({ routingKey: v })} appearance={fieldErr ? 'danger' : 'default'} helperText={fieldErr} />
              <SelectField label="Severity" items={SEVERITY} value={form.severity ?? 'error'} onChange={(k) => k && set({ severity: String(k) })} />
            </>
          ) : (
            <PasswordField label={`${LABELS[preset]} URL`} value={form.url ?? ''} onChange={(v) => set({ url: v })} appearance={fieldErr ? 'danger' : 'default'} helperText={fieldErr} />
          )}
          {preset === 'webhook' && (
            <>
              <SelectField label="Authentication" items={AUTH} value={form.auth ?? 'none'} onChange={(k) => k && set({ auth: String(k) as ChannelForm['auth'] })} />
              {form.auth === 'bearer' && <PasswordField label="Token" value={form.token ?? ''} onChange={(v) => set({ token: v })} />}
              {form.auth === 'basic' && (
                <>
                  <TextField label="Username" value={form.username ?? ''} onChange={(v) => set({ username: v })} />
                  <PasswordField label="Password" value={form.password ?? ''} onChange={(v) => set({ password: v })} />
                </>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
