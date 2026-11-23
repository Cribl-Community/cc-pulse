# Live mode and live-check

Spec 020 §1–§3. Live mode runs `npm run dev` against your real Cribl org instead of demo data. Demo mode stays the
default.

## What live mode is, and why

`npm run dev` shows demo data when it runs outside Cribl. Demo data can't reproduce what the org produces: real
heartbeats, real deployments, Search's own rejections, and Strict-mode gaps. Specs 015, 016 and 018 each failed on
something only the org showed.

Live mode is a Vite plugin in `dev/cribl-live.mjs`. It plays the platform's part for the dev server:

- it sets `window.CRIBL_API_URL`, so the app is not in demo mode and `src/` is unchanged;
- it forwards `/api/v1/*` to your org, with a bearer token that only the Node dev server holds;
- it checks every request against `config/policies.yml` (Strict mode, see below);
- it blocks writes (see below).

Live mode is off unless `PULSE_LIVE=1` is set.

## Running it

```sh
npm run dev:live
```

This is `PULSE_LIVE=1 vite`. Plain `npm run dev` stays on demo data. On startup the dev server prints one line:
`[live] org … | KV … | overlay … | read-only | policies …`. It never prints the token or the secret. If credentials
are missing, it also prints a message naming the missing variables, and the org shows as `?`.

## Credentials

`CRIBL_CLIENT_ID`, `CRIBL_CLIENT_SECRET` and `CRIBL_ORG` are read in this order:

1. the process environment;
2. the `env` block of `~/.claude/settings.json`, where Claude Code keeps them. A plain terminal doesn't inherit
   these, so this fallback is what usually applies.

If any is missing, startup fails with an error that names every missing variable and no secret value.

## Environment variables

| Variable | Default | Use |
|---|---|---|
| `PULSE_LIVE` | unset | `1` turns live mode on (`npm run dev:live` sets it). |
| `PULSE_LIVE_APP` | `pulse` | App id whose KV store is read through. |
| `PULSE_LIVE_KV` | `app` | `empty` gives no read-through: the fresh-install view. |
| `PULSE_LIVE_KV_DIR` | `.live-kv` | Overlay directory. It is git-ignored. |
| `PULSE_LIVE_POLICIES` | `config/policies.yml` | Policies file for the Strict-mode check. Tests point it at a reduced copy. |
| `PULSE_LIVE_UPSTREAM` | `https://main-<org>.cribl.cloud` | Test hook: a fake Cribl. |
| `PULSE_LIVE_LOGIN` | `https://login.cribl.cloud/oauth/token` | Test hook: a fake login. |
| `PULSE_LIVE_TIMEOUT_MS` | `30000` | Test hook: the upstream timeout in ms. The platform's proxy uses 30 s. |

The three `CRIBL_*` credential variables are documented under Credentials above, not in this table.

## Strict-mode emulation

The installed app runs in Strict mode (`policiesOnly`). It can call only the paths declared in `config/policies.yml`,
and the signed-in user's own role doesn't apply. Live mode emulates this. Every request is compared with the policies
file before it leaves the machine, using the method and the path without `/api/v1`.

- An undeclared method or path gets **403** `{"status":"error","message":…}`. The message names the method, the path
  and `config/policies.yml`.
- The admin token used for live mode ignores the policies file. So without the emulation, every missing grant would
  stay hidden. That is the bug class spec 016 fixed.
- **The org wins.** If the org and the emulation disagree, the emulation is what gets fixed.
- The Strict-mode check runs before the read-only check, so a write with a missing grant reports the missing grant.

## Read-only: what is blocked and why

Live mode is read-only, with no switch. The org is real, and Pulse's writes would change customer configuration.

- **Allowed non-GET requests:** only two calls that read but are sent as POST: `POST /m/default_search/search/jobs`
  (search jobs) and `POST /ai/q/agents/open_investigator` (the AI investigator).
- **Write queries are blocked:** a search job whose query contains `export`, `send` or `collect` gets **405**.
- **DELETE never leaves.** Other non-GET requests get **405** with a message that live mode is read-only.
- **Proxy calls** (`/api/v1/proxy/…`) get **501**: the external proxy isn't emulated.
- **App-scoped paths** (`/api/v1/a/…`) get **403**: an app never addresses those paths itself.
- Deploy, Alerts *apply*, lookup publishing and saved-search writes are blocked by the same rule and show a clear
  message. Testing writes belongs on the installed app. A write mode scoped to one worker group is future work.

A 405 from the browser layer of live-check means the page wrote on load, which breaks an `AGENTS.md` rule.

## KV store in live mode

Reads come from the installed app. Writes stay on your machine.

- **Overlay file:** `<PULSE_LIVE_KV_DIR>/<app>.json`, by default `.live-kv/pulse.json`. It holds
  `{ "<key>": "<body>" | null }`. It is created on the first write, and it is git-ignored.
- **get:**
  - an overlay value returns 200 with the stored body as is;
  - a key deleted in the overlay, a `secrets/…` key with no overlay value, or any key under `PULSE_LIVE_KV=empty`
    returns 404 `{"status":"error","message":"Key not found"}`;
  - any other key is read from the org at `/a/<app>/kvstore/<key>`, and its status and body come back.
- **put:** stores the request body in the overlay and returns 200 `{}`. Nothing is sent to the org.
- **delete:** writes `null` to the overlay (a tombstone) and returns 200 `{}`. Nothing is sent to the org. Later reads
  see the key as deleted, even if the org still has it.
- **keys:** returns the org's keys plus the overlay's keys, minus deleted ones, with no duplicates, filtered by the
  requested prefix. Under `PULSE_LIVE_KV=empty` the org isn't asked.
- **`secrets/` keys** are never read from the org. They only exist in the overlay, if you wrote them locally.
- **`PULSE_LIVE_KV=empty`** starts from an empty store, which is the fresh-install view. It reads nothing from the org.

To reset local state, delete the overlay file or the `.live-kv/` directory.

## Token safety

The token is fetched and cached by the dev server in Node. It is refreshed once on a 401. No response, page, or log
line contains the token or the client secret. Don't add either to `src/`.

## live-check

```sh
node scripts/live-check.mjs
```

It starts its own Vite in live mode on port **5196**, with a fresh temporary `PULSE_LIVE_KV_DIR`. Other `PULSE_LIVE_*`
variables you set are passed through. Everything goes through the proxy, so Strict mode is exercised. The server is
stopped and the temporary directory removed on exit, on failure, and on SIGINT or SIGTERM.

### Preflight

These must be present, or live-check exits non-zero before Vite starts, with a `✘` line. It never skips silently.

- **Credentials:** `loadCreds()` must succeed (see Credentials above).
- **Playwright:** found through `PLAYWRIGHT`, or else `require('playwright')`.
- **`PW_CHROMIUM`** is optional. If set, it is the Chromium executable used by the browser layer.

### What it checks

- **API layer:** reads `settings/app` (falls back to defaults on 404) and runs every query `src/lib/kql.ts` exports,
  bundled with esbuild. A trailing `| export …` stage is cut. Each query runs over `-24h` with a 120 s limit. Any 403
  or 405 is a failure. Returned rows must carry the columns the app reads. Entity and fleet queries must return at
  least one row.
- **Browser layer:** headless Chromium opens `/`, `/incidents`, `/assets`, `/groups`, the first worker group's detail
  page, `/identity`, and each `/settings/<tab>`. It waits until no search job is pending. A page fails on: an empty
  `#root`; the error-boundary text; a `console.error` or uncaught page error; an `/api/v1` response of 403, 405, 501
  or 5xx; or an error alert from Pulse state. The Overview must show at least one entity and no demo marker.

### Cost

One run uses Search credits on Cribl Cloud. It is about **15 queries plus about 5 jobs per page**. live-check prints
the number of search jobs it started. It takes minutes and depends on today's data and the network, so run it at
sign-off, not on every change.

## Live Preview

Cribl's Live Preview loads the dev server with an init script URL in the query string, `?init=`. The URL points at the
app's `init.js` on the org. `vite.config.ts` reads that parameter and injects the script, so the app runs against the
real org instead of falling back to demo data.

### The problem it fixes

The init URL was only present on the first load. It was lost after in-app navigation (a route change that rewrote the
URL) and after a dev server restart. Without it, the app came up on demo data inside Cribl, which hid the same gaps
that live mode exists to expose.

### How `dev/cribl-preview.mjs` remembers it

`criblPreview()` is a Vite plugin in `dev/cribl-preview.mjs`. It:

- remembers the latest valid init URL, and writes it to the state file;
- at startup, loads the state file and reuses the remembered URL if it is still valid;
- re-injects the remembered URL **only on iframe navigations**, that is, requests with `Sec-Fetch-Dest: iframe`.

Plain browser tabs, `npm run dev:live` and Playwright checks don't send `Sec-Fetch-Dest: iframe`, so they are not
affected.

### Accepted URLs

- `https://*.cribl.cloud/app-ui/<id>/init.js`, with a same-origin `apiUrl`.
- On-prem hosts listed in `PULSE_PREVIEW_HOSTS`, which is a comma-separated list of `host:port` values.

Any other URL is ignored, and the dev server logs `[pulse] live preview: ignored init script from <origin>` (or
`(unparsable)`).

### The state file holds no credentials

The state file holds only the init URL and a timestamp, as `{ initUrl, savedAt }`. It never holds a token, a secret,
or any other credential. It is git-ignored, and deleting it resets what is remembered.

### Environment variables

| Variable | Default | Use |
|---|---|---|
| `PULSE_PREVIEW_STATE` | `node_modules/.cache/pulse/preview.json` | Path of the state file that holds the latest valid init URL. |
| `PULSE_PREVIEW_HOSTS` | empty | Extra on-prem hosts (`host:port`, comma-separated) whose init URLs are accepted. |

### Recovery: "Pulse can't reach Cribl"

If Live Preview shows *Pulse can't reach Cribl*, the remembered init URL is stale or the dev server lost its
connection. Recover like this:

1. Click **Exit** in the Live Preview frame.
2. In Cribl, go to **Apps → Live Preview** and open Pulse again.
3. If it still fails, stop `npm run dev` and restart it, then repeat steps 1 and 2.
