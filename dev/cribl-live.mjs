// Live mode helpers (spec 020 §1). Node built-ins and `yaml` only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';

// The installed app's id is package.json "name" — live mode reads that app's KV unless PULSE_LIVE_APP says otherwise.
const APP_ID = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).name;

const VARS = [
  ['clientId', 'CRIBL_CLIENT_ID'],
  ['clientSecret', 'CRIBL_CLIENT_SECRET'],
  ['org', 'CRIBL_ORG'],
];

export function loadCreds(env = process.env, settingsPath = join(homedir(), '.claude', 'settings.json')) {
  let block = {};
  try {
    const j = JSON.parse(readFileSync(settingsPath, 'utf8'));
    if (j && typeof j.env === 'object' && j.env) block = j.env;
  } catch {
    block = {};
  }
  const out = {};
  const missing = [];
  for (const [key, name] of VARS) {
    const v = env[name] || block[name];
    if (typeof v === 'string' && v) out[key] = v;
    else missing.push(name);
  }
  if (missing.length) {
    throw new Error(`Missing Cribl credentials: ${missing.join(', ')}. Set them in the environment or in the env block of ~/.claude/settings.json.`);
  }
  return out;
}

export function parsePolicies(yamlText) {
  const doc = parse(yamlText);
  const list = Array.isArray(doc?.policies) ? doc.policies : [];
  return list
    .filter((p) => p && typeof p.object === 'string')
    .map((p) => ({
      object: p.object,
      actions: (Array.isArray(p.actions) ? p.actions : [p.actions]).filter(Boolean).map(String),
    }));
}

const segs = (p) => p.split('?')[0].split('/').filter(Boolean);

function matches(pattern, path) {
  const pat = segs(pattern);
  const got = segs(path);
  for (let i = 0; i < pat.length; i++) {
    const last = i === pat.length - 1;
    if (pat[i] === '*' && last) return got.length > i;
    if (i >= got.length) return false;
    if (pat[i] === '*' || pat[i].startsWith(':')) continue;
    if (pat[i] !== got[i]) return false;
  }
  return pat.length === got.length;
}

export function allows(policies, method, path) {
  const m = String(method).toUpperCase();
  return policies.some(
    (p) =>
      p.actions.some((a) => a === '*' || String(a).toUpperCase() === m) && matches(p.object, path),
  );
}

const SEARCH = '/m/default_search/search/jobs';
const AGENT = '/ai/q/agents/open_investigator';

export function route({ method, url, body }, { policies } = { policies: [] }) {
  const m = String(method || 'GET').toUpperCase();
  const u = String(url || '');
  if (!u.startsWith('/api/v1/')) return null;
  const rest = u.slice('/api/v1'.length);
  const path = rest.split('?')[0];
  if (m === 'POST' && path === '/kvstore/keys') return { kind: 'kv', op: 'keys' };
  if (path.startsWith('/kvstore/') && ['GET', 'PUT', 'DELETE'].includes(m)) {
    const op = { GET: 'get', PUT: 'put', DELETE: 'delete' }[m];
    return { kind: 'kv', op, key: path.slice('/kvstore/'.length) };
  }
  if (path.startsWith('/proxy/')) {
    return { kind: 'unsupported', status: 501, message: 'Live mode does not support /proxy/ calls.' };
  }
  if (path.startsWith('/a/')) {
    return { kind: 'deny', status: 403, message: `Live mode: ${m} ${path} is app-scoped and not available.` };
  }
  if (!allows(policies || [], m, path)) {
    return { kind: 'deny', status: 403, message: `Strict mode: ${m} ${path} is not declared in config/policies.yml.` };
  }
  if (m !== 'GET' && !(m === 'POST' && (path === SEARCH || path === AGENT))) {
    return { kind: 'block', status: 405, message: `Live mode is read-only: ${m} ${path} is blocked.` };
  }
  if (m === 'POST' && path === SEARCH) {
    let q;
    try {
      q = (typeof body === 'string' ? JSON.parse(body) : body)?.query;
    } catch {
      q = undefined;
    }
    if (typeof q === 'string' && /\|\s*(export|send|collect)\b/.test(q)) {
      return { kind: 'block', status: 405, message: 'Live mode is read-only: searches with export, send or collect are blocked.' };
    }
  }
  return { kind: 'forward', path: rest };
}

const sendJson = (res, status, message) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ status: 'error', message }));
};

const sendRaw = (res, status, text) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(text);
};

// KV store (spec 020 §2): read-through to the org, writes stay in a local overlay file.
export async function handleKv(d, req, res, body, forward) {
  const env = process.env;
  const app = env.PULSE_LIVE_APP || APP_ID;
  const empty = env.PULSE_LIVE_KV === 'empty';
  const file = join(env.PULSE_LIVE_KV_DIR || '.live-kv', `${app}.json`);
  let overlay = {};
  try {
    overlay = JSON.parse(readFileSync(file, 'utf8')) || {};
  } catch {
    overlay = {};
  }
  const write = () => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(overlay));
  };
  if (d.op === 'put') {
    overlay[d.key] = typeof body === 'string' ? body : '';
    write();
    return sendRaw(res, 200, '{}');
  }
  if (d.op === 'delete') {
    overlay[d.key] = null;
    write();
    return sendRaw(res, 200, '{}');
  }
  if (d.op === 'get') {
    const has = Object.prototype.hasOwnProperty.call(overlay, d.key);
    if (has && overlay[d.key] !== null) {
      res.statusCode = 200;
      return res.end(overlay[d.key]);
    }
    if (has || empty || d.key.startsWith('secrets/')) return sendJson(res, 404, 'Key not found');
    return handleForward({ path: `/a/${app}/kvstore/${d.key}` }, { method: 'GET', headers: {} }, '', res, forward);
  }
  // keys
  let prefix = '';
  try {
    const p = JSON.parse(body || '{}')?.prefix;
    if (typeof p === 'string') prefix = p;
  } catch {
    prefix = '';
  }
  let keys = [];
  if (!empty && forward) {
    const cap = {
      statusCode: 0,
      headers: {},
      setHeader(k, v) {
        this.headers[k.toLowerCase()] = v;
      },
      end(b) {
        this.out = b ? Buffer.from(b).toString() : '';
      },
    };
    await handleForward(
      { path: `/a/${app}/kvstore/keys` },
      { method: 'POST', headers: { 'content-type': 'application/json' } },
      JSON.stringify({ prefix }),
      cap,
      forward,
    );
    if (cap.statusCode >= 400) {
      res.statusCode = cap.statusCode;
      if (cap.headers['content-type']) res.setHeader('content-type', cap.headers['content-type']);
      return res.end(cap.out);
    }
    try {
      const j = JSON.parse(cap.out);
      if (Array.isArray(j)) keys = j.filter((k) => typeof k === 'string');
    } catch {
      keys = [];
    }
  }
  const out = new Set(keys);
  for (const [k, v] of Object.entries(overlay)) if (v !== null) out.add(k);
  const result = [...out].filter((k) => k.startsWith(prefix) && overlay[k] !== null);
  return sendRaw(res, 200, JSON.stringify(result));
}

// Forwarder: token cache, shared in-flight login, one 401 retry, timeout.
export function createForwarder({ env = process.env, creds, now = Date.now } = {}) {
  let c = creds;
  let token = null;
  let expiresAt = 0;
  let inflight = null;
  const getCreds = () => (c ??= loadCreds(env));
  const timeoutMs = () => Number(env.PULSE_LIVE_TIMEOUT_MS) || 30000;

  async function fetchToken() {
    const k = getCreds();
    const r = await fetch(env.PULSE_LIVE_LOGIN || 'https://login.cribl.cloud/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: k.clientId,
        client_secret: k.clientSecret,
        audience: 'https://api.cribl.cloud',
      }),
    });
    if (!r.ok) throw new Error(`Cribl login failed with status ${r.status}.`);
    const j = await r.json();
    token = j.access_token;
    expiresAt = now() + Math.max(0, (Number(j.expires_in) || 0) - 60) * 1000;
    return token;
  }
  function getToken(force) {
    if (!force && token && now() < expiresAt) return Promise.resolve(token);
    if (!inflight) inflight = fetchToken().finally(() => (inflight = null));
    return inflight;
  }

  return async function forward(path, req, body, res) {
    const k = getCreds();
    const base = env.PULSE_LIVE_UPSTREAM || `https://main-${k.org}.cribl.cloud`;
    const method = req.method || 'GET';
    const send = async (tok) => {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs());
      try {
        const headers = { authorization: `Bearer ${tok}` };
        const ct = req.headers?.['content-type'];
        if (ct) headers['content-type'] = ct;
        const hasBody = !['GET', 'HEAD'].includes(method) && body;
        const r = await fetch(`${base}/api/v1${path}`, {
          method,
          headers,
          body: hasBody ? body : undefined,
          signal: ctl.signal,
        });
        const buf = Buffer.from(await r.arrayBuffer());
        return { r, buf };
      } finally {
        clearTimeout(timer);
      }
    };
    try {
      let out = await send(await getToken(false));
      if (out.r.status === 401) out = await send(await getToken(true));
      res.statusCode = out.r.status;
      const ct = out.r.headers.get('content-type');
      if (ct) res.setHeader('content-type', ct);
      res.end(out.buf);
    } catch (e) {
      if (e?.name === 'AbortError') return sendJson(res, 504, 'Cribl did not answer in time.');
      sendJson(res, 502, String(e?.message || e));
    }
  };
}

export async function handleForward(decision, req, body, res, forward) {
  if (!forward) return sendJson(res, 501, 'Live mode: forwarding to Cribl is not available.');
  return forward(decision.path, req, body, res);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export function criblLive() {
  const active = process.env.PULSE_LIVE === '1';
  if (!active) return { name: 'cribl-live' };
  return {
    name: 'cribl-live',
    transformIndexHtml() {
      return [
        {
          tag: 'script',
          children: "window.CRIBL_API_URL = location.origin + '/api/v1';",
          injectTo: 'head-prepend',
        },
      ];
    },
    configureServer(server) {
      const file = process.env.PULSE_LIVE_POLICIES || 'config/policies.yml';
      const policies = parsePolicies(readFileSync(file, 'utf8'));
      const forward = createForwarder();
      let org = '?';
      try {
        org = loadCreds().org;
      } catch (e) {
        console.log(`[live] ${e.message}`);
      }
      const kvSrc = process.env.PULSE_LIVE_KV === 'empty' ? 'empty' : `app ${process.env.PULSE_LIVE_APP || APP_ID}`;
      const overlay = join(process.env.PULSE_LIVE_KV_DIR || '.live-kv', `${process.env.PULSE_LIVE_APP || APP_ID}.json`);
      console.log(`[live] org ${org} | KV ${kvSrc} | overlay ${overlay} | read-only | policies ${file}`);
      server.middlewares.use(async (req, res, next) => {
        try {
          const url = req.url || '';
          if (!url.startsWith('/api/v1/')) return next();
          const body = await readBody(req);
          const d = route({ method: req.method, url, body }, { policies });
          if (!d) return next();
          if (d.kind === 'kv') return await handleKv(d, req, res, body, forward);
          if (d.kind === 'forward') return await handleForward(d, req, body, res, forward);
          return sendJson(res, d.status, d.message);
        } catch (e) {
          sendJson(res, 500, String(e?.message || e));
        }
      });
    },
  };
}
