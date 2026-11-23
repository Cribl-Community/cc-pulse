// The first-run guide must send people to Settings → Setup, not the removed Deploy tab or an Alerts plan.
// Run: node scripts/test-setup-guide.mjs
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const raw = readFileSync(join(root, 'src/components/SetupGuide.tsx'), 'utf8');
const guide = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

let fail = 0;
const ok = (cond, msg) => { console.log(`${cond ? '✔' : '✘'} ${msg}`); if (!cond) fail++; };

ok(/title="Set up Pulse"/.test(guide), 'modal title is Set up Pulse');
ok(/confirmButtonText="Open Setup"/.test(guide), 'confirm button is Open Setup');
ok(!/Open Deploy/.test(guide), 'guide does not label the confirm button Open Deploy');
ok(/cancelButtonText="Not now"/.test(guide), 'cancel is Not now');
ok(/navigate\('\/settings\/setup'\)/.test(guide), 'confirm navigates to /settings/setup');
ok(!/\/settings\/deploy/.test(guide), 'guide does not navigate to /settings/deploy');
ok(/Settings → Setup/.test(guide), 'steps name Settings → Setup');
ok(/Deploy everything/.test(guide), 'steps name Deploy everything');
ok(!/Settings → Deploy/.test(guide), 'guide does not send people to Settings → Deploy');
ok(!/Alerts plan/i.test(guide), 'guide does not mention an Alerts plan');
ok(!/Settings → Alerts/.test(guide), 'guide does not send people to Settings → Alerts to deploy');
ok(/LEARN_MIN/.test(guide), 'learning time still comes from settings.learning.LEARN_MIN');
ok(/ui\/onboarding/.test(guide), 'dismissal still lives at ui/onboarding');

process.exit(fail ? 1 : 0);
