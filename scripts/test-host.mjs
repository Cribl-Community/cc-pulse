// Unit tests for src/lib/host.ts. Bundles it with esbuild twice (DEV true / false) and stubs `window`.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tmp = mkdtempSync(join(tmpdir(), 'pulse-host-'));
const load = async (dev) => {
  const out = join(tmp, `host-${dev}.mjs`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [join(root, 'src/lib/host.ts'), '--bundle', '--format=esm',
    `--define:import.meta.env.DEV=${dev}`, `--outfile=${out}`], { stdio: 'pipe' });
  return import(out);
};
const dev = await load(true), prod = await load(false);
const setWin = (o) => { globalThis.window = o; };
const top = () => { const w = {}; w.parent = w; return w; };
const framed = () => ({ parent: {} });

// apiBase: unset, trimmed, set after import
setWin(top()); assert.equal(dev.apiBase(), '/api/v1');
window.CRIBL_API_URL = 'https://x/api/v1/'; assert.equal(dev.apiBase(), 'https://x/api/v1');
window.CRIBL_API_URL = 'https://y/api/v1'; assert.equal(dev.apiBase(), 'https://y/api/v1');

// T2 rows
const w1 = framed(); w1.CRIBL_API_URL = 'https://x/api/v1'; setWin(w1);
assert.equal(dev.hostMode(), 'live'); assert.equal(prod.hostMode(), 'live');
setWin(top()); assert.equal(dev.hostMode(), 'demo');
assert.equal(prod.hostMode(), 'live');
setWin(framed()); assert.equal(dev.hostMode(), 'unwired'); assert.equal(prod.hostMode(), 'unwired');
// read on every call
window.CRIBL_API_URL = 'https://z/api/v1'; assert.equal(dev.hostMode(), 'live');

// inFrame
setWin(top()); assert.equal(dev.inFrame(), false);
setWin(framed()); assert.equal(dev.inFrame(), true);
setWin({ get parent() { throw new Error('cross-origin'); } }); assert.equal(dev.inFrame(), true);
assert.equal(dev.hostMode(), 'unwired');
console.log('host tests ok');
