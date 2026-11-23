/* The one reader of the platform globals. Everything is read on each call, never cached in a module constant.
   The app never defines or assigns these globals; the platform does. */
declare global { interface Window { CRIBL_API_URL?: string; CRIBL_BASE_PATH?: string } }

export type HostMode = 'live' | 'demo' | 'unwired';

export function inFrame(): boolean {
  try { return window.parent !== window; } catch { return true; }
}

export function apiBase(): string {
  return (window.CRIBL_API_URL ?? '/api/v1').replace(/\/$/, '');
}

/** The Cribl host's origin, for links in alert messages (spec 029): `document.referrer`, else
 *  `location.ancestorOrigins[0]`. Undefined when neither is known (the messages then leave the incident link out). */
export function hostOrigin(): string | undefined {
  try {
    if (document.referrer) return new URL(document.referrer).origin;
  } catch { /* not a URL */ }
  try {
    const a = (location as Location & { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (a && a.length) return a[0];
  } catch { /* not available */ }
  return undefined;
}

export function hostMode(): HostMode {
  if (window.CRIBL_API_URL) return 'live';
  if (inFrame()) return 'unwired';
  return import.meta.env.DEV ? 'demo' : 'live';
}
