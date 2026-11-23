import { Link as RouterLink } from 'react-router-dom';
import { Checkbox, Link, Switch, Tag, Text } from '@capra/core';
import { Section } from './ui';
import { LOAD_ITEMS } from '../lib/loadLabels';
import type { AppSettings } from '../lib/settings';

type Props = {
  settings: AppSettings;
  alertsOn: boolean;
  onAlertsOn: (on: boolean) => void;
  enabled: boolean;
  onEnabled: (on: boolean) => void;
  /** Lane phase while a fleet run exists: done, running, failed, or skipped. */
  phase?: string;
  /** Saved search / lookup counts and outdated searches (from loadFleet). */
  info?: { saved: number; lookups: number; outdated: number } | null;
};

function notifyLine(s: AppSettings): string {
  const bits = [...s.notify.targets];
  const email = s.notify.email?.trim();
  if (email) bits.push(`email ${email}`);
  return bits.length ? bits.join(', ') : '\u2014';
}

function searchLoadLabel(load: AppSettings['searchLoad']): string {
  return LOAD_ITEMS.find((i) => i.id === load)?.label ?? 'Standard';
}

/** Cribl Search alerts on Setup: compact read-only card; search load is edited on the Alerts tab. */
export function SetupAlerts({ settings, alertsOn, onAlertsOn, enabled, onEnabled, phase, info }: Props) {
  return (
    <Section span={12} className="setup-alerts-card" title={
      <span className="setup-alerts-title">
        <Checkbox aria-label="include Search in this deploy" checked={alertsOn} onChange={() => onAlertsOn(!alertsOn)} />
        <Text variant="body-md-semibold">Cribl Search alerts</Text>
        <Text variant="body-sm-normal" color="subtle">saved searches, notifications and lookups {'\u2014'} same plan, after the groups</Text>
        <span className="sp" />
        {info && info.outdated > 0 ? <Tag size="sm" color="warning">{`${info.outdated} searches outdated`}</Tag> : null}
        {phase ? <Text>{` ${phase}`}</Text> : null}
      </span>
    }>
      <div className="setup-alerts-line2">
        <Text>{`Reads ${settings.dataset} \u00b7 Notify ${notifyLine(settings)} \u00b7 `}</Text>
        <Link as={RouterLink} to="/settings/alerts">change in Alerts</Link>
        <Text>{' \u00b7 '}</Text>
        <Switch aria-label="Schedules enabled" checked={enabled} onChange={(e) => onEnabled(e.target.checked)} />
        <Text>Schedules enabled</Text>
        {info ? <><Text>{' \u00b7 '}</Text><Text>{`${info.saved} saved searches \u00b7 ${info.lookups} lookups`}</Text></> : null}
        <Text>{` \u00b7 Search load: ${searchLoadLabel(settings.searchLoad)}`}</Text>
      </div>
    </Section>
  );
}