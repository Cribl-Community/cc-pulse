import type { Row } from './api';

const EXPECTED = ['ok', 'late', 'missing', 'delayed', 'acked'];
const CURRENT = ['ok', 'late', 'delayed'];
const MUTED = ['muted', 'maintenance'];

/** Per (worker_group, input) source rows derived from entity rows. Mirrors `sourceQuery` in kql.ts. Pure. */
export function sourcesOf(rows: Row[]): Row[] {
  const groups = new Map<string, { worker_group: string; input: string; rows: Row[] }>();
  for (const r of rows) {
    const worker_group = String(r.worker_group ?? ''), input = String(r.input ?? '');
    const k = JSON.stringify([worker_group, input]);
    let g = groups.get(k);
    if (!g) groups.set(k, g = { worker_group, input, rows: [] });
    g.rows.push(r);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return [...groups.values()]
    .sort((a, b) => cmp(a.worker_group, b.worker_group) || cmp(a.input, b.input))
    .map((g) => {
      const n = (f: (s: string) => boolean) => g.rows.filter((r) => f(String(r.state))).length;
      const expected = n((s) => EXPECTED.includes(s));
      const missing = n((s) => s === 'missing');
      const missing_list = [...new Set(g.rows.filter((r) => r.state === 'missing').map((r) => String(r.asset)))].sort(cmp);
      return {
        worker_group: g.worker_group, input: g.input,
        expected, current: n((s) => CURRENT.includes(s)),
        missing, late: n((s) => s === 'late'), learning: n((s) => s === 'learning'),
        muted: n((s) => MUTED.includes(s)),
        missing_list,
        health: missing > 0 ? 'degraded' : expected === 0 ? 'learning' : 'healthy',
      };
    });
}
