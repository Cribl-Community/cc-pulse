#!/usr/bin/env node
// Tests for the spec 013 §1 navigation consolidation (feature F3): the 5-item nav with its Settings/Documentation
// footer, /settings/:tab with Capra TabNav, and the redirects from the old config routes.
// Bundles src/App.tsx and src/pages/Settings.tsx with esbuild (no DOM library in the repo) and renders with
// react-dom/server. <Navigate> only acts in an effect, so redirects are checked by matching the real route
// table and calling the matched redirect component inside a render, then reading the element it returns.
// Run: node scripts/test-nav.mjs   (also run by `npm test` through scripts/test-identity.mjs)
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'http://pulse.test/api/v1';
const entry = join(root, 'node_modules/.tmp-nav-entry.mjs');
const out = join(root, 'node_modules/.tmp-nav-bundle.mjs');
writeFileSync(entry, [
  "export * as app from '../src/App.tsx';",
  "export * as settings from '../src/pages/Settings.tsx';",
  "export * as nav from '../src/lib/nav.ts';",
  "export { PulseProvider } from '../src/state.tsx';",
  "export { renderToStaticMarkup } from 'react-dom/server';",
  "export { createElement as h } from 'react';",
  "export { MemoryRouter, Navigate, Route, Routes, createRoutesFromChildren, matchRoutes } from 'react-router-dom';",
].join('\n'));
execFileSync(join(root, 'node_modules/.bin/esbuild'), [entry, '--bundle', '--platform=node', '--format=esm', '--jsx=automatic',
  '--loader:.css=empty', '--loader:.svg=empty', '--loader:.png=empty', '--log-level=error', `--define:window.CRIBL_API_URL="${API}"`,
  '--define:window.CRIBL_BASE_PATH="/"', '--define:process.env.NODE_ENV="production"',
  '--define:import.meta.env={"DEV":false,"PROD":true,"MODE":"test","BASE_URL":"/"}',
  `--outfile=${out}`, '--banner:js=import { createRequire } from "node:module"; const require = createRequire(import.meta.url);'], { stdio: 'inherit' });
// Nothing may hit the network while rendering; effects do not run on the server, but be safe.
globalThis.fetch = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
let mod;
try { mod = await import(`${out}?t=${Date.now()}`); } finally { rmSync(entry, { force: true }); rmSync(out, { force: true }); }
const { app, settings, nav, PulseProvider, renderToStaticMarkup, h, MemoryRouter, Navigate, Route, Routes, createRoutesFromChildren, matchRoutes } = mod;

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };
const at = (url, el) => renderToStaticMarkup(h(MemoryRouter, { initialEntries: [url] }, el));
const count = (s, re) => (s.match(re) ?? []).length;

/* ── nav: 5 primary items, a Settings + Documentation footer, no collapse control ── */
const shell = at('/', h(app.Shell));
const navHtml = shell.slice(0, shell.indexOf('<main'));
const PRIMARY = ['Overview', 'Incidents', 'Assets', 'Worker groups', 'Identity'];
const hrefs = [...navHtml.matchAll(/<a\b[^>]*href="([^"]*)"/g)].map((m) => m[1]);
ok(hrefs.length === 7, `nav renders 7 links: 5 primary + 2 footer (got ${hrefs.length}: ${hrefs.join(', ')})`);
const pos = PRIMARY.map((l) => navHtml.indexOf(`>${l}<`));
ok(pos.every((p) => p >= 0), `nav shows ${PRIMARY.join(' · ')}`);
ok(pos.every((p, i) => i === 0 || p > pos[i - 1]), 'primary items are in spec order');
for (const old of ['Policies', 'Thresholds', 'Alerts', 'Deploy']) ok(!navHtml.includes(`>${old}<`), `${old} is no longer a nav item`);
const sIdx = navHtml.indexOf('>Settings<'), dIdx = navHtml.indexOf('>Documentation<');
ok(sIdx > pos[4] && dIdx > sIdx, 'footer: Settings, then Documentation, after the primary items');
ok(hrefs.includes('/settings/general'), 'Settings footer item links to /settings/general');
ok(hrefs.some((x) => /github\.com/.test(x)), 'Documentation footer item links to the docs');
// Capra only draws a collapse toggle for VerticalNavigation.Collapse (a <button>); the nav's own class names mention "collapsed".
ok(count(navHtml, /<button\b/g) === 0 && !/aria-expanded/.test(navHtml), 'no collapse control in the nav (no toggle button)');
ok(!/collapse/i.test(readFileSync(join(root, 'src/App.tsx'), 'utf8')), 'App.tsx never uses the nav collapse API');
const settingsShell = at('/settings/thresholds', h(app.Shell));
const sNav = settingsShell.slice(0, settingsShell.indexOf('<main'));
const linkTag = (html, href) => (html.match(new RegExp(`<a\\b[^>]*href="${href.replace(/[/.]/g, '\\$&')}"[^>]*>`)) ?? [''])[0];
ok(/aria-current="page"/.test(linkTag(sNav, '/settings/general')), 'Settings footer item is active on /settings/<tab>');
ok(!/aria-current="page"/.test(linkTag(sNav, '/')) && /aria-current="page"/.test(linkTag(navHtml, '/')), 'Overview is active only on /');

/* ── route table ── */
const routes = createRoutesFromChildren(app.AppRoutes().props.children);
const leaf = (path) => matchRoutes(routes, path)?.at(-1);
/** Render `el` at `url` and return what calling component `C` with `props` returns inside that render. */
function returned(url, C, props, path) {
  let res;
  function Probe() { res = C(props); return null; }
  at(url, path ? h(Routes, null, h(Route, { path, element: h(Probe) })) : h(Probe));
  return res;
}

/* ── redirects: old routes → /settings/<tab>, query string kept ── */
for (const tab of ['thresholds', 'policies', 'alerts']) {
  const m = leaf(`/${tab}`);
  ok(m?.route.element?.type === app.LegacyRedirect && m.route.element.props.tab === tab, `/${tab} routes to the redirect for the ${tab} tab`);
  const q = `?asset=${encodeURIComponent('fw 1')}&tab=rules`;
  const nav1 = returned(`/${tab}${q}`, app.LegacyRedirect, m?.route.element?.props ?? { tab });
  ok(nav1?.type === Navigate && nav1.props.to === `/settings/${tab}${q}` && nav1.props.replace === true,
    `/${tab}${q} redirects (replace) to /settings/${tab}${q} (got ${nav1?.props?.to})`);
  const bare = returned(`/${tab}`, app.LegacyRedirect, { tab });
  ok(bare?.props.to === `/settings/${tab}`, `/${tab} without a query redirects to /settings/${tab}`);
  const target = leaf(`/settings/${tab}`);
  ok(target?.route.element?.type === app.AppRoutes().props.children.find((r) => r.props.path === '/settings/:tab').props.element.type
    && target.params.tab === tab, `/settings/${tab} matches /settings/:tab with tab=${tab}`);
}
const deployLeaf = leaf('/deploy');
ok(deployLeaf?.route.path === '/deploy', '/deploy route still exists');
const deployQ = '?x=1';
const deployNav = returned(`/deploy${deployQ}`, app.LegacyDeployRedirect, {});
ok(deployNav?.type === Navigate && deployNav.props.to === `/settings/setup${deployQ}` && deployNav.props.replace === true,
  `/deploy${deployQ} redirects (replace) to /settings/setup${deployQ} (got ${deployNav?.props?.to})`);
ok(returned('/deploy', app.LegacyDeployRedirect, {})?.props.to === '/settings/setup', '/deploy without a query redirects to /settings/setup');
const bareSettings = leaf('/settings');
ok(bareSettings?.route.element?.type === app.LegacyRedirect && bareSettings.route.element.props.tab === 'general', '/settings routes to the General redirect');
ok(returned('/settings', app.LegacyRedirect, { tab: 'general' })?.props.to === '/settings/general', '/settings redirects to /settings/general');

/* ── /settings/:tab renders the tab content with the matching tab selected ── */
const page = (url) => renderToStaticMarkup(h(PulseProvider, null,
  h(MemoryRouter, { initialEntries: [url] }, h(Routes, null, h(Route, { path: '/settings/:tab', element: h(settings.Settings) })))));
const CONTENT = {
  general: 'AI provider and data locations',
  setup: 'Set up Pulse',
  thresholds: 'Preview the effect of a rule before it goes live',
  policies: 'Decide when silence is expected',
  alerts: 'Scheduled detection and notifications in Cribl Search',
};
const activeHref = (html) => {
  const tags = [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((t) => /href="\/settings\//.test(t));
  const act = tags.filter((t) => /aria-current="page"|aria-selected="true"|data-active="true"/.test(t));
  return act.map((t) => t.match(/href="([^"]*)"/)[1]);
};
for (const tab of Object.keys(CONTENT)) {
  let html = '';
  try { html = page(`/settings/${tab}`); } catch (e) { console.log(e); }
  ok(html.includes(CONTENT[tab]), `/settings/${tab} renders the ${tab} content`);
  for (const other of Object.keys(CONTENT)) if (other !== tab) ok(!html.includes(CONTENT[other]), `/settings/${tab} does not render the ${other} content`);
  ok(count(html, /<h1\b/g) === 1 && /<h1\b[^>]*>Settings<\/h1>/.test(html), `/settings/${tab}: one header band titled Settings`);
  ok(count(html, /page-band/g) === 1, `/settings/${tab}: the hosted page draws no second header band`);
  const tabLinks = nav.SETTINGS_TABS.map((t) => html.includes(`href="/settings/${t.key}"`) && html.includes(`>${t.name}<`));
  ok(tabLinks.every(Boolean), `/settings/${tab}: TabNav shows all SETTINGS_TABS`);
  const act = activeHref(html);
  ok(act.length === 1 && act[0] === `/settings/${tab}`, `/settings/${tab}: the ${tab} tab is selected (got ${act.join(', ') || 'none'})`);
}
ok(page('/settings/policies?tab=clusters').includes('HA clusters'), '/settings/policies keeps the Policies sub-tab from ?tab=');

/* ── SettingsTabs on its own ── */
for (const t of nav.SETTINGS_TABS) {
  const act = activeHref(at('/', h(settings.SettingsTabs, { active: t.key })));
  ok(act.length === 1 && act[0] === `/settings/${t.key}`, `SettingsTabs active=${t.key} selects only ${t.name}`);
}

/* ── unknown tab → General, query kept; legacy /settings/deploy → Setup ── */
const unknown = returned('/settings/nope?x=1', () => settings.Settings(), {}, '/settings/:tab');
ok(unknown?.type === Navigate && unknown.props.to === '/settings/general?x=1', `/settings/nope redirects to /settings/general (got ${unknown?.props?.to})`);
const settingsDeploy = returned('/settings/deploy?x=1', () => settings.Settings(), {}, '/settings/:tab');
ok(settingsDeploy?.type === Navigate && settingsDeploy.props.to === '/settings/setup?x=1' && settingsDeploy.props.replace === true,
  `/settings/deploy?x=1 redirects (replace) to /settings/setup?x=1 (got ${settingsDeploy?.props?.to})`);

/* ── helpers ── */
ok(nav.settingsPath('policies', '?tab=rules') === '/settings/policies?tab=rules', 'settingsPath keeps the query');
ok(nav.settingsPath('bogus') === '/settings/general', 'settingsPath: unknown tab → general');
ok(nav.settingsPath('general', '?') === '/settings/general', 'settingsPath drops an empty "?"');

console.log(fail ? `\nnav tests: ${fail} failure(s)` : '\nnav tests OK');
process.exit(fail ? 1 : 0);
