# Pulse

Pulse tells you which sender stopped sending to your Cribl sources, and why — even when the events carry no usable host field.

This README uses fixed section names and a fixed metadata table so it can be rendered as normal Markdown today and parsed into App Gallery components later.

## Summary

Pulse is a Cribl app for data-completeness monitoring. It learns which assets (hosts, firewalls, pods, sensors) send to each Cribl Stream source and how often. It alerts through Cribl Search when one goes silent, arrives late or drops in volume, and explains the most likely cause.

## What This App Does

* Primary purpose: detect a missing sender per source, which source-level metrics cannot see.
* Key capabilities:
  * **Heartbeat per sender.** The bundled Stream pack emits one small metric per (worker group, source, asset) per minute.
  * **Asset identity when `host` is missing or useless.** Pulse tries common host fields, the syslog header, `devname=`/`dvchost=` and the source IP. You can also set a rule per source (CSV column, key=value, JSON path, regex). A Key Advisor suggests the rule from real samples.
  * **Learned cadence and tolerance per asset.** There is no host list to maintain: new assets are learned, and silent ones age out.
  * **Root-cause hints.** Pulse separates one host, a shared cause, a whole source and a whole worker group. A collective silence sends one alert instead of one per asset.
  * **Signals beyond silence:**
    * delayed data (late, not lost);
    * a sender's clock running ahead;
    * low volume against the asset's usual hour.
  * **Policies:**
    * maintenance windows;
    * acknowledgements that end when the asset sends again;
    * HA clusters, where a silent member is covered while its peers send;
    * classification rules that give new assets an owner and a criticality.
  * **History:** incidents, availability % and flapping assets, all recomputed from the heartbeat.
  * **Ask Pulse:** ask questions in plain language. Changes come back as a plan you approve.
* Intended users: Cribl platform owners and admins, SecOps and observability on-call staff, and SEs running POVs.
* Works with: Stream, Search, Lake, Cribl.Cloud and hybrid worker groups.

## When To Use This App

* "One of my 40 syslog senders stopped and nobody noticed for two days."
* Sources whose events say `host=localhost`, or have no host at all (datagen, raw TCP, REST collectors, PAN-OS CSV).
* Proving data completeness during a POV, or before a SIEM migration.

## Before You Install

* Cribl.Cloud or hybrid, with Cribl Search and Cribl Lake.
* An admin who can install packs, change routes, commit and deploy on the worker groups you want to watch.
* No external system is required. Cribl AI is used by default for Ask Pulse; Anthropic or OpenAI are optional.

## Installation

### Install From Marketplace or URL
1. Go to Apps in your Cribl environment.
2. Choose the Marketplace or import from URL option, then review and install.

### If The App Is Not Yet In The Cribl Marketplace
1. Download the `.tgz` from the repository's Releases.
2. In Cribl, go to Apps, choose import from file, and upload it.

## Configuration

| Setting | Required | Description | Example | Scope |
|---|---|---|---|---|
| Lake dataset | Yes | Where heartbeats are stored | `pulse_metrics` | per-app |
| Stream destination | Yes | Lake destination created on each group | `pulse_lake` | per-app |
| Learning rule | No | tolerance = clamp(K × learned gap, min, max) | K 3, 5 min to 4 h | per-app |
| Grace, lag, volume, collective silence | No | Alert tuning (Alerts page) | grace 0 s, delayed after 15 min | per-app |
| Asset key per source | No | Where the sender name lives (Identity page) | `csv:2 \| ip` | per worker group |
| AI provider | No | Cribl AI (default), Anthropic or OpenAI | Cribl AI | per-app |

Every setting has a safe default, so Deploy works with no configuration.

## How To Use

### Typical Workflow
1. **Deploy.** Pick a worker group and the sources to watch, review the plan, and apply it. Pulse installs the pack, the route, the destination and the dataset, then commits and deploys.
2. **Alerts.** Install the scheduled searches and notifications in Cribl Search.
3. **Identity.** Fix any source marked *Unreliable* or *Source only* with the Key Advisor.
4. **Overview.** Start your day here. The Incidents page shows history, and Policies holds maintenance windows, HA clusters and rules.

### First run
The first step is to deploy Pulse to a worker group: open Settings → Deploy, pick the group and sources, and apply the plan. Heartbeats take about 15 minutes to arrive after that, so the first results are not instant.

Pulse shows one of three setup states:
* **Not deployed.** Overview shows a *Set up Pulse* screen, and the pages that need data show a *Set up Pulse* button.* **Waiting.** Pulse is deployed, but no heartbeats have arrived yet. Overview shows *Waiting for the first heartbeats* with a *Refresh* button.
* **Ready.** Heartbeats are arriving and the pages show live data.

On the first visit in the *Not deployed* state, Pulse opens a short setup guide. Its dismissal is stored in the app KV store under the key `ui/onboarding` (with a `dismissedAt` time). Choosing *Not now*, pressing Escape, clicking the backdrop or *Open Deploy* stores the dismissal, so the guide does not open again.

To show the guide again, either delete the `ui/onboarding` key from the app KV store, or open Settings → General and click *Show the setup guide*. The button opens the guide in any setup state and does not change the stored dismissal.

### First-Run Checklist
* Deploy to one worker group and wait about 10 minutes for the learning period.
* Apply the Alerts plan.
* Open Identity and check that every source has real asset names.

## Permissions

The app runs in `policiesOnly` mode: `config/policies.yml` lists every Cribl API path it calls. A missing grant returns 403, and the UI names the path to add.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/master/groups`, `/m/*/system/inputs` | List worker groups and sources |
| GET, POST, PUT, PATCH | `/m/*/packs`, `/m/*/packs/*`, `/m/*/p/*` | Install and upgrade the pack; set pack variables (worker group, asset keys) |
| GET, POST, PATCH | `/m/*/system/outputs`, `/m/*/routes/*` | Lake destination and the observer route |
| POST, PATCH | `/version/commit`, `/master/groups/*` | Commit and deploy |
| GET, POST | `/products/lake/lakes/default/datasets` | Create the heartbeat dataset |
| POST, GET | `/m/default_search/search/jobs`, `/jobs/*` | Run the detection queries |
| GET, POST, PATCH | `/m/default_search/search/saved`, `/notifications` | Scheduled searches and notifications |
| GET, POST, PUT, PATCH | `/m/default_search/system/lookups` | `pulse_overrides`, `pulse_assets`, `pulse_maintenance` lookups |
| GET | `/notification-targets` | Notification targets |
| POST | `/ai/q/agents/open_investigator` | Cribl AI for Ask Pulse |

## External API Access

### Default Configuration
* `config/policies.yml`: the Cribl API grants above.
* `config/proxies.yml`: optional `api.anthropic.com` and `api.openai.com`, with the API key injected from encrypted app KV.

### External Endpoints
* None by default. Cribl AI stays inside Cribl.

## Data And Storage

* **Lake dataset** (`pulse_metrics`): one heartbeat per asset per minute. With samples on, it also holds 3 truncated raw events per source every 15 minutes for the Key Advisor; set `PULSE_SAMPLE=false` on the pack to stop them.
* **App KV:** settings, overrides (mutes, thresholds, acknowledgements), inventory, HA clusters, classification rules, maintenance windows, asset keys per group, deployment log.
* **Search lookups** (published from KV): `pulse_overrides.csv`, `pulse_assets.csv`, `pulse_maintenance.csv`, plus `pulse_state` (written by a scheduled search).

## Support

### Internal Only
This app is a Cribl SE project for demos and proofs of value. Contact the maintainer, Simon Duchene, through the repository's issues.

## Known Limitations

* The heartbeat dataset must be named in `config/policies.yml`, because Search grants datasets by name. So must its `_5m` rollup dataset (for example `pulse_metrics_5m`).
* Hybrid groups write to Lake. The Search metrics store (PromQL monitors) waits on the hybrid → Search destination.
* A maintenance lookup holds one row per scope, so only one window per scope is active at a time.

## Troubleshooting

### The App Opens But Some Features Do Not Work
* Overview says "Pulse needs its lookups": apply the plan shown there, or the Alerts plan.
* A 403 error names the `policies.yml` entry to add.

### Asset Names Look Wrong
* Open Identity, then **Choose key**. The Key Advisor needs pack 1.2 or later for samples.

## Calm Console Primitives

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

### Checking the look

* `node scripts/check-013.mjs` checks the calm-console rules in the source (no `Kpi`/`Lift`, no resting shadows or glow, no status colour on numbers, and so on). Add `--final` to also check the finished pages.
* Screenshots for human sign-off come from `specs/013-aio-look-and-feel/harness/shoot-pulse.cjs`. It writes light and dark images of Overview, Incidents, Assets, Worker group, Asset and Settings into `specs/013-aio-look-and-feel/ref/after/`, to be compared with the `ref/aio-*` references.

## Development

```bash
npm install
npm run dev        # demo data outside Cribl
npm test           # pack resolver ⇄ app resolver parity
npm run build      # builds the pack (.crbl), type-checks, bundles
npm run package    # build/pulse-<version>.tgz
```

## Project Layout

```text
src/            UI (pages/, components/, lib/ — kql.ts detection, identity.ts asset keys, history.ts availability)
bundle/         Stream pack cribl-pulse (built into public/cribl-pulse.crbl)
config/         policies.yml, proxies.yml, backend.yml, schedules.yml
specs/          one spec per feature (002 app, 003–009 features)
mockups/        design mockups (v2: the visual refresh)
scripts/        build-pack.sh, test-identity.mjs
```

## Versioning And Releases

Semantic versioning. The app version is in `package.json`; the pack version is in `bundle/stream-pack/package.json`, with its changelog in the pack README.

## Contributing

Open an issue or a pull request. New features get a spec under `specs/`.

## License

This app is licensed under the terms in [LICENSE](./LICENSE).

## App Metadata

| Field | Value |
|---|---|
| App Name | Pulse |
| App ID | pulse |
| Version | 0.2.2 |
| Author | Internal Team |
| Support Model | internal-only |
| Support Label | Internal Only |
| Support Contact | https://github.com/simondev65/pulse/issues |
| License | See LICENSE |
| License File | [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| Product Tags | stream, search, lake |
| Category | monitoring |
| Audience | admin, platform-owner |
| Availability | preview |
| Requires External Access | no |
| Repository | https://github.com/simondev65/pulse |
| Documentation | https://github.com/simondev65/pulse#readme |
| README Schema Version | 1.0 |
