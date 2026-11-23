/* No imports: api.ts reads window at import time, so this module must stay standalone. */

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/**
 * Builds a Cribl route filter expression that matches an input exactly, or by a ":" suffix
 * (e.g. "tcp:in_a" matches "tcp:in_a" and "tcp:in_a:tcp", never "tcp:in_ab"). No array literal,
 * no arrow function — this runs once per event on the worker, so it must allocate nothing.
 */
export function routeFilterFor(inputs: string[], fallback: string): string {
  if (!inputs.length) return fallback;
  return inputs
    .map((id) => { const e = esc(id); return `__inputId === '${e}' || __inputId.startsWith('${e}:')`; })
    .join(' || ');
}

/**
 * Defaults the Deploy page's source-selection mode. 'all' only when the group's previous
 * deployment explicitly watched every source (prev.inputs is empty); 'selected' otherwise,
 * including when there is no previous deployment at all.
 */
export function defaultSourceMode(prev?: { inputs: string[] }): 'all' | 'selected' {
  return prev && prev.inputs.length === 0 ? 'all' : 'selected';
}

/** Worker CPU per watched event, in µs, for pack 1.3 — measured in spike 011. */
export const OBSERVER_US_PER_EVENT = 2.5;
