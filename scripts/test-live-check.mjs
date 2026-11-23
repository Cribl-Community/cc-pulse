#!/usr/bin/env node
// Offline tests for the browser layer of scripts/live-check.mjs (spec 020 §3, feature F7). No Playwright needed:
// checkPage() is driven with a fake page that emits the same events Playwright does.
// Run: node scripts/test-live-check.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiFailure, checkPage, shotsDir, transientFailure } from './live-check.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
let fails = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fails++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const B = 'http://localhost:5196';
const S = `${B}/api/v1/m/default_search/search/jobs`;

const GOOD_DOM = { rootEmpty: false, text: 'Overview Fleet 3 assets', maxCount: 3, assetLinks: 2 };
/** A fake Playwright page: `script(page)` runs after goto resolves and emits network/console events. */
function fakeContext(dom, script) {
  return { newPage: async () => {
    const p = new EventEmitter();
    p.goto = async () => { setTimeout(() => script?.(p), 0); };
    p.evaluate = async () => dom;
    p.close = async () => {};
    return p;
  } };
}
const req = (url, method = 'GET') => ({ url: () => url, method: () => method });
const res = (rq, status, body) => ({ url: rq.url, request: () => rq, status: () => status, ok: () => status >= 200 && status < 300, json: async () => body });
function call(p, url, method, status, body, failed = false) {
  const rq = req(url, method);
  p.emit('request', rq);
  p.emit('response', res(rq, status, body));
  p.emit(failed ? 'requestfailed' : 'requestfinished', rq);
}

/* apiFailure */
ok(/^page wrote on load: PUT \/api\/v1\/kvstore\/x → 405$/.test(apiFailure('PUT', '/api/v1/kvstore/x', 405)), '405 is reported as "page wrote on load" with method, URL and status');
ok(apiFailure('GET', '/api/v1/system/info', 403) === 'API GET /api/v1/system/info → 403', '403 names the URL and status');
ok(!!apiFailure('GET', '/u', 501) && !!apiFailure('GET', '/u', 500) && !!apiFailure('GET', '/u', 503), '501 and 5xx fail');
ok(apiFailure('GET', '/u', 404) === null && apiFailure('GET', '/u', 200) === null, '404 and 200 do not fail');

/* The page list takes SETTINGS_TABS from the source */
{
  const src = readFileSync(join(root, 'scripts/live-check.mjs'), 'utf8');
  ok(/bundle\('src\/lib\/nav\.ts'\)\)\.SETTINGS_TABS/.test(src) && !/\/settings\/(general|thresholds|policies|alerts|deploy)\b/.test(src), 'SETTINGS_TABS bundled from src/lib/nav.ts, no tab hard-coded');
  for (const p of ["'/'", "'/incidents'", "'/assets'", "'/groups'", '`/groups/${', "'/identity'", '`/settings/${t.key}`']) ok(src.includes(p), `page list includes ${p}`);
}

/* Waits on a job across the 1.5 s gaps between its status polls */
{
  let resultsAt = 0;
  const t0 = Date.now();
  const r = await checkPage(fakeContext(GOOD_DOM, async (p) => {
    call(p, S, 'POST', 200, { items: [{ id: 'j1' }] });
    for (let i = 0; i < 3; i++) { await sleep(1600); call(p, `${S}/j1/status`, 'GET', 200, { items: [{ status: 'running' }] }); }
    await sleep(1600); call(p, `${S}/j1/status`, 'GET', 200, { items: [{ status: 'completed' }] });
    await sleep(300); resultsAt = Date.now(); call(p, `${S}/j1/results?limit=1000&offset=0`, 'GET', 200, '');
  }), B, '/assets');
  const end = Date.now();
  ok(resultsAt > 0 && end >= resultsAt, `the page is judged only after the job's results request (${end - t0} ms)`);
  ok(r.started === 1, 'browser-started job is counted');
  ok(r.reasons.length === 0, `a clean page has no reasons (${r.reasons.join('; ')})`);
}

/* A failed job stops being pending */
{
  const t0 = Date.now();
  await checkPage(fakeContext(GOOD_DOM, async (p) => {
    call(p, S, 'POST', 200, { items: [{ id: 'j2' }] });
    await sleep(200); call(p, `${S}/j2/status`, 'GET', 200, { items: [{ status: 'failed' }] });
  }), B, '/incidents');
  ok(Date.now() - t0 < 6000, 'a failed job no longer holds the page');
}

/* Every failure signal is named */
{
  const r = await checkPage(fakeContext({ rootEmpty: true, text: 'This page hit an error Could not load Pulse data', maxCount: 0, assetLinks: 0 }, (p) => {
    call(p, `${B}/api/v1/kvstore/settings/app`, 'PUT', 405, {});
    call(p, `${B}/api/v1/m/g1/system/inputs`, 'GET', 403, {});
    call(p, `${B}/api/v1/proxy/x`, 'GET', 501, {});
    call(p, `${B}/api/v1/system/info`, 'GET', 502, {});
    p.emit('console', { type: () => 'error', text: () => 'boom' });
    p.emit('pageerror', new Error('kaboom'));
  }), B, '/groups');
  const all = r.reasons.join(' | ');
  ok(all.includes('page wrote on load: PUT /api/v1/kvstore/settings/app → 405'), '405 → page wrote on load');
  ok(all.includes('API GET /api/v1/m/g1/system/inputs → 403'), '403 named with URL');
  ok(all.includes('/api/v1/proxy/x → 501') && all.includes('/api/v1/system/info → 502'), '501 and 5xx named with URL');
  ok(all.includes('console.error: boom') && all.includes('pageerror: kaboom'), 'console.error and pageerror');
  ok(all.includes('empty #root'), 'empty #root');
  ok(all.includes('This page hit an error'), 'error boundary');
  ok(all.includes('error Alert: "Could not load Pulse data"'), 'state error Alert');
}

/* Overview: entity from the DOM, no demo marker */
{
  const good = await checkPage(fakeContext(GOOD_DOM), B, '/');
  ok(good.reasons.length === 0, 'Overview with assets passes');
  const none = await checkPage(fakeContext({ rootEmpty: false, text: 'Fleet 0 assets', maxCount: 0, assetLinks: 0 }), B, '/');
  ok(none.reasons.some((x) => /no entity/.test(x)), 'Overview with 0 assets fails');
  const nd = await checkPage(fakeContext({ rootEmpty: false, text: "Pulse isn't watching anything yet", maxCount: 0, assetLinks: 0 }), B, '/');
  ok(nd.reasons.some((x) => /not-deployed/.test(x)), 'Overview not-deployed empty state fails');
  const demo = await checkPage(fakeContext({ ...GOOD_DOM, text: 'Demo data Running outside Cribl, so these assets are made up.' }), B, '/');
  ok(demo.reasons.some((x) => /demo marker/.test(x)), 'Overview demo marker fails');
  const other = await checkPage(fakeContext({ rootEmpty: false, text: 'Fleet 0 assets', maxCount: 0, assetLinks: 0 }), B, '/identity');
  ok(other.reasons.length === 0, 'the entity check applies to the Overview only');
}

/* A 502/503/504 from Cribl earns the page one retry; anything else is the page's own fault */
ok(transientFailure([apiFailure('POST', '/api/v1/m/default_search/search/jobs', 504), "error Alert: \"Couldn't load this section\""]), 'a 504 on a search job is transient');
ok(transientFailure([apiFailure('GET', '/api/v1/x', 502)]) && transientFailure([apiFailure('GET', '/api/v1/x', 503)]), '502 and 503 are transient');
ok(!transientFailure([apiFailure('GET', '/api/v1/x', 500)]) && !transientFailure([apiFailure('GET', '/api/v1/x', 403)]), '500 and 403 are not');
ok(!transientFailure(['pageerror: boom', 'empty #root']), 'a page error is not');

/* Screenshots only when asked for */
ok(shotsDir({}) === null, 'no screenshots by default');
ok(shotsDir({ PULSE_SHOTS_DIR: '/x' }) === '/x', 'PULSE_SHOTS_DIR wins');
ok(shotsDir({ HARNESS_ARTIFACTS_DIR: '/h' }) === join('/h', 'shots'), 'the harness artifacts dir gets a shots/ folder');

console.log(fails ? `test-live-check: ${fails} failed` : 'test-live-check: OK');
process.exit(fails ? 1 : 0);
