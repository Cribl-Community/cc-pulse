// Reachability text for a Setup fleet source (spec 039 Drawer). Pure: no React, no DOM.
import type { PackReach } from './packSources';
import type { FleetSource } from './demo';

/** packSources' reachability for a pack source; an own input has none. */
export function reachOf(s: FleetSource): PackReach | undefined {
  if (!s.pack) return undefined;
  return s.reach ?? (s.staysInPack ? 'no' : 'yes');
}

/** `in pack <pack> · stays in the pack` / `· maybe` / `· yes` (031's three outcomes). */
export function reachText(s: FleetSource): string {
  const r = reachOf(s);
  if (!r) return '';
  return `in pack ${s.pack} · ${r === 'no' ? 'stays in the pack' : r}`;
}
