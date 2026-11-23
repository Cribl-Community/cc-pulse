// dev/cribl-preview.mjs — spec 021 T1: helpers for previewing the dev server inside a real Cribl org.
// Plain ESM, Node built-ins only.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const INIT_PATH = /^\/app-ui\/[^/]+\/init\.js$/;

/**
 * Returns the init.js URL string when it is safe to inject, otherwise null. Never throws.
 * Valid: pathname /app-ui/<id>/init.js; https on a real *.cribl.cloud host, or url.host listed in
 * `hosts` (http/https); an optional apiUrl param must parse and share the init URL's origin.
 */
export function validInitUrl(raw, { hosts = [] } = {}) {
  try {
    if (typeof raw !== 'string' || raw === '') return null;
    let url;
    try { url = new URL(raw); } catch { return null; }
    if (!INIT_PATH.test(url.pathname)) return null;
    const list = Array.isArray(hosts) ? hosts : [];
    const cloud = url.protocol === 'https:' && url.hostname.endsWith('.cribl.cloud') && url.hostname.length > '.cribl.cloud'.length;
    const listed = (url.protocol === 'http:' || url.protocol === 'https:') && list.includes(url.host);
    if (!cloud && !listed) return null;
    if (url.searchParams.has('apiUrl')) {
      let api;
      try { api = new URL(url.searchParams.get('apiUrl')); } catch { return null; }
      if (api.origin !== url.origin) return null;
    }
    return raw;
  } catch {
    return null;
  }
}

/**
 * True only for a GET page navigation inside an iframe (Sec-Fetch-Dest: iframe) to an app route —
 * not Vite internals, sources, deps, the API, or a file with an extension other than .html.
 */
export function isPreviewNavigation({ method, url, headers } = {}) {
  if (String(method || '').toUpperCase() !== 'GET') return false;
  if (!headers || headers['sec-fetch-dest'] !== 'iframe') return false;
  if (typeof url !== 'string' || !url.startsWith('/')) return false;
  const path = url.split(/[?#]/)[0];
  if (['/@', '/src/', '/node_modules/', '/api/'].some((p) => path.startsWith(p))) return false;
  const last = path.slice(path.lastIndexOf('/') + 1);
  const dot = last.lastIndexOf('.');
  if (dot !== -1 && last.slice(dot).toLowerCase() !== '.html') return false;
  return true;
}

function originOf(raw) {
  try { return new URL(raw).origin; } catch { return '(unparsable)'; }
}

function setInit(url, value) {
  const q = url.indexOf('?');
  const hashAt = url.indexOf('#');
  const end = hashAt === -1 ? url.length : hashAt;
  const path = q === -1 || q > end ? url.slice(0, end) : url.slice(0, q);
  const search = q === -1 || q > end ? '' : url.slice(q + 1, end);
  const hash = url.slice(end);
  const params = new URLSearchParams(search);
  params.delete('init');
  if (value != null) params.set('init', value);
  const s = params.toString();
  return path + (s ? `?${s}` : '') + hash;
}

function getInit(url) {
  const q = url.indexOf('?');
  if (q === -1) return null;
  const hashAt = url.indexOf('#');
  const search = url.slice(q + 1, hashAt === -1 || hashAt < q ? undefined : hashAt);
  return new URLSearchParams(search).get('init');
}

function hasInit(url) {
  const q = url.indexOf('?');
  if (q === -1) return false;
  return new URLSearchParams(url.slice(q + 1).split('#')[0]).has('init');
}

/** Vite plugin: remembers a valid Cribl `init` URL (persisted) and re-adds it to iframe navigations. */
export function criblPreview() {
  const stateFile = process.env.PULSE_PREVIEW_STATE || join('node_modules', '.cache', 'pulse', 'preview.json');
  const hosts = (process.env.PULSE_PREVIEW_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean);
  let remembered = null;

  try {
    if (existsSync(stateFile)) {
      const saved = JSON.parse(readFileSync(stateFile, 'utf-8'));
      const ok = saved && typeof saved === 'object' ? validInitUrl(saved.initUrl, { hosts }) : null;
      if (ok) {
        remembered = ok;
        console.log(`[pulse] live preview: init script from ${originOf(ok)} (remembered ${saved.savedAt})`);
      }
    }
  } catch { /* corrupt state: nothing remembered */ }

  const middleware = (req, _res, next) => {
    try {
      const url = req.url || '';
      if (hasInit(url)) {
        const init = getInit(url);
        const valid = validInitUrl(init, { hosts });
        if (valid) {
          remembered = valid;
          try {
            mkdirSync(dirname(stateFile), { recursive: true });
            writeFileSync(stateFile, JSON.stringify({ initUrl: valid, savedAt: new Date().toISOString() }));
          } catch { /* best effort */ }
        } else {
          req.url = setInit(url, null);
          if (typeof req.originalUrl === 'string') req.originalUrl = setInit(req.originalUrl, null);
          console.log(`[pulse] live preview: ignored init script from ${originOf(init)}`);
        }
      } else if (remembered && isPreviewNavigation({ method: req.method, url, headers: req.headers })) {
        req.url = setInit(url, remembered);
        if (typeof req.originalUrl === 'string') req.originalUrl = setInit(req.originalUrl, remembered);
      }
    } catch { /* never break the dev server */ }
    next();
  };

  return {
    name: 'pulse-cribl-preview',
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    middleware,
  };
}
