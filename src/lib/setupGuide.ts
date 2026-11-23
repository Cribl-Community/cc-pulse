import { createContext, useContext } from 'react';

const PRIMARY = ['/incidents', '/assets', '/groups', '/identity'];

/** Primary pages only: Overview, Incidents, Assets, Worker groups, Identity (and their children), never /settings/*. */
export function isPrimaryRoute(pathname: string): boolean {
  if (pathname === '/' || pathname === '') return true;
  return PRIMARY.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

export const GuideCtx = createContext<{ openGuide: () => void }>({ openGuide: () => {} });
/** Reopens the guide whatever the setup state. */
export const useSetupGuide = () => useContext(GuideCtx);
