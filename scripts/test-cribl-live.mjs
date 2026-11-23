#!/usr/bin/env node
// Unit tests for dev/cribl-live.mjs (spec 020 §1): loadCreds, parsePolicies, allows.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allows, loadCreds, parsePolicies, route } from '../dev/cribl-live.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'live-'));
const good = join(dir, 's.json');
writeFileSync(good, JSON.stringify({ env: { CRIBL_CLIENT_ID: 'fid', CRIBL_CLIENT_SECRET: 'fsec', CRIBL_ORG: 'forg' } }));
const bad = join(dir, 'bad.json');
writeFileSync(bad, '{not json');
const none = join(dir, 'nope.json');

// env wins per variable, file fills the rest
assert.deepEqual(loadCreds({ CRIBL_CLIENT_ID: 'eid' }, good), { clientId: 'eid', clientSecret: 'fsec', org: 'forg' });
// malformed / missing settings: env still works
const all = { CRIBL_CLIENT_ID: 'a', CRIBL_CLIENT_SECRET: 'b', CRIBL_ORG: 'c' };
for (const p of [bad, none]) assert.deepEqual(loadCreds(all, p), { clientId: 'a', clientSecret: 'b', org: 'c' });
// errors name every missing variable, no secret
assert.throws(() => loadCreds({}, none), (e) => e instanceof Error && ['CRIBL_CLIENT_ID', 'CRIBL_CLIENT_SECRET', 'CRIBL_ORG'].every((n) => e.message.includes(n)));
assert.throws(() => loadCreds({ CRIBL_CLIENT_SECRET: 'TOPSECRET' }, bad), (e) => e.message.includes('CRIBL_CLIENT_ID') && e.message.includes('CRIBL_ORG') && !e.message.includes('TOPSECRET'));

// parsePolicies on the real file
const real = parsePolicies(readFileSync(join(root, 'config/policies.yml'), 'utf8'));
assert.ok(real.length > 0 && real.every((p) => typeof p.object === 'string' && Array.isArray(p.actions)));

// allows
const pol = [
  { object: '/master/groups/*', actions: ['GET'] },
  { object: '/things/:name', actions: ['get'] },
  { object: '/m/*/inputs', actions: ['GET'] },
  { object: '/any', actions: ['*'] },
];
assert.ok(allows(pol, 'GET', '/master/groups/default/deploy'));
assert.ok(allows(pol, 'GET', '/master/groups/default'));
assert.ok(!allows(pol, 'GET', '/master/groups'));
assert.ok(allows(pol, 'GET', '/things/x'));
assert.ok(!allows(pol, 'GET', '/things/x/y'));
assert.ok(!allows(pol, 'GET', '/things'));
assert.ok(allows(pol, 'GET', '/m/g1/inputs'));
assert.ok(!allows(pol, 'GET', '/m/g1/g2/inputs'));
assert.ok(!allows(pol, 'GET', '/m/inputs'));
assert.ok(allows(pol, 'DELETE', '/any'));
assert.ok(!allows(pol, 'POST', '/master/groups/x'));
assert.ok(allows(pol, 'get', '/master/groups/x/?a=1'));
assert.ok(allows(pol, 'GET', '/things/x/'));
assert.ok(allows(pol, 'GET', '/m/g/inputs?x=/y'));
// route
const rp = [
  { object: '/master/groups', actions: ['GET'] },
  { object: '/m/default_search/search/jobs', actions: ['POST'] },
  { object: '/ai/q/agents/open_investigator', actions: ['POST'] },
  { object: '/m/g/pipelines', actions: ['GET', 'POST'] },
  { object: '/kvstore/x', actions: ['*'] },
];
const r = (method, url, body) => route({ method, url, body }, { policies: rp });
for (const u of ['/', '/assets', '/src/main.tsx']) assert.equal(r('GET', u), null);
assert.deepEqual(r('POST', '/api/v1/kvstore/keys', '{}'), { kind: 'kv', op: 'keys' });
assert.deepEqual(r('GET', '/api/v1/kvstore/a/b?x=1'), { kind: 'kv', op: 'get', key: 'a/b' });
assert.deepEqual(r('PUT', '/api/v1/kvstore/a/b'), { kind: 'kv', op: 'put', key: 'a/b' });
assert.deepEqual(r('DELETE', '/api/v1/kvstore/a/b'), { kind: 'kv', op: 'delete', key: 'a/b' });
let x = r('GET', '/api/v1/proxy/api.x.com/y');
assert.ok(x.kind === 'unsupported' && x.status === 501 && x.message);
x = r('GET', '/api/v1/a/app/kvstore/k');
assert.ok(x.kind === 'deny' && x.status === 403 && x.message);
for (const m of ['DELETE', 'PUT']) {
  x = r(m, '/api/v1/m/g/other');
  assert.ok(x.kind === 'deny' && x.status === 403);
  assert.ok(x.message.includes(m) && x.message.includes('/m/g/other') && x.message.includes('config/policies.yml'));
}
x = r('GET', '/api/v1/nope');
assert.ok(x.kind === 'deny' && x.status === 403);
x = r('POST', '/api/v1/m/g/pipelines', '{}');
assert.ok(x.kind === 'block' && x.status === 405 && /read-only/.test(x.message));
x = r('POST', '/api/v1/m/default_search/search/jobs', JSON.stringify({ query: 'dataset=x | export to lookup y' }));
assert.ok(x.kind === 'block' && x.status === 405 && x.message);
assert.equal(r('POST', '/api/v1/m/default_search/search/jobs', JSON.stringify({ query: 'dataset=x | send' })).kind, 'block');
assert.equal(r('POST', '/api/v1/m/default_search/search/jobs', JSON.stringify({ query: 'dataset=x |collect' })).kind, 'block');
assert.deepEqual(r('POST', '/api/v1/m/default_search/search/jobs', JSON.stringify({ query: 'dataset=x | limit 5' })), { kind: 'forward', path: '/m/default_search/search/jobs' });
assert.equal(r('POST', '/api/v1/m/default_search/search/jobs', 'not json').kind, 'forward');
assert.equal(r('POST', '/api/v1/m/default_search/search/jobs', '{}').kind, 'forward');
assert.equal(r('POST', '/api/v1/m/default_search/search/jobs', undefined).kind, 'forward');
assert.deepEqual(r('POST', '/api/v1/ai/q/agents/open_investigator', '{}'), { kind: 'forward', path: '/ai/q/agents/open_investigator' });
assert.deepEqual(r('GET', '/api/v1/master/groups?product=stream'), { kind: 'forward', path: '/master/groups?product=stream' });
{
  const { criblLive } = await import('../dev/cribl-live.mjs');
  const saved = process.env.PULSE_LIVE;
  delete process.env.PULSE_LIVE;
  const off = criblLive();
  assert.ok(!off.configureServer && !off.transformIndexHtml);
  process.env.PULSE_LIVE = '1';
  const on = criblLive();
  process.env.PULSE_LIVE = saved ?? '';
  if (saved === undefined) delete process.env.PULSE_LIVE;
  assert.match(on.transformIndexHtml()[0].children, /window\.CRIBL_API_URL = location\.origin \+ '\/api\/v1'/);
  let mw;
  on.configureServer({ middlewares: { use: (f) => (mw = f) } });
  const { Readable } = await import('node:stream');
  const call = async (method, url) => {
    const req = Object.assign(Readable.from([]), { method, url });
    const out = { headers: {} };
    const res = { setHeader: (k, v) => (out.headers[k] = v), end: (b) => (out.body = b) };
    let nexted = false;
    await mw(req, res, () => (nexted = true));
    return { ...out, status: res.statusCode, nexted };
  };
  const p = await call('GET', '/api/v1/proxy/x');
  assert.equal(p.status, 501);
  assert.equal(JSON.parse(p.body).status, 'error');
  assert.equal((await call('GET', '/api/v1/a/cc-pulse/kvstore/x')).status, 403);
  assert.equal((await call('GET', '/index.html')).nexted, true);
}
{
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Readable } = await import('node:stream');
  const listen = (h) => new Promise((ok) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => ok(s)); });
  let logins = 0, hits = 0, mode = 'ok', lastAuth, lastSeenToken;
  const login = await listen((q, r) => {
    logins++;
    r.setHeader('content-type', 'application/json');
    r.end(JSON.stringify({ access_token: `TOK${logins}`, expires_in: 3600 }));
  });
  const up = await listen((q, r) => {
    hits++;
    lastAuth = q.headers.authorization;
    lastSeenToken = q.url;
    if (mode === 'hang') return;
    if (mode === '401once') { mode = 'ok'; r.statusCode = 401; return r.end('{}'); }
    r.statusCode = 207;
    r.setHeader('content-type', 'application/x-test');
    r.setHeader('set-cookie', 'a=b');
    r.setHeader('www-authenticate', 'Bearer');
    r.end('body-here');
  });
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  const pol = path.join(dir, 'p.yml');
  fs.writeFileSync(pol, "policies:\n  - object: '/system/info'\n    actions: ['GET']\n");
  const keep = { ...process.env };
  Object.assign(process.env, {
    PULSE_LIVE: '1', PULSE_LIVE_POLICIES: pol, PULSE_LIVE_LOGIN: url(login) + '/oauth/token',
    PULSE_LIVE_UPSTREAM: url(up), PULSE_LIVE_TIMEOUT_MS: '300',
    CRIBL_CLIENT_ID: 'cid', CRIBL_CLIENT_SECRET: 'SECRET-XYZ', CRIBL_ORG: 'myorg',
  });
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  const { criblLive: mk } = await import('../dev/cribl-live.mjs');
  const pl = mk();
  let mw;
  pl.configureServer({ middlewares: { use: (f) => (mw = f) } });
  console.log = origLog;
  const line = logs.join('\n');
  for (const s of ['myorg', 'app cc-pulse', '.live-kv', 'read-only', pol]) assert.ok(line.includes(s), s);
  assert.ok(!line.includes('SECRET-XYZ'));
  const call = async () => {
    const req = Object.assign(Readable.from([]), { method: 'GET', url: '/api/v1/system/info', headers: {} });
    const out = { headers: {} };
    const res = { setHeader: (k, v) => (out.headers[k.toLowerCase()] = v), end: (b) => (out.body = b ? Buffer.from(b).toString() : '') };
    await mw(req, res, () => {});
    return { ...out, status: res.statusCode };
  };
  let x = await call();
  assert.equal(lastAuth, 'Bearer TOK1');
  assert.equal(lastSeenToken, '/api/v1/system/info');
  assert.equal(x.status, 207);
  assert.equal(x.headers['content-type'], 'application/x-test');
  assert.equal(x.body, 'body-here');
  assert.ok(!x.headers['set-cookie'] && !x.headers['www-authenticate'] && !x.headers.authorization);
  await Promise.all([call(), call(), call()]);
  assert.equal(logins, 1);
  mode = '401once';
  const h0 = hits;
  x = await call();
  assert.equal(logins, 2);
  assert.equal(hits - h0, 2);
  assert.equal(lastAuth, 'Bearer TOK2');
  assert.equal(x.status, 207);
  mode = 'hang';
  x = await call();
  assert.equal(x.status, 504);
  assert.equal(JSON.parse(x.body).status, 'error');
  for (const r of [x, line]) {
    const s = JSON.stringify(r);
    assert.ok(!s.includes('SECRET-XYZ') && !s.includes('TOK1') && !s.includes('TOK2'));
  }
  up.closeAllConnections?.();
  login.close(); up.close();
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
}
{
  const http = await import('node:http');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { Readable } = await import('node:stream');
  const listen = (h) => new Promise((ok) => { const s = http.createServer(h); s.listen(0, '127.0.0.1', () => ok(s)); });
  const seen = [];
  const login = await listen((q, r) => { r.setHeader('content-type', 'application/json'); r.end('{"access_token":"T","expires_in":3600}'); });
  const up = await listen((q, r) => {
    let b = '';
    q.on('data', (c) => (b += c));
    q.on('end', () => {
      seen.push(`${q.method} ${q.url}`);
      if (q.url.endsWith('/kvstore/keys')) { r.setHeader('content-type', 'application/json'); return r.end(JSON.stringify(['a/1', 'a/2', 'a/gone', 'b/1'])); }
      if (q.url.endsWith('/kvstore/up/missing')) { r.statusCode = 404; return r.end('nope'); }
      r.statusCode = 200; r.end('upstream-body');
    });
  });
  const url = (s) => `http://127.0.0.1:${s.address().port}`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livekv-'));
  const pol = path.join(dir, 'p.yml');
  fs.writeFileSync(pol, "policies:\n  - object: '/system/info'\n    actions: ['GET']\n");
  const keep = { ...process.env };
  Object.assign(process.env, {
    PULSE_LIVE: '1', PULSE_LIVE_POLICIES: pol, PULSE_LIVE_LOGIN: url(login) + '/t', PULSE_LIVE_UPSTREAM: url(up),
    PULSE_LIVE_KV_DIR: path.join(dir, 'kv'), CRIBL_CLIENT_ID: 'c', CRIBL_CLIENT_SECRET: 's', CRIBL_ORG: 'o',
  });
  delete process.env.PULSE_LIVE_KV;
  const origLog = console.log;
  console.log = () => {};
  const { criblLive: mk } = await import('../dev/cribl-live.mjs');
  let mw;
  mk().configureServer({ middlewares: { use: (f) => (mw = f) } });
  console.log = origLog;
  const call = async (method, u, body) => {
    const req = Object.assign(Readable.from(body ? [Buffer.from(body)] : []), { method, url: '/api/v1' + u, headers: {} });
    const out = { headers: {} };
    const res = { setHeader: (k, v) => (out.headers[k.toLowerCase()] = v), end: (b) => (out.body = b ? Buffer.from(b).toString() : '') };
    await mw(req, res, () => {});
    return { ...out, status: res.statusCode };
  };
  const file = path.join(dir, 'kv', 'cc-pulse.json');
  assert.ok(!fs.existsSync(file));
  let x = await call('PUT', '/kvstore/k/one', '{"v":1}');
  assert.equal(x.status, 200); assert.equal(x.body, '{}');
  assert.ok(fs.existsSync(file));
  x = await call('GET', '/kvstore/k/one');
  assert.equal(x.status, 200); assert.equal(x.body, '{"v":1}');
  assert.equal(seen.length, 0);
  x = await call('DELETE', '/kvstore/a/gone');
  assert.equal(x.body, '{}'); assert.equal(seen.length, 0);
  x = await call('GET', '/kvstore/a/gone');
  assert.equal(x.status, 404); assert.deepEqual(JSON.parse(x.body), { status: 'error', message: 'Key not found' });
  assert.equal(seen.length, 0);
  x = await call('GET', '/kvstore/up/key');
  assert.equal(x.status, 200); assert.equal(x.body, 'upstream-body');
  assert.deepEqual(seen, ['GET /api/v1/a/cc-pulse/kvstore/up/key']);
  x = await call('GET', '/kvstore/up/missing');
  assert.equal(x.status, 404); assert.equal(x.body, 'nope');
  seen.length = 0;
  x = await call('GET', '/kvstore/secrets/x');
  assert.equal(x.status, 404); assert.equal(seen.length, 0);
  await call('PUT', '/kvstore/a/3', 'z');
  await call('PUT', '/kvstore/a/1', 'z');
  await call('PUT', '/kvstore/b/9', 'z');
  x = await call('POST', '/kvstore/keys', '{"prefix":"a/"}');
  assert.deepEqual(JSON.parse(x.body).sort(), ['a/1', 'a/2', 'a/3']);
  assert.deepEqual(seen, ['POST /api/v1/a/cc-pulse/kvstore/keys']);
  process.env.PULSE_LIVE_KV = 'empty';
  seen.length = 0;
  x = await call('GET', '/kvstore/up/key');
  assert.equal(x.status, 404);
  x = await call('POST', '/kvstore/keys', '{"prefix":""}');
  assert.deepEqual(JSON.parse(x.body).sort(), ['a/1', 'a/3', 'b/9', 'k/one']);
  assert.equal(seen.length, 0);
  up.closeAllConnections?.();
  login.close(); up.close();
  for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  Object.assign(process.env, keep);
}
console.log('test-cribl-live: ok');
