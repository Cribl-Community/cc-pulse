import { useCallback, useEffect, useRef } from 'react';

/**
 * Starts a page's data load after mount, in useEffect, never during render. `start` gets an `alive()` that
 * turns false on unmount (each mount has its own flag, so StrictMode's mount, unmount, mount drops the first
 * load's results). The returned `alive()` follows the mounted component, for later reloads (Refresh, after a run).
 * A result that arrives after unmount is ignored instead of updating state on a component that is gone.
 */
export function useMountedLoad(start: (alive: () => boolean) => void): () => boolean {
  const mounted = useRef(false);
  useEffect(() => {
    let on = true;
    mounted.current = true;
    start(() => on);
    return () => { on = false; mounted.current = false; };
  }, []); // eslint-disable-line
  return useCallback(() => mounted.current, []);
}
