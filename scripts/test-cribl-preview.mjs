#!/usr/bin/env node
// Unit tests for dev/cribl-preview.mjs (spec 021 T1): validInitUrl, isPreviewNavigation.
import assert from 'node:assert/strict';
import { isPreviewNavigation, validInitUrl } from '../dev/cribl-preview.mjs';

// validInitUrl: accepted
const good = 'https://main-x.cribl.cloud/app-ui/__local__/init.js?apiUrl=https://main-x.cribl.cloud/api/v1';
assert.equal(validInitUrl(good), good);
assert.equal(validInitUrl('https://main-x.cribl.cloud/app-ui/__local__/init.js'), 'https://main-x.cribl.cloud/app-ui/__local__/init.js');
const onprem = 'http://leader.local:9000/app-ui/a/init.js';
assert.equal(validInitUrl(onprem, { hosts: ['leader.local:9000'] }), onprem);
assert.equal(validInitUrl(`${onprem}?apiUrl=${encodeURIComponent('http://leader.local:9000/api/v1')}`, { hosts: ['leader.local:9000'] }) !== null, true);

// validInitUrl: rejected
const bad = [
  ['https://x.cribl.cloud.evil.example/app-ui/a/init.js'],
  ['https://evilcribl.cloud/app-ui/a/init.js'],
  ['https://.cribl.cloud/app-ui/a/init.js'],
  ['http://main-x.cribl.cloud/app-ui/a/init.js'],
  ['https://main-x.cribl.cloud/app-ui/a/b/init.js'],
  ['https://main-x.cribl.cloud/other.js'],
  ['https://main-x.cribl.cloud/app-ui/a/init.js/../x.js'],
  ['https://main-x.cribl.cloud/app-ui/a/init.js?apiUrl=https://evil.example/api/v1'],
  ['https://main-x.cribl.cloud/app-ui/a/init.js?apiUrl=http://main-x.cribl.cloud/api/v1'],
  ['https://main-x.cribl.cloud/app-ui/a/init.js?apiUrl=not%20a%20url'],
  ['javascript:alert(1)'],
  [''],
  [undefined],
  [null],
  [42],
  [{}],
  ['not a url at all'],
  [onprem],
  [onprem, { hosts: ['leader.local'] }],
  [onprem, { hosts: [] }],
  ['ftp://leader.local:9000/app-ui/a/init.js', { hosts: ['leader.local:9000'] }],
  [onprem, { hosts: 'leader.local:9000x' }],
  [onprem, null],
];
for (const [raw, opts] of bad) {
  let got;
  assert.doesNotThrow(() => { got = opts === null ? validInitUrl(raw, undefined) : validInitUrl(raw, opts); }, `throws for ${String(raw)}`);
  assert.equal(got, null, `expected null for ${String(raw)} ${JSON.stringify(opts)}`);
}
assert.doesNotThrow(() => validInitUrl());
assert.equal(validInitUrl(), null);

// isPreviewNavigation
const nav = (method, url, dest) => ({ method, url, headers: dest ? { 'sec-fetch-dest': dest } : {} });
for (const u of ['/incidents', '/', '/index.html', '/incidents?earliest=-24h']) {
  assert.equal(isPreviewNavigation(nav('GET', u, 'iframe')), true, `true for ${u}`);
}
const no = [
  nav('GET', '/incidents', 'document'),
  nav('GET', '/incidents', undefined),
  { method: 'GET', url: '/incidents' },
  nav('POST', '/incidents', 'iframe'),
  nav('GET', '/@vite/client', 'iframe'),
  nav('GET', '/src/main.tsx', 'iframe'),
  nav('GET', '/node_modules/x', 'iframe'),
  nav('GET', '/api/v1/x', 'iframe'),
  nav('GET', '/assets/a.js', 'iframe'),
  nav('GET', '/favicon.svg', 'iframe'),
];
for (const input of no) assert.equal(isPreviewNavigation(input), false, `false for ${JSON.stringify(input)}`);

console.log('test-cribl-preview: ok');
