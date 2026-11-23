import { useEffect, useState } from 'react';
import { EmptyState } from '@capra/core';
import { installThemeBridge, type HostTheme } from '../host-theme';

export const UNWIRED_TITLE = "Pulse can't reach Cribl";
export const UNWIRED_BODY = "Live Preview loaded Pulse without Cribl's connection script, so there is no Cribl API to call. Reopen Live Preview (Exit, then Apps → Live Preview). If it happens again, restart “npm run dev” first.";

/** Full-page state for Live Preview loaded without Cribl's init script. Makes no requests. */
export function Unwired() {
  const [theme, setTheme] = useState<HostTheme>(() => (typeof document !== 'undefined' && document.body?.classList.contains('dark') ? 'dark' : 'light'));
  useEffect(() => installThemeBridge(setTheme), []);
  return (
    <div className="main">
      <EmptyState size="lg" illustration="EmptyFolder" theme={theme} title={UNWIRED_TITLE} description={UNWIRED_BODY} />
    </div>
  );
}
