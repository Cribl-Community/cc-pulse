// F6: App in unwired mode renders the "can't reach Cribl" state, mounts no PulseProvider, and makes no requests.
// Run: node scripts/test-unwired.mjs   (bundles src/App.tsx with esbuild, renders with react-dom/server)
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'pulse-unwired-'));
const entry = join(dir, 'entry.tsx');
const out = join(dir, 'entry.cjs');
try {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(entry, `import { renderToString } from 'react-dom/server';
import App from ${JSON.stringify(join(root, 'src/App.tsx'))};
export const render = () => renderToString(<App />);
`);
  execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=cjs', '--jsx=automatic',
    '--loader:.css=empty', '--loader:.svg=dataurl', '--loader:.png=dataurl', '--log-level=error',
    `--define:import.meta.env.DEV=false`, `--outfile=${out}`],
  { stdio: 'inherit', cwd: root, env: { ...process.env, NODE_PATH: join(root, 'node_modules') } });

  let calls = 0;
  globalThis.fetch = () => { calls++; return Promise.reject(new Error('no network')); };
  globalThis.XMLHttpRequest = function () { calls++; };
  const w = {}; w.parent = {}; // framed, no CRIBL_API_URL → unwired
  globalThis.window = w;
  const mod = await import(out);
  const html = mod.render().replace(/&#x27;|&#39;/g, "'").replace(/&gt;/g, '>').replace(/&quot;/g, '"');
  assert.ok(html.includes("Pulse can't reach Cribl"), 'title rendered');
  assert.ok(html.includes("Live Preview loaded Pulse without Cribl's connection script, so there is no Cribl API to call. Reopen Live Preview (Exit, then Apps"), 'body rendered');
  assert.ok(!html.includes('class="shell"'), 'no app shell');
  assert.equal(calls, 0, 'no fetch/XHR');
  const app = readFileSync(join(root, 'src/App.tsx'), 'utf8');
  assert.ok(app.indexOf("hostMode() === 'unwired'") < app.indexOf('<PulseProvider>'), 'unwired check precedes PulseProvider');
  const comp = readFileSync(join(root, 'src/components/Unwired.tsx'), 'utf8');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(comp), 'no literal colours');
  console.log('ok   unwired state');
} finally { rmSync(dir, { recursive: true, force: true }); }
