#!/usr/bin/env node
// Spec 020 §3: live contract test. Starts Vite in live mode (PULSE_LIVE=1, port 5196) and runs Pulse's queries through
// the proxy against the real org. Slow, uses Search credits: run it at sign-off, not after every task.
//   node scripts/live-check.mjs
// Sections: PREFLIGHT · SERVER · API LAYER · BROWSER LAYER · RUNNERS. Each runner is registerRunner(name, fn);
// fn takes the shared context { base, ok, stats, creds, playwright, settings, entities }.
// The browser layer's page judging (checkPage) is unit-tested offline by scripts/test-live-check.mjs.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadCreds } from '../dev/cribl-live.mjs';
import { findPlaywright, PLAYWRIGHT_HELP } from './lib/find-playwright.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 5196;
export const BASE = `http://localhost:${PORT}`;
const JOB_LIMIT_MS = 120_000;

const fails = [];
export const stats = { jobs: 0 };
export const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fails.push(msg); return !!cond; };

/* ───────────── RUNNERS: each is async (ctx) => void and reports through ctx.ok. F7 appends the browser layer. ───────────── */
export const RUNNERS = [];
export const registerRunner = (name, fn) => RUNNERS.push({ name, fn });

/* ───────────── column contract ─────────────
   Columns each query's rows must carry, taken from the code that reads them:
   - entity:        toEntity() in src/lib/model.ts (rows of entityQuery, loaded by src/state.tsx)
   - source:        src/state.tsx (sources built from sourceQuery rows)
   - activity:      binSeries() in src/state.tsx / src/lib/series.ts (key = worker_group|input|asset, value = events, b)
   - fleet:         toFleet() in src/state.tsx (b, events, assets)
   - entityActivity: src/lib/series.ts (b, events, max_lag_s)
   - gaps:          src/lib/history.ts (gap_start, gap_end, gap_s per entity)
   - retired:       src/pages/Assets.tsx (last_seen, key_src per entity)
   - samples:       src/pages/Identity.tsx (raw_sample, fields_json, ...)
   - saved searches: columns the notification message templates in kql.ts savedSearches() reference.
   Columns are only required when the query returns rows (an empty alert search is normal). */
export const CONTRACT = {
  entity: ['worker_group', 'input', 'asset', 'state', 'raw_state', 'signal', 'newly_missing', 'silent_min', 'tolerance_s', 'expected_gap_s', 'active_min', 'events', 'events_1h', 'vol_ratio', 'bytes', 'max_lag_s', 'lag_now_s', 'min_lag_s', 'key_src', 'maintenance', 'last_seen_utc', 'last_seen'],
  source: ['worker_group', 'input', 'expected', 'current', 'missing', 'late', 'learning', 'muted', 'missing_list', 'health'],
  activity: ['worker_group', 'input', 'asset', 'b', 'events'],
  fleet: ['b', 'events', 'assets'],
  entityActivity: ['b', 'events', 'max_lag_s'],
  gaps: ['worker_group', 'input', 'asset', 'gap_start', 'gap_end', 'gap_s'],
  retired: ['worker_group', 'input', 'asset', 'last_seen', 'key_src'],
  samples: ['_time', 'worker_group', 'input', 'raw_sample', 'fields_json', 'src_ip'],
  pulse_state: ['worker_group', 'input', 'asset', 'state', 'last_seen'],
  // Spec 029: the columns routes.ts ALERT_COLUMNS reads, plus the ones routeCondition matches on.
  pulse_alert_missing: ['worker_group', 'input', 'asset', 'criticality', 'team', 'silent_min', 'tolerance_s',
    'severity', 'asset_s', 'asset_u', 'input_s', 'worker_group_s', 'team_s', 'others_s', 'more_s', 'n_alerts'],
  pulse_alert_source_down: ['worker_group', 'input', 's_missing', 's_live', 'missing_list',
    'severity', 'input_s', 'input_u', 'worker_group_s', 'teams_s', 'teams_j', 'missing_s', 'more_s', 'crit_min', 'pct'],
  pulse_source_digest: ['worker_group', 'input', 'current', 'expected', 'missing_list', 'signal_list',
    'severity', 'input_s', 'input_u', 'worker_group_s', 'teams_s', 'teams_j', 'missing_s', 'signals_s', 'more_s', 'crit_min', 'missing', 'signals'],
};
const NEED_ROWS = ['entity', 'fleet'];

/** Cut a trailing '| export …' stage (saved searches write lookups; we only read). */
export const stripExport = (q) => q.replace(/\s*\|\s*export\b[^|]*$/i, '');

/* ───────────── HTTP helpers (all through the proxy) ───────────── */
let blocked = 0;
async function http(path, init) {
  const r = await fetch(`${BASE}/api/v1${path}`, init);
  const text = await r.text();
  if (r.status === 403 || r.status === 405) { blocked++; throw new Error(`proxy blocked ${init?.method || 'GET'} ${path}: ${r.status} ${text.slice(0, 200)}`); }
  if (!r.ok) throw new Error(`${init?.method || 'GET'} ${path}: ${r.status} ${text.slice(0, 200)}`);
  return text;
}
const S = '/m/default_search/search';
export async function runJob(query, earliest = '-24h') {
  const created = JSON.parse(await http(`${S}/jobs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query, earliest, latest: 'now' }) }));
  stats.jobs++;
  const id = (created.items || [])[0]?.id;
  if (!id) throw new Error(`no job id in ${JSON.stringify(created).slice(0, 200)}`);
  const t0 = Date.now();
  for (;;) {
    const st = (JSON.parse(await http(`${S}/jobs/${id}/status`)).items || [])[0];
    if (st?.status === 'completed') break;
    if (st?.status === 'failed' || st?.status === 'canceled') throw new Error(`job ${st.status}: ${JSON.stringify(st).slice(0, 300)}`);
    if (Date.now() - t0 > JOB_LIMIT_MS) throw new Error(`job not completed within ${JOB_LIMIT_MS / 1000} s`);
    await new Promise((r) => setTimeout(r, 1500));
  }
  const raw = await http(`${S}/jobs/${id}/results?limit=1000&offset=0`);
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => !('isFinished' in l && 'totalEventCount' in l));
}

/* ───────────── API LAYER ───────────── */
async function bundle(src) {
  const esbuild = await import('esbuild');
  const tmp = mkdtempSync(join(tmpdir(), 'pulse-live-'));
  const out = join(tmp, 'm.mjs');
  try {
    // src/lib/api.ts touches `window`; the defaults and the queries don't need it, so stub it out.
    await esbuild.build({ entryPoints: [join(root, src)], bundle: true, format: 'esm', platform: 'neutral', outfile: out, logLevel: 'silent',
      plugins: [{ name: 'stub-api', setup(b) {
        b.onResolve({ filter: /^\.\/api$/ }, () => ({ path: 'api-stub', namespace: 'stub' }));
        b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const kvGet = async () => undefined; export const kvPut = async () => undefined;', loader: 'js' }));
      } }] });
    return await import(pathToFileURL(out).href);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

async function apiLayer(ctx) {
  const defaults = (await bundle('src/lib/settings.ts')).DEFAULT_SETTINGS;
  let stored = {};
  try { stored = JSON.parse(await http('/kvstore/settings/app')); ok(true, 'settings/app read through the proxy'); }
  catch (e) { const nf = /: 404 /.test(e.message); ok(nf, nf ? 'settings/app not set, using defaults' : `settings/app: ${e.message}`); }
  const s = { ...defaults, ...stored, learning: { ...defaults.learning, ...(stored.learning || {}) }, notify: { ...defaults.notify, ...(stored.notify || {}) } };
  ctx.settings = s;
  console.log(`  dataset ${s.dataset}, lookback ${s.learning.LOOKBACK}`);

  const k = await bundle('src/lib/kql.ts');
  const list = [
    ['entity', k.entityQuery(s)], ['source', k.sourceQuery(s)], ['activity', k.activityQuery(s)], ['fleet', k.fleetQuery(s)],
    ['gaps', k.gapsQuery(s)], ['retired', k.retiredQuery(s)],
    ...k.savedSearches(s).map((x) => [x.id, x.query]),
  ];
  const results = {};
  const runOne = async (name, query) => {
    try {
      const rows = await runJob(stripExport(query));
      results[name] = rows;
      ok(true, `${name}: completed, ${rows.length} rows`);
      if (rows.length && CONTRACT[name]) {
        const missing = CONTRACT[name].filter((c) => !(c in rows[0]));
        ok(!missing.length, `${name}: required columns present${missing.length ? ` (missing: ${missing.join(', ')})` : ''}`);
      }
      if (NEED_ROWS.includes(name)) ok(rows.length > 0, `${name}: returns at least one row`);
    } catch (e) { ok(false, `${name}: ${e.message}`); }
  };
  for (let i = 0; i < list.length; i += 2) await Promise.all(list.slice(i, i + 2).map(([n, q]) => runOne(n, q)));

  // Queries that need an entity from the first result.
  const e0 = results.entity?.[0];
  if (e0) {
    await runOne('entityActivity', k.entityActivityQuery(s, e0.input, e0.asset, 600));
    await runOne('samples', k.samplesQuery(s, e0.input));
  } else ok(false, 'entityActivity/samples: skipped, no entity row to query for');
  ctx.entities = results.entity || [];
  ok(blocked === 0, `no request blocked by the proxy (403/405): ${blocked}`);
}
registerRunner('api', apiLayer);

/* ───────────── BROWSER LAYER ─────────────
   Headless Chromium walks every page. A page is judged only once no search job is pending: jobs are tracked by id
   (from the POST /search/jobs response) until their results request ends, a status says failed/canceled, or the app
   stops polling them (no request for that job in JOB_IDLE_MS, well past the app's 1.5 s poll interval). */
const PAGE_CAP_MS = 180_000;      // longest wait for a page's search jobs
const SETTLE_MS = 2_500;          // nothing pending for this long → the page is done loading
const JOB_IDLE_MS = 10_000;       // a job with no request for this long is abandoned by the app
const RESULTS_GRACE_MS = 5_000;   // completed but no results request yet
// Error Alerts that Pulse renders from its state (state.tsx error, Section error, Cribl API error) and the boundary.
const ERROR_BOUNDARY = 'This page hit an error';
const STATE_ERROR_ALERTS = ['Could not load Pulse data', 'Pulse needs its lookups in Cribl Search', "Couldn't load this section", 'Cribl API error'];
const DEMO_MARKERS = ['Demo data', 'these assets are made up'];
let activeBrowser = null;

/** Bad /api/v1 statuses. A 405 is the proxy's read-only block: the page wrote on load. */
export function apiFailure(method, url, status) {
  if (status === 405) return `page wrote on load: ${method} ${url} → 405`;
  if (status === 403 || status === 501 || status >= 500) return `API ${method} ${url} → ${status}`;
  return null;
}
const JOB_RE = /\/search\/jobs\/([^/?#]+)(?:\/(status|results))?/;

/* A 502/503/504 means Cribl (or the dev proxy waiting 30 s on it) did not answer: the org was busy, not the page
   wrong. Such a page gets one retry after RETRY_DELAY_MS; if it fails again, its line still names the 5xx, so the
   harness can tell "the org was flaky" from "the code is wrong". */
const RETRY_DELAY_MS = Number(process.env.PULSE_LIVE_RETRY_DELAY_MS ?? 20_000);
export const transientFailure = (reasons) => reasons.some((r) => /^API \S+ \S+ → 50[234]$/.test(r));

/* Light and dark screenshots of every page, for the human sign-off. Off unless a directory is given:
   PULSE_SHOTS_DIR, or HARNESS_ARTIFACTS_DIR/shots when the harness runs the final check. */
export const shotsDir = (env = process.env) => env.PULSE_SHOTS_DIR || (env.HARNESS_ARTIFACTS_DIR ? join(env.HARNESS_ARTIFACTS_DIR, 'shots') : null);
const slug = (path) => (path.replace(/^\/+|\/+$/g, '').replace(/[^\w-]+/g, '_') || 'overview');
async function screenshots(page, dir, path) {
  mkdirSync(dir, { recursive: true });
  const theme = (t) => page.evaluate((x) => window.postMessage({ type: 'CRIBL_APP_LAYOUT', theme: x }, '*'), t);
  for (const t of ['light', 'dark']) {
    await theme(t);
    await new Promise((r) => setTimeout(r, 400));
    await page.screenshot({ path: join(dir, `${slug(path)}-${t}.png`), fullPage: true });
  }
}

async function pagePlan() {
  const tabs = (await bundle('src/lib/nav.ts')).SETTINGS_TABS;   // from the source, not a copy
  if (!Array.isArray(tabs) || !tabs.length) throw new Error('SETTINGS_TABS not found in src/lib/nav.ts');
  let groupPage = null;
  try {
    const raw = JSON.parse(await http('/master/groups?fields=id,workerCount,onPrem,isFleet,type'));
    // Same filter as listGroups() in src/lib/api.ts: worker groups only.
    const g = (raw.items || []).find((x) => x?.id && !x.isFleet && x.type !== 'lake_search' && !/search|outpost/.test(x.id));
    if (g) groupPage = `/groups/${encodeURIComponent(g.id)}`;
    else ok(false, 'browser: no worker group in /master/groups, so no group detail page to open');
  } catch (e) { ok(false, `browser: /master/groups: ${e.message}`); }
  return ['/', '/incidents', '/assets', '/groups', ...(groupPage ? [groupPage] : []), '/identity', ...tabs.map((t) => `/settings/${t.key}`)];
}

export async function checkPage(context, base, path, { shots = null } = {}) {
  const page = await context.newPage();
  const reasons = [];
  const inflight = new Set();            // search-job HTTP requests on the wire
  const jobs = new Map();                // job id → { last, completedAt }
  const handlers = new Set();            // response bodies still being read
  let started = 0;
  const touch = (id) => { const j = jobs.get(id); if (j) j.last = Date.now(); };
  const track = (p) => { handlers.add(p); p.finally(() => handlers.delete(p)); };

  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    // A KV key the org has never written answers 404; the app reads that as "unset". Chromium still logs it.
    if (/Failed to load resource: .*\b404\b/.test(m.text()) && /\/api\/v1\/kvstore\//.test(m.location()?.url ?? '')) return;
    reasons.push(`console.error: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => reasons.push(`pageerror: ${String(e.message || e).slice(0, 200)}`));
  page.on('request', (req) => {
    const u = new URL(req.url());
    if (!u.pathname.includes('/search/jobs')) return;
    inflight.add(req);
    const m = u.pathname.match(JOB_RE); if (m) touch(m[1]);
  });
  const done = (req, failed) => {
    if (!inflight.delete(req)) return;
    const m = new URL(req.url()).pathname.match(JOB_RE);
    if (m) { touch(m[1]); if (failed || m[2] === 'results') jobs.delete(m[1]); }
  };
  page.on('requestfinished', (req) => done(req, false));
  page.on('requestfailed', (req) => done(req, true));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.includes('/api/v1')) return;
    const method = r.request().method();
    const bad = apiFailure(method, `${u.pathname}${u.search}`, r.status());
    if (bad) reasons.push(bad);
    if (!u.pathname.includes('/search/jobs')) return;
    const m = u.pathname.match(JOB_RE);
    if (!m && method === 'POST' && /\/search\/jobs\/?$/.test(u.pathname) && r.ok()) {
      started++;
      track(r.json().then((b) => { const id = (b?.items || [])[0]?.id; if (id) jobs.set(id, { last: Date.now(), completedAt: 0 }); }).catch(() => {}));
    } else if (m && m[2] === 'status') {
      if (!r.ok()) { jobs.delete(m[1]); return; }   // the app throws on a failed poll: the job is no longer awaited
      track(r.json().then((b) => {
        const st = (b?.items || [])[0]?.status;
        if (st === 'failed' || st === 'canceled') jobs.delete(m[1]);
        else if (st === 'completed') { const j = jobs.get(m[1]); if (j) j.completedAt = Date.now(); }
      }).catch(() => {}));
    }
  });

  let timedOut = false;
  try {
    await page.goto(`${base}${path}`, { waitUntil: 'load', timeout: 60_000 });
    const t0 = Date.now();
    let quietSince = Date.now();
    for (;;) {
      await new Promise((r) => setTimeout(r, 250));
      const now = Date.now();
      for (const [id, j] of jobs) {
        if (now - j.last > JOB_IDLE_MS || (j.completedAt && now - j.completedAt > RESULTS_GRACE_MS)) jobs.delete(id);
      }
      if (inflight.size || jobs.size || handlers.size) quietSince = now;
      else if (now - quietSince >= SETTLE_MS) break;
      if (now - t0 > PAGE_CAP_MS) { timedOut = true; break; }
    }
    if (timedOut) reasons.push(`search jobs still pending after ${PAGE_CAP_MS / 1000} s (${jobs.size} job(s), ${inflight.size} request(s))`);

    const dom = await page.evaluate(() => {
      const root = document.querySelector('#root');
      const text = document.body?.innerText || '';
      const counts = [...document.querySelectorAll('#root *')].filter((el) => !el.children.length)
        .map((el) => (el.textContent || '').trim().match(/^(\d+) assets?$/)).filter(Boolean).map((m) => Number(m[1]));
      const assetLinks = [...document.querySelectorAll('#root a[href]')].filter((a) => /\/assets\/[^/?#]+/.test(a.getAttribute('href') || '')).length;
      return { rootEmpty: !root || (!root.children.length && !(root.textContent || '').trim()), text, maxCount: counts.length ? Math.max(...counts) : 0, assetLinks };
    });
    if (dom.rootEmpty) reasons.push('empty #root');
    if (dom.text.includes(ERROR_BOUNDARY)) reasons.push(`error boundary: "${ERROR_BOUNDARY}"`);
    for (const t of STATE_ERROR_ALERTS) if (dom.text.includes(t)) reasons.push(`error Alert: "${t}"`);
    if (path === '/') {
      for (const t of DEMO_MARKERS) if (dom.text.includes(t)) reasons.push(`demo marker: "${t}"`);
      if (dom.text.includes("Pulse isn't watching anything yet")) reasons.push('Overview shows the not-deployed empty state, no entity');
      else if (dom.text.includes('Waiting for the first heartbeats')) reasons.push('Overview is waiting for the first heartbeats, no entity');
      else if (dom.maxCount < 1 && dom.assetLinks < 1) reasons.push('Overview shows no entity (no asset count above 0, no asset link)');
    }
    if (shots) {
      try { await screenshots(page, shots, path); }
      catch (e) { console.log(`  (no screenshot of ${path}: ${String(e.message || e).split('\n')[0]})`); }
    }
    return { reasons, started, dom };
  } catch (e) {
    reasons.push(`navigation: ${String(e.message || e).split('\n')[0]}`);
    return { reasons, started, dom: null };
  } finally {
    await page.close().catch(() => {});
  }
}

async function browserLayer(ctx) {
  const paths = await pagePlan();
  const exe = process.env.PW_CHROMIUM;
  const browser = await ctx.playwright.chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
  activeBrowser = browser;
  try {
    const context = await browser.newContext();
    const shots = shotsDir();
    for (const path of paths) {
      let r = await checkPage(context, ctx.base, path, { shots });
      stats.jobs += r.started;
      let uniq = [...new Set(r.reasons)], retried = '';
      if (uniq.length && transientFailure(uniq)) {
        console.log(`  page ${path}: Cribl answered 5xx (${uniq.find((x) => / → 50[234]$/.test(x))}); retrying in ${RETRY_DELAY_MS / 1000} s`);
        await new Promise((res) => setTimeout(res, RETRY_DELAY_MS));
        r = await checkPage(context, ctx.base, path, { shots });
        stats.jobs += r.started;
        uniq = [...new Set(r.reasons)];
        retried = ', on retry after a 5xx';
      }
      ok(uniq.length === 0, `page ${path}: ${uniq.length ? uniq.join('; ') : 'ok'} (${r.started} search job(s)${retried})`);
      if (path === '/' && r.dom) {
        if (ctx.entities?.length) console.log(`  Overview: page shows ${r.dom.maxCount} asset(s), API layer found ${ctx.entities.length} entity row(s)`);
        else console.log(`  Overview: page shows ${r.dom.maxCount} asset(s); the API layer found no entity row`);
      }
    }
  } finally {
    activeBrowser = null;
    await browser.close().catch(() => {});
  }
}
registerRunner('browser', browserLayer);

/* ───────────── PREFLIGHT ───────────── */
function preflight() {
  let creds, playwright = null, good = true;
  try { creds = loadCreds(); ok(true, 'credentials found'); }
  catch (e) { ok(false, e.message); good = false; }
  try {
    const p = findPlaywright();
    if (!p) throw new Error(PLAYWRIGHT_HELP);
    playwright = createRequire(import.meta.url)(p);
    ok(true, `Playwright found (${p})`);
  } catch (e) { ok(false, String(e.message).split('\n')[0]); good = false; }
  return good ? { creds, playwright } : null;
}

/* ───────────── SERVER ───────────── */
let server = null, kvDir = null;
function cleanup() {
  if (server && server.exitCode === null && !server.killed) { try { server.kill('SIGTERM'); } catch { /* gone */ } }
  if (kvDir) { try { rmSync(kvDir, { recursive: true, force: true }); } catch { /* ignore */ } kvDir = null; }
}
process.on('exit', cleanup);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => {
  const b = activeBrowser; activeBrowser = null;
  if (b) await Promise.race([b.close().catch(() => {}), new Promise((r) => setTimeout(r, 3000))]);
  cleanup(); process.exit(130);
});

async function startServer() {
  kvDir = mkdtempSync(join(tmpdir(), 'pulse-live-kv-'));
  const env = { ...process.env, PULSE_LIVE: '1', PULSE_LIVE_KV_DIR: kvDir };   // other PULSE_LIVE_* pass through
  server = spawn(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), '--port', String(PORT), '--strictPort', '--host', 'localhost'], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  let exited = false;
  server.on('exit', () => { exited = true; });
  for (let i = 0; i < 120; i++) {
    if (exited) throw new Error(`vite exited early:\n${log.slice(-600)}`);
    try { const r = await fetch(`${BASE}/`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`vite not ready after 60 s:\n${log.slice(-600)}`);
}

/* ───────────── main ───────────── */
async function main() {
  const pre = preflight();
  if (!pre) return;
  try {
    await startServer();
    ok(true, `vite live on :${PORT}`);
  } catch (e) { ok(false, e.message); return; }
  const ctx = { base: BASE, ok, stats, creds: pre.creds, playwright: pre.playwright };
  for (const r of RUNNERS) {
    try { await r.fn(ctx); } catch (e) { ok(false, `${r.name}: ${e.message}`); }
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try { await main(); } catch (e) { ok(false, e.stack || String(e)); }
  finally { cleanup(); }
  console.log(`search jobs started: ${stats.jobs}`);
  if (shotsDir()) console.log(`screenshots (light and dark): ${shotsDir()}`);
  console.log(fails.length ? `✘ ${fails.length} check(s) failed` : '✔ all live checks passed');
  process.exit(fails.length ? 1 : 0);
}
