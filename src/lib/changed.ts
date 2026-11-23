import { useState } from 'react';

/**
 * True on the render where `value` differs (per `same`) from the value seen on the previous render, false otherwise
 * (including the first render). It stores the previous value in state and compares during render, React's
 * recommended replacement for `useEffect(() => setX(...), [value])`: a caller that resets state when this returns true
 * gets the reset applied before anything is committed, with no extra effect pass.
 * The stored value is always updated, whether or not the caller acts on the change.
 * `value` must not be a function (useState would call it as an initialiser).
 */
export function useChanged<T>(value: T, same: (a: T, b: T) => boolean = Object.is): boolean {
  const [prev, setPrev] = useState<T>(value);
  if (same(prev, value)) return false;
  setPrev(value);
  return true;
}

/** Element-wise `Object.is` for dependency-list-like tuples. */
export const sameDeps = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => Object.is(x, b[i]));
