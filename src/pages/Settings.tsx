import { EmbeddedPage, Page, Section } from '../components/ui';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { useState, type ComponentType } from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';
import { Alert, Button, PasswordField, SelectField, TabNav, Text, TextField } from '@capra/core';
import { MODELS, normalizeRollup, saveAi, saveSettings, validDestination, type AiProvider } from '../lib/settings';
import { refreshHelper, rollupLine } from '../lib/loadLabels';
import { DEFAULT_REFRESH, type RefreshChoice } from '../lib/refresh';
import { SETTINGS_TABS, isSettingsTab, settingsPath, type SettingsTab } from '../lib/nav';
import { usePulse } from '../state';
import { useSetupGuide } from '../lib/setupGuide';
import { Thresholds } from './Thresholds';
import { Policies } from './Policies';
import { Alerts } from './Alerts';
import { Setup } from './Setup';

const REFRESH_ITEMS = [{ id: '1m', label: 'Every 1 minute' }, { id: '2m', label: 'Every 2 minutes' }, { id: '5m', label: 'Every 5 minutes' }, { id: '15m', label: 'Every 15 minutes' }, { id: 'manual', label: 'Manual' }];
const ROLLUP_REASON: Record<string, string> = {
  'no-search': 'the pulse_rollup saved search is not published', disabled: 'the pulse_rollup search is disabled',
  'other-dataset': 'the pulse_rollup search reads another dataset', 'wrong-target': 'the pulse_rollup search writes elsewhere',
  empty: 'no rollup data yet', behind: 'behind, reading raw data', 'not-backfilled': 'not backfilled over the lookback yet',
};
const ROLLUP_ITEMS = [{ id: 'auto', label: 'Auto' }, { id: 'off', label: 'Off' }];
const PROVIDERS = [{ id: 'cribl', label: 'Cribl AI (this organization’s AI Settings)' }, { id: 'anthropic', label: 'Anthropic' }, { id: 'openai', label: 'OpenAI' }];

/* Spec 013 §1: Settings hosts the config pages as header tabs, one route each: /settings/<tab>.
   Tabs: SETTINGS_TABS in lib/nav (General · Setup · Thresholds · Policies · Alerts). */
const TAB_CONTENT: Record<SettingsTab, ComponentType> = { general: General, setup: Setup, thresholds: Thresholds, policies: Policies, alerts: Alerts };

/** Capra TabNav for Settings. Each tab is its own path, so the selected tab comes from the URL. */
export function SettingsTabs({ active }: { active: SettingsTab }) {
  return <TabNav aria-label="Settings sections" activeKey={active} items={SETTINGS_TABS.map((t) => ({ key: t.key, name: t.name, href: settingsPath(t.key) }))} />;
}

/** /settings/:tab — the Settings header band with the tabs, and the tab's page below it. */
export function Settings() {
  const { tab } = useParams();
  const { search } = useLocation();
  if (tab === 'deploy') return <Navigate to={settingsPath('setup', search)} replace />;
  if (!isSettingsTab(tab)) return <Navigate to={settingsPath('general', search)} replace />;
  const Content = TAB_CONTENT[tab];
  return (
    <Page title="Settings" nav={<SettingsTabs active={tab} />}>
      <EmbeddedPage><ErrorBoundary key={tab}><Content /></ErrorBoundary></EmbeddedPage>
    </Page>
  );
}

function General() {
  const { ai, setAi, settings, setSettings, rollupVerdict } = usePulse();
  const { openGuide } = useSetupGuide();
  const [key, setKey] = useState('');
  const [saved, setSaved] = useState(false);
  async function save() { setAi(await saveAi(ai, key || undefined)); await saveSettings(settings); setKey(''); setSaved(true); setTimeout(() => setSaved(false), 2500); }
  return (
    <Page crumbs={[{ label: 'Settings' }]} sub="AI provider and data locations">
      <Section span={6} title="AI"><div className="stack">
        <SelectField label="Provider" items={PROVIDERS} value={ai.provider}
          onChange={(k) => { if (!k) return; const p = String(k) as AiProvider; setAi({ provider: p, model: MODELS[p][0] }); }} />
        {ai.provider === 'cribl'
          ? <Text color="subtle">Uses the model and guardrails your admin configured in Cribl Settings → AI Settings. No key needed, nothing leaves Cribl.</Text>
          : <>
            <SelectField label="Model" items={MODELS[ai.provider].map((m) => ({ id: m, label: m }))} value={ai.model} onChange={(k) => k && setAi({ ...ai, model: String(k) })} />
            <PasswordField label={`API key ${ai.apiKeySet ? '(stored — leave blank to keep)' : ''}`} value={key} onChange={setKey} />
            <Text variant="body-xs-normal" color="subtle">Stored encrypted in the app KV store and injected by the platform proxy; the browser never reads it back.</Text></>}
      </div></Section>
      <Section span={6} title="Data"><div className="stack">
        <TextField label="Lake dataset (pulse.heartbeat metrics)" value={settings.dataset} onChange={(v) => setSettings({ ...settings, dataset: v })} />
        <TextField label="Stream destination id" value={settings.destination} onChange={(v) => setSettings({ ...settings, destination: v })} />
        {!validDestination(settings.destination) && <Text variant="body-xs-normal" color="attention">Letters, digits, _ and - only (for example pulse_lake): Stream refuses other characters.</Text>}
        <TextField label="Default observer filter (all sources)" value={settings.routeFilter} onChange={(v) => setSettings({ ...settings, routeFilter: v })} />
        <SelectField label="Refresh" items={REFRESH_ITEMS} value={settings.refresh ?? DEFAULT_REFRESH}
          onChange={(k) => k && setSettings({ ...settings, refresh: String(k) as RefreshChoice })}
          helperText={refreshHelper(settings.searchLoad, settings.rollCall)} />
        <SelectField label="Rollup" items={ROLLUP_ITEMS} value={settings.rollup ?? 'auto'}
          onChange={(k) => k && setSettings({ ...settings, rollup: normalizeRollup(String(k)) })}
          helperText="Auto reads the rollup dataset when it is current; Off always reads the raw minute data." />
        {rollupLine(settings.searchLoad)
          ? <Text variant="body-xs-normal" color="subtle">{rollupLine(settings.searchLoad)}</Text>
          : rollupVerdict && <Text variant="body-xs-normal" color="subtle">{rollupVerdict.use ? 'Rollup: in use' : `Rollup: ${ROLLUP_REASON[rollupVerdict.reason]}`}</Text>}
      </div></Section>
      <div className="span-12 row"><Button variant="primary" onClick={() => void save()}>Save settings</Button>{saved && <Alert appearance="success" layout="inline">Saved</Alert>}<Button variant="secondary" onClick={openGuide}>Show the setup guide</Button></div>
    </Page>
  );
}
