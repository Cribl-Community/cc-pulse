#!/usr/bin/env node
// Tests for the criblPreview() middleware (spec 021 T1) with a temp state file and fake req objects.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { criblPreview } from '../dev/cribl-preview.mjs';

const dir = mkdtempSync(join(tmpdir(), 'pulse-prev-'));
const file = join(dir, 'sub', 'preview.json');
process.env.PULSE_PREVIEW_STATE = file;
const logs = [];
const origLog = console.log;
console.log = (...a) => logs.push(a.join(' '));

const A = 'https://main-a.cribl.cloud/app-ui/__local__/init.js?apiUrl=https://main-a.cribl.cloud/api/v1';
const B = 'https://main-b.cribl.cloud/app-ui/__local__/init.js';
const run = (plugin, url, headers = {}) => {
  const req = { method: 'GET', url, originalUrl: url, headers };
  let called = false;
  plugin.middleware(req, {}, () => { called = true; });
  assert.ok(called);
  return req;
};
const iframe = { 'sec-fetch-dest': 'iframe' };

// no file: no throw, unchanged
let p = criblPreview();
assert.equal(run(p, '/incidents', iframe).url, '/incidents');

// valid init saved
let req = run(p, '/?init=' + encodeURIComponent(A));
assert.ok(req.url.includes('init='));
let saved = JSON.parse(readFileSync(file, 'utf-8'));
assert.deepEqual(Object.keys(saved).sort(), ['initUrl', 'savedAt']);
assert.equal(saved.initUrl, A);

// replaced
run(p, '/?init=' + encodeURIComponent(B));
assert.equal(JSON.parse(readFileSync(file, 'utf-8')).initUrl, B);
run(p, '/?init=' + encodeURIComponent(A));

// invalid stripped, not saved, one log naming origin only
logs.length = 0;
req = run(p, '/x?init=' + encodeURIComponent('https://evil.example/app-ui/a/init.js?secret=1') + '&z=1');
assert.equal(req.url, '/x?z=1');
assert.equal(req.originalUrl, '/x?z=1');
assert.equal(JSON.parse(readFileSync(file, 'utf-8')).initUrl, A);
assert.equal(logs.length, 1);
assert.ok(logs[0].includes('https://evil.example'));
assert.ok(!logs[0].includes('secret'));

// iframe rewrite vs document
req = run(p, '/incidents', iframe);
assert.equal(new URL(req.url, 'http://x').searchParams.get('init'), A);
assert.equal(new URL(req.originalUrl, 'http://x').searchParams.get('init'), A);
assert.equal(run(p, '/incidents', { 'sec-fetch-dest': 'document' }).url, '/incidents');

// restart
logs.length = 0;
const p2 = criblPreview();
assert.ok(logs.some((l) => l.startsWith('[pulse] live preview: init script from https://main-a.cribl.cloud')));
assert.equal(new URL(run(p2, '/incidents', iframe).url, 'http://x').searchParams.get('init'), A);

// corrupt / invalid file
writeFileSync(file, '{nope');
assert.equal(run(criblPreview(), '/incidents', iframe).url, '/incidents');
writeFileSync(file, JSON.stringify({ initUrl: 'https://evil.example/app-ui/a/init.js', savedAt: 'x' }));
assert.equal(run(criblPreview(), '/incidents', iframe).url, '/incidents');

console.log = origLog;
console.log('cribl-preview plugin tests passed');
