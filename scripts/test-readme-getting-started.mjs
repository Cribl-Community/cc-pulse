// F11: Marketplace README Getting started points at Settings → Setup and one Deploy everything run.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const readme = readFileSync(join(root, 'README.md'), 'utf8');

let fail = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? '✔' : '✘'} ${msg}`);
  if (!cond) fail++;
};

const gs = readme.match(/### Getting started\n([\s\S]*?)(?=\n### |\n## )/)?.[1] ?? '';
ok(gs.length > 0, 'README has a Getting started subsection under How To Use');
ok(/Settings → Setup/.test(gs), 'Getting started mentions Settings → Setup');
ok(/tick the (worker )?groups/i.test(gs), 'Getting started mentions ticking the groups');
ok(/choose sources|pick sources/i.test(gs), 'Getting started mentions choosing sources');
ok(/Deploy everything/.test(gs), 'Getting started mentions Deploy everything');
ok(/Search/.test(gs) && /same (run|action|plan)/i.test(gs), 'Getting started says Cribl Search alerts deploy in the same action');

const firstRun = readme.match(/### First run\n([\s\S]*?)(?=\n### |\n## )/)?.[1] ?? '';
ok(firstRun.length > 0, 'README has a First run subsection under How To Use');
ok(!/Settings → Deploy/.test(firstRun.split('\n')[0] ?? firstRun.slice(0, 200)), 'First run opening sentence no longer starts at Settings → Deploy');
ok(/Settings → Setup/.test(firstRun), 'First run points at Settings → Setup');

// The Alerts plan is no longer on the Alerts tab. Schedules change only when Setup deploys.
const searchLoad = readme.split('\n').find((l) => l.startsWith('**Search load**')) ?? '';
ok(searchLoad.length > 0, 'README has the Search load paragraph');
ok(/deploy from Setup/i.test(searchLoad), 'Search load says a load change applies when you deploy from Setup');
ok(/writes nothing/i.test(searchLoad), 'Search load still says a pick writes nothing until that deploy');
ok(/disabled, never deleted/.test(searchLoad), 'unused searches stay disabled, never deleted');
ok(!/Alerts plan/i.test(searchLoad), 'Search load does not say to apply the Alerts plan');

const workflow = readme.match(/### Typical Workflow\n([\s\S]*?)(?=\n### |\n## )/)?.[1] ?? '';
ok(workflow.length > 0, 'README has a Typical Workflow');
ok(/Settings → Setup/.test(workflow), 'Typical workflow starts at Settings → Setup');
ok(/Deploy everything/.test(workflow), 'Typical workflow deploys with Deploy everything');
ok(/scheduled searches/i.test(workflow), 'Typical workflow installs searches in that same deploy');
ok(!/\*\*Alerts\.\*\*/.test(workflow), 'Typical workflow has no separate Alerts install step');
ok(!/Alerts plan/i.test(workflow), 'Typical workflow does not name an Alerts plan');

const checklist = readme.match(/### First-Run Checklist\n([\s\S]*?)(?=\n### |\n## )/)?.[1] ?? '';
ok(checklist.length > 0, 'README has a First-Run Checklist');
ok(/Settings → Setup/.test(checklist), 'checklist points at Settings → Setup');
ok(/Deploy everything/.test(checklist), 'checklist deploys with Deploy everything');
ok(!/Apply the Alerts plan/i.test(checklist), 'checklist does not say Apply the Alerts plan');
ok(!/Alerts plan/i.test(checklist), 'checklist does not name an Alerts plan');

ok(!/apply the Alerts plan/i.test(readme), 'README never tells the reader to apply the Alerts plan');
ok(!/Alerts plan/i.test(readme), 'README does not name an Alerts plan');

process.exit(fail ? 1 : 0);