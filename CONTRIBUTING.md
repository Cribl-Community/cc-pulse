# Contributing to Pulse

Thanks for helping. Issues and pull requests are welcome.

## How changes ship

This repository is generated from the maintainer's development repository on every release. A pull request here is reviewed as usual; once accepted, the maintainer ports it to the development repository and it ships in the next release. That is why a merged change may reappear here as part of a "Release vX.Y.Z" commit rather than as your own commit.

Report security issues privately, not in a pull request or issue: see [Security](README.md#security).

## Development

You need Node.js 22.22.2 or later and GNU tar (`brew install gnu-tar` on macOS) to build the bundled Stream pack.

```bash
npm ci
npm run dev        # demo data outside Cribl
npm test           # all scripts/test-*.mjs suites, starting with pack resolver ⇄ app resolver parity
npm run lint
npm run build      # builds the pack (.crbl), type-checks, bundles
npm run package    # build/cc-pulse-<version>.tgz
```

`npm run dev:live` runs the dev server against a real Cribl org instead of demo data; see [dev/README.md](dev/README.md).

Before opening a pull request, run `npm run lint`, `npm test` and `npm run build`. The Test workflow runs the same checks on every pull request.

## Project layout

```text
src/            UI (pages/, components/, lib/ — kql.ts detection, identity.ts asset keys, history.ts availability)
bundle/         Stream pack cribl-pulse (built into public/cribl-pulse.crbl)
config/         policies.yml, proxies.yml, backend.yml, schedules.yml
dev/            live mode and preview plugins for the Vite dev server
scripts/        build-pack.sh and the test suites (test-*.mjs)
```

App development conventions for the Cribl App Platform (fetch proxy, KV store, `policies.yml`, theming) are in [AGENTS.md](AGENTS.md).

## Rules worth knowing

* **Permissions:** the app runs in Strict mode, so every Cribl API path it calls must be in `config/policies.yml`. Keep grants minimal and never add DELETE.
* **Storage:** use the app KV store, never browser storage.
* **Volatile operations:** any change to the user's Cribl configuration is a plan step that the user confirms; nothing runs on page load or a timer.
* **Design:** use the Capra design system and its tokens through `token()`; never hard-code colours.

## UI primitives

The pages are built from six primitives in `src/components/ui.tsx`. Use them instead of ad-hoc cards.

| Primitive | Props (main) | When to use it |
|---|---|---|
| `Page` | `title`, `crumbs`, `description`, `actions`, `tabs`, `defaultTab`, `onRefresh`, `refreshing`, `updatedAt` | Every page. Header band, breadcrumb, header tabs (bound to `?tab=`). |
| `Metric` | `label`, `value`, `hint`, `span`, `loading`, `tag`, `delta`, `to` | A single number. Value stays in the default foreground colour; an optional `tag` carries status. |
| `Section` | `id`, `title`, `collapsible`, `defaultCollapsed`, `loading`, `error`, `onRetry`, `stats` | A flat module of content. Give it an `id` when it is collapsible. Errors show *Retry* and never break the rest of the page. |
| `Question` | question text, answer, link target | A card that asks a plain question (for example "Which source has the most missing senders?") and opens the matching drill. |
| `Ranked` | rows, `active`, `onSelect` | A keyboard-navigable list (↑/↓, Enter) with a 5 px magnitude bar per row. |
| `Drill` | `Ranked` props plus `detail` | A `Ranked` list on the left and a detail pane on the right. Use it when a list needs a closer look. |

### Collapsed sections

A collapsible `Section` stores its state in the app KV store at `ui/collapsed/<sectionId>`, never in browser storage. The key is built by `collapsedKey()` in `src/lib/layout.ts`.

### Colour discipline

* Status colours (`danger`, `warning`, `success`, `info`, `neutral`) appear only on tags, tile and dot marks, chart series that encode state, and the danger annotation on the heartbeat trace.
* They never appear on numbers, card borders, stripes or headers.
* Cards have a 1 px neutral border, no shadow at rest, and a hover that changes only the border and background.
* Links use `foreground.link` at regular weight. Only the first column of a table is a link.
* Chart series come from `getChartTheme({ palette: 'categorical.observable10', mode })`.
* All colours and shadows come from Capra tokens through `token()`. Do not hard-code colours.

## Releases

Maintainers release by pushing a `vX.Y.Z` tag. The Release workflow then builds the app, publishes the Import-from-Git layout (ref `latest`), creates the GitHub Release with the `.tgz`, and submits it to the Cribl Marketplace for review.
