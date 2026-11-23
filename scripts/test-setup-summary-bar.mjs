// F7: summary bar, Show the plan Modal, demo-disabled Deploy (source checks).
// F4: toolbar and summary layout — separate status line, nowrap labels, token-only CSS.
import { readFileSync } from 'node:fs';

const setup = readFileSync(new URL('../src/pages/Setup.tsx', import.meta.url), 'utf8');
const runner = readFileSync(new URL('../src/components/FleetRunner.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('../src/App.css', import.meta.url), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? 'ok' : 'FAIL'} ${m}`); if (!c) fail++; };

ok(/Show the plan \(\$\{plan\.steps\.length\} steps\)/.test(setup), 'Show the plan label carries the step count');
ok(/planLanes\.map/.test(setup) && /<h3>\{l\.title\}<\/h3>/.test(setup), 'plan modal lists lanes by title');
ok(/demo=\{demo\}/.test(setup), 'Setup passes demo to FleetRunner');
ok(/Demo data/.test(runner), 'demo text in the confirmation');
ok(/<Button variant="primary" disabled>Deploy<\/Button>/.test(runner), 'demo Deploy button is disabled');

/* ── F4: toolbar class, summary layout, CSS tokens ── */
ok(/className="setup-groups-toolbar"/.test(setup), 'worker groups toolbar has setup-groups-toolbar class');
ok(/className="setup-new-groups"/.test(setup), 'New groups control has setup-new-groups class');
ok(/<Menu\b/.test(setup) && /New groups: All/.test(setup) && /New groups: Pick/.test(setup) && !/name="new-groups"/.test(setup), 'New groups is a Menu, not a radio group');
ok(/className="setup-summary-bar"/.test(setup) && /className="setup-summary-row"/.test(setup), 'summary uses setup-summary-bar and setup-summary-row');
ok(/className="nowrap">\{summaryText\}/.test(setup), 'summary text is in a nowrap span');
const summaryBlock = setup.slice(setup.indexOf('setup-summary-bar'), setup.indexOf('setup-summary-bar') + 600);
ok(/setup-summary-row[\s\S]*?\{summaryText\}/.test(summaryBlock), 'summary text sits in setup-summary-row');
ok(/setup-summary-row[\s\S]*?<\/div>[\s\S]*?plan\.invalid/.test(summaryBlock), 'blocking reason is outside setup-summary-row');
ok(!/<span[^>]*>[^<]*\{summaryText\}[^<]*plan\.invalid/.test(setup), 'summary text and invalid reason are not in the same element');
const toolbarRule = css.match(/\.setup-groups-toolbar\s*\{([^}]*)\}/)?.[1] ?? '';
ok(/flex-wrap:\s*nowrap/.test(toolbarRule), '.setup-groups-toolbar is nowrap');
const newGroupsRule = css.match(/\.setup-new-groups\s*\{([^}]*)\}/)?.[1] ?? '';
ok(/white-space:\s*nowrap/.test(newGroupsRule) && /flex-shrink:\s*0/.test(newGroupsRule), '.setup-new-groups nowrap and no shrink');
const setupCss = [...css.matchAll(/\.setup-(?:groups-toolbar|new-groups|summary-bar|summary-row)\s*\{[^}]*\}/g)].map((m) => m[0]).join('\n');
const hexInSetupCss = setupCss.match(/#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g) ?? [];
ok(hexInSetupCss.length === 0, `setup toolbar/summary CSS has no hex (${hexInSetupCss.join(', ') || 'none'})`);
ok(/gap:\s*token\(/.test(setupCss), 'setup toolbar/summary rules use token() for gap');

process.exit(fail ? 1 : 0);