// F8: static quality check of Settings → Setup (Setup.tsx and its Setup* components).
// Capra Table / Drawer / Link, no hex colors, no bare <a>, no hard-coded inline colors or spaces, the data load
// in useEffect (useMountedLoad) with results dropped after unmount, and card / link tokens that change with the theme.
// Run: node scripts/test-setup-quality.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };

const files = ['src/pages/Setup.tsx', ...readdirSync(join(root, 'src/components')).filter((f) => /^Setup.*\.tsx$/.test(f)).map((f) => `src/components/${f}`)];
const code = Object.fromEntries(files.map((f) => [f, noComments(read(f))]));
const all = Object.values(code).join('\n');
ok(files.includes('src/components/SetupSourcesDrawer.tsx') && files.includes('src/components/SetupAlerts.tsx'), `Setup files: ${files.join(', ')}`);

/* ── Capra parts ── */
const capra = (name) => new RegExp(`import\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*['"]@capra/core['"]`).test(all);
for (const n of ['Table', 'Drawer', 'Link', 'Modal']) ok(capra(n), `${n} is imported from @capra/core`);
ok(/import\s*\{[^}]*\bTable\b[^}]*\}\s*from\s*['"]@capra\/core['"]/.test(code['src/pages/Setup.tsx']), 'Setup.tsx imports the Table from @capra/core');
ok(/import\s*\{[^}]*\bDrawer\b[^}]*\}\s*from\s*['"]@capra\/core['"]/.test(code['src/components/SetupSourcesDrawer.tsx']), 'SetupSourcesDrawer imports the Drawer from @capra/core');

/* ── no hex, no bare links, no hard-coded inline colors or spaces ── */
for (const [f, s] of Object.entries(code)) {
  const hex = s.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [];
  ok(hex.length === 0, `${f}: no #rgb / #rrggbb literal${hex.length ? ` (${hex.join(', ')})` : ''}`);
  ok(!/<a[\s>]/.test(s), `${f}: no bare <a> element (Capra Link only)`);
  ok(!/\b(?:rgba?|hsla?)\(/.test(s), `${f}: no rgb() / hsl() color`);
  const styles = [...s.matchAll(/style=\{\{([^}]*)\}\}/g)].map((m) => m[1]);
  const bad = styles.filter((st) => /\b(?:color|background\w*|border\w*|boxShadow|shadow|gap|margin\w*|padding\w*)\s*:/.test(st));
  ok(bad.length === 0, `${f}: inline styles hold no color, shadow or space${bad.length ? ` (${bad.join(' | ')})` : ''}`);
}

/* ── the load path: in useEffect, ignored after unmount ── */
const page = code['src/pages/Setup.tsx'];
const hookFile = 'src/components/useMountedLoad.ts';
ok(existsSync(join(root, hookFile)), `${hookFile} exists`);
const hook = existsSync(join(root, hookFile)) ? noComments(read(hookFile)) : '';
ok(/useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*start\([\s\S]*return\s*\(\)\s*=>\s*\{[^}]*=\s*false/.test(hook), 'useMountedLoad starts the load in useEffect and clears its alive flag in the cleanup');
ok(/let\s+on\s*=\s*true[\s\S]*start\(\s*\(\)\s*=>\s*on\s*\)/.test(hook), 'each mount gets its own alive flag (StrictMode remount drops the first load)');
ok(/import\s*\{\s*useMountedLoad\s*\}\s*from\s*['"]\.\.\/components\/useMountedLoad['"]/.test(page) && /useMountedLoad\(\s*\(alive\)\s*=>/.test(page), 'Setup.tsx starts its reads through useMountedLoad((alive) => …)');
// No read started from a useState initializer (that runs during render, before mount).
const inits = [...page.matchAll(/useState(?:<[^>]*>)?\(\s*\(\)\s*=>\s*\{([\s\S]*?)\n {2}\}\);/g)].map((m) => m[1]);
ok(!inits.some((b) => /load(?:Fleet|Rows)\(|\.then\(/.test(b)), 'no load or .then() inside a useState initializer (render time)');
ok(!/useState\(\s*\(\)\s*=>\s*\{\s*\n\s*if \(demo\)/.test(page), 'the old render-time load is gone');
// Every loadFleet()/loadRows() result is checked against alive() / isMounted() before it sets state.
const thens = [...page.matchAll(/load(?:Fleet|Rows)\([^)]*\)\.then\(([\s\S]*?)\);\n/g)].map((m) => m[1]);
ok(thens.length >= 4, `the load and reload paths are found (${thens.length})`);
for (const t of thens) {
  const sets = (t.match(/\bset[A-Z]\w*\(/g) ?? []).length;
  const guards = (t.match(/\b(?:alive|isMounted)\(\)/g) ?? []).length;
  ok(sets === 0 || guards >= 1, `guarded before setState: ${t.replace(/\s+/g, ' ').slice(0, 70)}…`);
}
ok(!/\.then\(set[A-Z]\w*[,)]/.test(page), 'no bare .then(setX): a late result would land on an unmounted page');

/* ── theming: card and link tokens change between light and dark ── */
const css = read('src/App.css');
ok(!/:[^;{}]*#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.test(css.match(/\.setup-alerts-line2[^}]*\}/)?.[0] ?? ''), '.setup-alerts-line2 has no hex');
ok(/\.setup-alerts-title\s*\{[^}]*gap:\s*token\(/.test(css), '.setup-alerts-title gap comes from token()');
const rule = (sel) => css.match(new RegExp(`${sel.replace('.', '\\.')}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
const card = rule('.section-card'), lk = rule('.lk');
ok(/background:\s*token\('color\.background\.panel\.solid'\)/.test(card), '.section-card background is token(color.background.panel.solid)');
ok(/border:[^;]*token\(/.test(card) && /box-shadow:\s*token\(/.test(card) && !/#|rgb/.test(card), '.section-card border and shadow are tokens, no literal color');
ok(/color:\s*token\('color\.foreground\.link'\)/.test(lk), '.lk color is token(color.foreground.link)');

const theme = read('node_modules/@capra/theme/dist/styles.css');
const maps = { light: {}, dark: {} };
for (const m of theme.matchAll(/(:root|\.dark)\s*\{([^}]*)\}/g)) {
  const into = m[1] === ':root' ? maps.light : maps.dark;
  for (const d of m[2].matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) into[d[1]] = d[2].trim();
}
const resolve = (mode, name, depth = 0) => {
  const v = maps[mode][name] ?? maps.light[name];
  if (v === undefined || depth > 10) return v;
  return v.replace(/var\((--[\w-]+)\)/g, (_, n) => resolve(mode, n, depth + 1) ?? '');
};
for (const t of ['color.background.panel.solid', 'color.foreground.link', 'color.foreground.subtle']) {
  const name = `--cds2-${t.replace(/\./g, '-')}`;
  const l = resolve('light', name), d = resolve('dark', name);
  ok(!!l && !!d && l !== d, `token('${t}') differs between light and dark (${l} → ${d})`);
}

process.exit(fail ? 1 : 0);
