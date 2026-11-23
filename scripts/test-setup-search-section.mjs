// F8: compact Search alerts card on Setup (source checks). Run: node scripts/test-setup-search-section.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = readFileSync(join(root, 'src/components/SetupAlerts.tsx'), 'utf8');
const css = readFileSync(join(root, 'src/App.css'), 'utf8');
const page = readFileSync(join(root, 'src/pages/Setup.tsx'), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log(`${c ? '✔' : '✘'} ${m}`); if (!c) fail++; };

ok(/<Section span=\{12\}/.test(src), 'Section span 12');
ok(/setup-alerts-card/.test(src) && /max-height:\s*120px/.test(css), 'card capped at 120px');
ok(/aria-label="include Search in this deploy"/.test(src) && /setup-alerts-title/.test(src), 'include checkbox on the title line');
ok(/saved searches, notifications and lookups/.test(src), 'title-line subtle plan text');
ok(/Reads \$\{settings\.dataset\} \\u00b7 Notify/.test(src), 'Reads … · Notify … line');
ok(/<Link as=\{RouterLink\} to="\/settings\/alerts">change in Alerts/.test(src) && !/<a[ >]/.test(src), 'Capra Link, no bare <a');
ok(/saved searches \\u00b7 \$\{info\.lookups\} lookups/.test(src), 'counts on line 2');
ok(/Search load:/.test(src) && /LOAD_ITEMS/.test(src), 'Search load shown as text');
ok(!/SelectField/.test(src) && !/label="Search load"/.test(src), 'no Search load select on Setup');
ok(/info\.outdated > 0/.test(src) && /searches outdated/.test(src), 'outdated Tag only when outdated');
ok(!/roll-call time on the Alerts tab/.test(src), 'no Economy roll-call link on Setup');
ok(!/#[0-9a-fA-F]{3,8}\b/.test(src), 'no hex colors');
ok(/setSearchInfo\(f\.search\)/.test(page) && /info=\{searchInfo\}/.test(page), 'Setup feeds loadFleet search info');
ok(/alerts:\s*alertsOn/.test(page), 'unticking include marks alerts off in the plan');
ok(!/saveSettings\(/.test(page), 'Setup does not call saveSettings');
process.exit(fail ? 1 : 0);