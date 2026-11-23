/* Spec 013 §1 navigation consolidation: the config pages live as tabs under /settings/<tab>, and their
   old top-level routes redirect there. Pure helpers, kept out of the .tsx files so those only export components. */

export type SettingsTab = 'general' | 'setup' | 'thresholds' | 'policies' | 'alerts';
export const SETTINGS_TABS: readonly { key: SettingsTab; name: string }[] = [
  { key: 'general', name: 'General' },
  { key: 'setup', name: 'Setup' },
  { key: 'thresholds', name: 'Thresholds' },
  { key: 'policies', name: 'Policies' },
  { key: 'alerts', name: 'Alerts' },
];
/** Old top-level routes that are now Settings tabs (links in alerts and docs still point at them). */
export const LEGACY_SETTINGS_ROUTES: readonly SettingsTab[] = ['thresholds', 'policies', 'alerts'];

export const isSettingsTab = (t: string | undefined): t is SettingsTab => SETTINGS_TABS.some((s) => s.key === t);

/** `/settings/<tab>` plus the query string, e.g. settingsPath('policies', '?tab=rules') → '/settings/policies?tab=rules'.
    An unknown tab goes to General. */
export function settingsPath(tab: string | undefined, search = ''): string {
  const q = search && !search.startsWith('?') ? `?${search}` : search;
  return `/settings/${isSettingsTab(tab) ? tab : 'general'}${q === '?' ? '' : q}`;
}
