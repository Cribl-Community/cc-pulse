// One place that finds the Playwright module for every browser check (check-018, -019, -021, live-check).
// Order: $PLAYWRIGHT (if it exists) → the project's node_modules → the global npm root → the newest npx cache.
// The harness, a cron job and an editor terminal do not share a shell profile, so `export PLAYWRIGHT=…` in
// ~/.zshrc is not enough on its own: a check that passed in one shell failed in another (spec 021).
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Path to the playwright module (a directory `require()` accepts), or null. Never throws. */
export function findPlaywright(env = process.env) {
  const has = (p) => { try { return !!p && existsSync(join(p, 'package.json')); } catch { return false; } };
  if (has(env.PLAYWRIGHT)) return env.PLAYWRIGHT;
  try { return dirname(createRequire(join(root, 'package.json')).resolve('playwright/package.json')); } catch { /* not a dependency */ }
  try {
    const g = join(execFileSync('npm', ['root', '-g'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 }).trim(), 'playwright');
    if (has(g)) return g;
  } catch { /* no npm on PATH */ }
  try {
    const npx = join(homedir(), '.npm', '_npx');
    const found = readdirSync(npx).map((d) => join(npx, d, 'node_modules', 'playwright')).filter(has)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (found.length) return found[0];
  } catch { /* no npx cache */ }
  return null;
}

export const PLAYWRIGHT_HELP = 'Playwright not found: set PLAYWRIGHT=<path to the playwright module>, or `npm i -g playwright`';
