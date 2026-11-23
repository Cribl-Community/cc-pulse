// Source-reading checks for the Overview's "Snapshot as of … / Live" line (spec 025, F10).
// Run: node scripts/test-sourceline.mjs   (also run by `npm test`)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ov = readFileSync(join(root, 'src/pages/Overview.tsx'), 'utf8');
const ui = readFileSync(join(root, 'src/components/ui.tsx'), 'utf8');

let fail = 0;
const ok = (c, msg) => { if (!c) { fail++; console.log(`FAIL ${msg}`); } };

ok(/stateSource === 'snapshot'[\s\S]{0,300}`Snapshot as of \$\{formatTs\(stateAsOf, scope\.tz\)\} · \$\{settings\.searchLoad === 'hourly' \? 'hourly' : 'every 5 min'\}`\) : 'Live'/.test(ov),
  "snapshot → 'Snapshot as of ${formatTs(asOf, tz)} · every 5 min', otherwise 'Live'");
ok(/import \{ formatTs \} from '\.\.\/lib\/timefmt'/.test(ov), 'formatTs comes from lib/timefmt');
ok(/<Text variant="body-xs-normal" color="subtle">\{sourceText\}<\/Text>/.test(ov), 'Text variant body-xs-normal, color subtle');
ok(/stateReason && stateSource !== 'snapshot'[\s\S]{0,40}<Tooltip title=\{reasonMessage\(stateReason\)\}/.test(ov), 'Live with a reason → Tooltip with reasonMessage(stateReason)');
ok(/sourceLine=\{sourceLine\}/.test(ov), 'Overview passes sourceLine to Page');
ok(/\{updatedAt && sourceLine\}/.test(ui), 'Page draws sourceLine next to Updated');

if (fail) { console.log(`${fail} failed`); process.exit(1); }
console.log('test-sourceline: ok');
