#!/usr/bin/env node
// Guards spec 017 card-shadow rules in src/App.css. Run: node scripts/test-css-shadows.mjs (also run by `npm test`).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const css = readFileSync(join(root, 'src/App.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

// Brace-based parser: returns [{ sel, body, media }] with at-rule nesting flattened (media = enclosing at-rule prelude).
function parse(text, media = '') {
  const rules = []; let i = 0;
  while (i < text.length) {
    const open = text.indexOf('{', i); if (open < 0) break;
    const prelude = text.slice(i, open).trim();
    let depth = 1, j = open + 1;
    while (j < text.length && depth) { if (text[j] === '{') depth++; else if (text[j] === '}') depth--; j++; }
    const body = text.slice(open + 1, j - 1);
    if (prelude.startsWith('@')) rules.push(...parse(body, prelude));
    else for (const sel of prelude.split(',')) rules.push({ sel: sel.trim(), body, media });
    i = j;
  }
  return rules;
}
const rules = parse(css);
let fail = 0;
const ok = (c, m) => { if (!c) { fail++; console.error('FAIL css-shadows:', m); } };
const decls = (r, prop) => [...r.body.matchAll(new RegExp(`(?:^|[;\\s])${prop}\\s*:\\s*([^;]+)`, 'g'))].map((m) => m[1].trim());

for (const s of ['.section-card', '.metric', '.question', '.ask'])
  ok(rules.some((r) => r.sel === s && decls(r, 'box-shadow').includes("token('shadow.low.down')")), `${s} needs box-shadow token('shadow.low.down')`);
ok(rules.some((r) => r.sel === '.metric-link:hover' && decls(r, 'box-shadow').includes("token('shadow.medium.down')")), '.metric-link:hover needs shadow.medium.down');

const allowed = ['.section-card', '.metric', '.question', '.ask', '.metric-link:hover', '.c-tip'];
for (const r of rules) for (const v of decls(r, 'box-shadow')) {
  ok(/^token\('shadow\.[^']+'\)$/.test(v), `${r.sel}: box-shadow must be a token('shadow.*') call, got ${v}`);
  ok(allowed.includes(r.sel) || r.sel.includes(':focus'), `${r.sel}: box-shadow not allowed on this selector`);
}
for (const r of rules) if (r.sel.includes(':hover')) ok(!/\btransform\s*:/.test(r.body), `${r.sel}: :hover must not use transform`);
ok(rules.some((r) => r.sel === '.metric-link' && /prefers-reduced-motion:\s*reduce/.test(r.media) && decls(r, 'transition').includes('none')),
  'reduced-motion block must set .metric-link transition: none');

if (fail) process.exit(1);
console.log('css-shadows: ok');
