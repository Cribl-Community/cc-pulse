# Pulse

Pulse tells you which sender stopped sending to your Cribl sources, and why — even when the events carry no usable host field.

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
* Intended users: Cribl platform owners and admins, SecOps and observability on-call staff, and teams running a proof of value.
* Works with: Stream, Search, Lake, Cribl.Cloud and hybrid worker groups.

## When To Use This App

* "One of my 40 syslog senders stopped and nobody noticed for two days."
* Sources whose events say `host=localhost`, or have no host at all (datagen, raw TCP, REST collectors, PAN-OS CSV).
* Proving data completeness during a proof of value, or before a SIEM migration.

## Before You Install

* Cribl.Cloud or hybrid, with Cribl Search and Cribl Lake. Cribl 4.20.0 or later.
* An admin who can install packs, change routes, commit and deploy on the worker groups you want to watch.
* No external system is required. Ask Pulse uses Cribl AI by default; Anthropic or OpenAI are optional and need your own API key.

## Installation

### Install From The Cribl Marketplace
1. In Cribl, open **Apps → Cribl Marketplace** and find **Pulse**.
2. Review the permissions and external access it declares (see [Permissions](#permissions) and [External API Access](#external-api-access)), then install.
3. Share the app with the people who should use it.

### Install From Git
1. Log in to Cribl and then click on **Apps → View All**.
2. Click **Add App → Import from Git**.
3. Paste `https://github.com/Cribl-Community/cc-pulse` as the repo URL. Leave the branch as `main`, or enter a release tag such as `latest` to pin the last production release.
4. Click **Import**.

### Install From File
Download the `.tgz` from the [latest release](https://github.com/Cribl-Community/cc-pulse/releases/latest), then click **Add App → Import from File**.

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

**Search load** (Settings → Alerts) sets how often Cribl Search runs Pulse's saved searches. **Standard** (the default) runs them every 5 minutes, about 1,176 searches a day, so alerts fire 5 to 10 minutes after an asset goes silent. **Hourly** runs 97 searches a day, about one tenth of Standard, and alerts within about an hour. **Economy** runs one roll call a day at the hour you choose (who is reporting, who is missing), with no incident alerts; it carries its result forward between runs, and the history charts read raw data on demand instead of running on every tick. Picking a load writes nothing to Cribl until you deploy from Setup; until then Cribl Search keeps the schedule it has. Searches that a load does not use are disabled, never deleted.

## How To Use

### Getting started
Open **Settings → Setup**, tick the worker groups you want Pulse on, choose **All** or pick sources for each group, then click **Deploy everything**. One confirmation applies Stream (pack, route, destination and commit on each ticked group), the Lake dataset, and — when Search is included — the Cribl Search saved searches and notifications in the same run.

### Settings → Setup
Setup is one page that shows the worker groups, the Cribl Search alerts and the deploy controls.

* **Worker groups table.** Each row is a worker group. Ticking a row *selects* the group (include). The **All / Pick** cell opens the sources Drawer: **All** covers every source in the group, and **Pick** lets you tick individual sources (Apply saves the choice, Cancel leaves the row as it was). A filter box narrows the table, **New groups default** sets whether newly created groups are included, and **Refresh** reloads the fleet.
* **Cribl Search alerts.** The *include Search in this deploy* checkbox controls whether the saved searches and notifications are installed. The section shows what they read and where they notify, the Schedules switch, and a count of saved searches and lookups. A warning appears when some searches are outdated. *change in Alerts* opens the Alerts page.
* **Summary bar.** Shows what the current selection will do: the ticked groups, their sources and, when Search is ticked, the alerts.
* **Show the plan** opens a dialog listing every step, grouped by lane (the shared Storage lane included), in the order they run. The button shows how many steps there are.
* **Deploy everything** asks for confirmation, then applies the plan to the ticked groups in one run.

**Demo data.** Pulse decides between demo and API data with `hostMode()` (in `src/lib/host.ts`). `loadFleet()` (in `src/lib/setupFleet.ts`) returns the demo fleet when `hostMode()` is demo, and the live fleet from the Cribl API otherwise. Under `npm run dev` the page therefore shows the five-group demo fleet from `setupFleet()` in `src/lib/demo.ts`: `prod-eu`, `prod-us`, `edge-paris`, `04-2025` and `lab`. Demo data is read-only, so **Deploy is disabled on demo data**, and the page shows *Demo data — open Pulse in Cribl to deploy.* Nothing is sent to Cribl.

### Typical Workflow
1. **Deploy.** Open **Settings → Setup**, tick the worker groups and the sources to watch, then click **Deploy everything**. One confirmation installs the pack, the route, the destination and the dataset, commits and deploys each ticked group, and — when Search is included — installs the scheduled searches and notifications in Cribl Search. Schedules change only on that deploy.
2. **Identity.** Fix any source marked *Unreliable* or *Source only* with the Key Advisor.
3. **Overview.** Start your day here. The Incidents page shows history, and Policies holds maintenance windows, HA clusters and rules.

### First run
The first step is to deploy Pulse: open **Settings → Setup**, tick the worker groups, choose sources, and click **Deploy everything**. Heartbeats take about 15 minutes to arrive after that, so the first results are not instant.

Pulse shows one of three setup states:
* **Not deployed.** Overview shows a *Set up Pulse* screen, and the pages that need data show a *Set up Pulse* button.
* **Waiting.** Pulse is deployed, but no heartbeats have arrived yet. Overview shows *Waiting for the first heartbeats* with a *Refresh* button.
* **Ready.** Heartbeats are arriving and the pages show live data.

On the first visit in the *Not deployed* state, Pulse opens a short setup guide. To show it again, open Settings → General and click *Show the setup guide*.

### First-Run Checklist
* Open **Settings → Setup**, tick one worker group, leave Cribl Search included, click **Deploy everything**, and wait about 10 minutes for the learning period.
* Open Identity and check that every source has real asset names.

## Permissions

The app runs in Strict mode (`policiesOnly`): it can call only the Cribl API paths listed in `config/policies.yml`, whatever the signed-in user's own role allows. A missing grant returns 403, and the UI names the path to add.

### Cribl API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/master/groups`, `/m/*/system/inputs` | List worker groups and sources |
| GET, POST, PUT, PATCH | `/m/*/packs`, `/m/*/packs/*`, `/m/*/p/*` | Install and upgrade the pack; set pack variables (worker group, asset keys) |
| GET, POST, PATCH | `/m/*/system/outputs`, `/m/*/routes/*` | Lake destination and the observer route |
| POST, PATCH | `/version/commit`, `/master/groups/*` | Commit and deploy |
| GET, POST | `/products/lake/lakes/default/datasets` | Create the heartbeat dataset |
| POST, GET | `/m/default_search/search/jobs`, `/jobs/*` | Run the detection queries |
| GET | `/m/default_search/search/datasets/pulse_metrics*` | Read the heartbeat datasets (granted by name) |
| GET, POST, PATCH | `/m/default_search/search/saved`, `/notifications` | Scheduled searches and notifications |
| GET, POST, PUT, PATCH | `/m/default_search/system/lookups` | `pulse_overrides`, `pulse_assets`, `pulse_maintenance` lookups |
| GET | `/notification-targets` | Notification targets |
| POST | `/ai/q/agents/open_investigator` | Cribl AI for Ask Pulse |

Pulse never sends a DELETE request and never edits or deletes a Lake dataset. Changes to your Cribl configuration (pack, route, destination, dataset, scheduled searches, notifications) are shown as a plan and run only after you confirm it.

## External API Access

### Default Configuration
* `config/policies.yml`: the Cribl API grants above.
* `config/proxies.yml`: two optional AI providers, used only if you choose them for Ask Pulse.

### External Endpoints

| Host | Path | Method | Used when | Credentials |
|---|---|---|---|---|
| `api.anthropic.com` | `/v1/messages` | POST | AI provider is set to Anthropic | `x-api-key` header, injected by the platform proxy from encrypted app KV |
| `api.openai.com` | `/v1/chat/completions` | POST | AI provider is set to OpenAI | `Authorization: Bearer` header, injected by the platform proxy from encrypted app KV |

With the default (Cribl AI), Pulse makes no external calls. No other host is reachable: the platform proxy blocks any host or path not listed in `config/proxies.yml`.

When you choose Anthropic or OpenAI, Ask Pulse sends that provider your question and a short status summary: counts per state, source and worker group names, up to 60 asset names with their owner and criticality, and the names of suspicious and unowned assets. Query results and raw events are not sent.

## Notification channels

Pulse sends alerts to **Cribl notification targets**, the same targets Stream, Edge, Search, Monitors and Insights use. Each Cribl notification has exactly one target, so one failing channel can't silence the others. The targets you switch on in *Settings → Alerts → Channels* are set on separate notifications, one per target.

### Presets

Add a channel from *Settings → Alerts → Channels → Add channel*. Pulse offers four presets:

| Preset | Cribl type | What you enter |
|---|---|---|
| **Slack** | `slack` | An incoming webhook URL. The channel is fixed by the webhook. |
| **Microsoft Teams** | `webhook` (custom format) | A Workflows webhook URL. Pulse wraps the message in an Adaptive Card. |
| **PagerDuty** | `pager_duty` | A routing (integration) key and a default severity. |
| **Webhook** | `webhook` (NDJSON, `POST`) | A URL and an auth method: none, bearer token or basic (username and password). |

**AWS SNS** is listed in the create menu but is not created by Pulse. It needs AWS authentication choices (role, region, FIFO group), so the menu links to Cribl. See [AWS SNS](#aws-sns).

### Create only, with `pulse_` IDs

Pulse can only create targets. Every target it creates has an ID that starts with `pulse_`, for example `pulse_slack_ops`. Pulse never edits or deletes a target, so it cannot change a PagerDuty service or the built-in `system_email` target.

To edit or delete a channel, go to **Cribl → Settings → Notification targets**. Each row in the Channels table links there.

### Secrets

Pulse sends the URL, routing key or token once, when you click Create, and the request goes straight to Cribl. Cribl stores and encrypts it. Pulse does not store secrets: they are not written to app settings or to the app KV store, and they are cleared when the modal closes.

### Send test

*Send test* checks that a channel delivers:

1. Pulse creates or updates one saved search, `pulse_notify_test`, that prints a test message and is scheduled for the next whole minute (UTC). It sends to the chosen target through `pulse_notify_test_notification`.
2. Pulse watches the target's sent and error counts for up to 3 minutes.
3. Pulse shows the result: **Delivered**, **Failed (n errors)**, or **No answer yet, check the channel**.
4. Afterwards, Pulse disables `pulse_notify_test`, so it does not fire again.

Send test uses only the saved search and notification permissions that Pulse already has.

### AWS SNS

Create AWS SNS targets in Cribl, under **Settings → Notification targets**. Pulse does not create them, and you can then switch them on for alerts in Pulse like any other target.

### Alert routing

By default every alert goes to the targets under *Everything else*. Routes let you send some alerts elsewhere. Configure them in *Settings → Alerts → Routing*.

- **Routes are ordered.** Pulse checks them top to bottom. You can have up to 5 routes. Use the up and down arrows to reorder them.
- **Matchers** decide whether a route applies. A route can match on:
  - **Kinds:** `missing` (an asset went silent), `source_down` (a whole input stopped sending) and `digest` (a grouped summary). Empty means all kinds.
  - **Max criticality:** the route applies to assets at this criticality or more critical (P1 to P4).
  - **Team:** the asset's team from the inventory.
  - **Input:** a single input name.

  All matchers on a route must match (they are AND-ed). A route with no matchers matches every alert.
- **Final routes.** When a route is marked *Final* and matches an alert, no later route sees that alert. Alerts that match no final route fall through to the next route and, if nothing else matches, to *Everything else*. Non-final routes do not stop later routes, so one alert can reach several routes. The count and the *(+N more: …)* list in a route's message cover only the alerts that route received.
- **Everything else** is the default route. It receives every alert that no final route matched. It uses the targets you set under *Channels*. It is always last and cannot be removed.
- **Notification IDs.** Each saved search keeps its `pulse_` prefix. Every notification has one target. The first default target gets `<search>_notification`, and each further default target gets `<search>_notification__<targetId>`. A route is `<search>_route_<rid>`, where `<rid>` is `r1` to `r5` and stays the same when you edit or reorder the route. Each target of a route gets its own notification, `<search>_route_<rid>__<targetId>`. When a search writes result slots, `_s1` to `_s4` copies such as `<search>_notification_s1` hold the extra result slots of the same notification. The roll call uses `pulse_roll_call_notification`, or `pulse_roll_call_notification__<targetId>` per target. The older IDs from before this scheme, which end in `_slack` or `_json`, are disabled, never deleted. Pulse cannot delete notifications, so you can remove a disabled one yourself in Cribl Search.
- **Message format per target type:**

  | Target type | Format | What it sends |
  |---|---|---|
  | Slack | Slack message (`slack`) | One line in Slack mrkdwn with a link to the incident view |
  | Email, bulletin, SNS, PagerDuty | Text (`text`) | The alert sentence, counts and links. PagerDuty gets the summary line, up to 1,000 characters, with severity from the route |
  | Generic webhook, Teams | JSON (`json`) | The Pulse alert event v1 described below, as a JSON string |

- **Removed routes are disabled, not deleted.** When you delete a route, change it so it no longer matches its saved search, or switch a channel off under *Channels*, Pulse disables the notification that belonged to it the next time you apply the plan. A disabled notification stays visible in Cribl and sends nothing. Pulse cannot delete notifications, so you can remove a disabled one yourself in Cribl Search if you no longer need it.

### Pulse alert event v1 (webhook payload)

Webhook targets receive a JSON object as the message body. Map these keys in your receiver. The message is at most 1,000 characters.

```json
{"source":"pulse","v":1,"kind":"missing","state":"firing","severity":"critical",
 "asset":"fw01","input":"in_syslog","worker_group":"wg-prod","criticality":1,"team":"network",
 "silent_min":12,"tolerance_s":300,"n_alerts":3,"others":"web02,web03",
 "summary":"P1 network: fw01 stopped sending to in_syslog (wg-prod)","url":"https://example.cribl.cloud/search/jobs","at":"2026-11-18T10:00:00Z"}
```

| Field | Type | Description |
|---|---|---|
| `source` | string | Always `"pulse"`. |
| `v` | number | Contract version. `1` in this release. |
| `kind` | string | `missing`, `source_down` or `digest`. |
| `state` | string | Always `"firing"` in v1. Resolved events are not sent yet. |
| `severity` | string | `critical`, `error`, `warning` or `info`, from criticality (P1 to P4). A route's *Severity* setting applies to PagerDuty only. |
| `asset` | string | The asset name. Empty for `source_down` and `digest`. |
| `input` | string | The input the alert is about. |
| `worker_group` | string | The worker group that the input belongs to. |
| `criticality` | number or null | Criticality from 1 (highest) to 4. `null` when unknown. |
| `team` | string | The owning team. |
| `silent_min` | number or null | Minutes since the asset last reported. `null` for grouped kinds. |
| `tolerance_s` | number or null | The silence tolerance in seconds. `null` for grouped kinds. |
| `n_alerts` | number | How many alerts this run produced. |
| `others` | string | Up to 10 other assets, comma-separated, trimmed to 300 characters. Empty when there are none. |
| `summary` | string | The one-line human summary. |
| `url` | string | Link to the Search results for this run. |
| `at` | string | Time of the event, in ISO 8601 UTC. |

## Incident lifecycle

Pulse opens an incident when an asset or source goes missing and closes it when the data comes back. Incidents are stored in the search results of two saved searches, not in lookups.

### The writers

| Saved search | Kind | Columns |
|---|---|---|
| `pulse_ledger_asset` | Asset incidents | The ledger keeps one row per incident, with `incident_id`, `opened_at`, `last_seen_at_open`, `notified_at`, `event`, `criticality`, `state` and the entity columns (`worker_group`, `input`, `asset`). |
| `pulse_ledger_source` | Source incidents | The same columns, with `asset` empty. |

Each writer reads its own previous run from `$vt_results` (`keepLastN: 2`), so the ledger survives between runs without a lookup file. The alert searches `pulse_alert_missing` and `pulse_alert_source_down` read the writers' output from `$vt_results`. Writers run every five minutes, offset from the alert searches so the alert searches read a finished ledger.

### Events

| Event | Meaning |
|---|---|
| `opened` | The entity is missing and eligible, and has no open incident. It is sent once. |
| `open` | An incident that was already notified and is still open. It is kept in the ledger and not sent again. |
| `reminder` | Still open after `remindH` hours since `notified_at`. Only when *Remind every* is above 0. |
| `resolved` | The entity is sending again (`ok` or `late`). It keeps the opener's `incident_id`. |
| `expired` | The entity left the lookback window (retired or renamed). It is closed so it does not stay open forever. |

Opening is based on state, not on a time window. A run that starts late or is skipped still opens the incident on its next run.

### Incident ID

`incident_id` is `pulse:<kind>:<worker_group>:<input>:<asset>:<opened_at>`. For sources the asset part is empty. The ID is stable from `opened` to `resolved` and is unique per incident. Receivers use it to thread or dedupe events.

### Suppressions

Suppressions (acknowledged, muted, or a maintenance window) only gate **opening**. A suppression that starts after an incident is open does not close it. The incident stays open quietly, with no reminders while the state is `acked` or `muted`, and it resolves normally when the data returns.

### First run

When the writer has never run, it has no previous rows. It seeds the ledger with the currently missing, eligible entities as `open` and sends nothing. Installing Pulse on a site that already has missing entities does not cause an alert storm. No separate seed step is needed. If the writer's saved search is deleted, the next run seeds again.

A late, skipped or lagging state snapshot does not close anything. If a writer run finds no fresh `pulse_state` rows (the state search queued in Search, or the rollup is behind), it keeps every open incident as it was. It only retries events that were not delivered yet: no new `expired`, no `resolved`, and a new `incident_id` is never opened for an outage that is still going on. The writer also writes a placeholder row, so a run of late snapshots is never taken for a first run that seeds again. Only a snapshot that has rows can expire an entity that is missing from it.

### Delivery

Delivery is confirmed against the alert search's own results. The writer compares its ledger with the `(incident_id, event)` pairs that the alert search has delivered. An `opened` or `reminder` that was not delivered is sent again with the same `incident_id`. A `resolved` or `expired` that was not delivered is sent again on the next run. Delivery is at least once, so a receiver may get the same event twice. Use `incident_id` and `event` to dedupe.

### Settings

Settings → Alerts controls two options:

- **Send recovery notifications** (default on). When off, the default route sends only `opened` and `reminder` events. Routes that have no `when.events` of their own follow the same default. Resolved and expired rows are not sent.
- **Remind every (hours)** (`notify.remindH`, default 0). When above 0, an open incident sends a `reminder` every that many hours. 0 turns reminders off.

### PagerDuty auto-resolve

The **PagerDuty (Events v2, auto-resolve)** preset sends events to `https://events.pagerduty.com/v2/enqueue`. It sends `event_action: trigger` for `opened` and `reminder` events and `event_action: resolve` for `resolved` and `expired` events. It uses `dedup_key = incident_id`, so PagerDuty closes the incident it opened without anyone closing it by hand. Use this preset in place of the plain PagerDuty preset if you want incidents to close themselves.

The plain PagerDuty preset (`pager_duty`) cannot resolve an incident, so it only receives `opened` and `reminder` events. Pulse never sends it `resolved` or `expired` events, even when *Send recovery notifications* is on, because PagerDuty would open each one as a new incident. The other targets on the same route still receive recoveries.

## Search impact

Pulse runs five scheduled searches in your Cribl environment. Each one is named `pulse_*` and has `keepLastN: 2`, so only the two latest job records are kept.

| Search | Reads | Cron (UTC) | Offset |
|---|---|---|---|
| `pulse_state` | Heartbeats (`pulse_metrics`, `pulse_metrics_5m`) | `*/5 * * * *` | 0 |
| `pulse_rollup` | Heartbeats (`pulse_metrics`) | `3-59/5 * * * *` | 3 |
| `pulse_alert_missing` | `$vt_results` of `pulse_state` | `2-59/5 * * * *` | 2 |
| `pulse_alert_source_down` | `$vt_results` of `pulse_state` | `2-59/5 * * * *` | 2 |
| `pulse_source_digest` | `$vt_results` of `pulse_state` | `7 * * * *` (hourly) | 7 |

* **The 5-minute cycle.** `pulse_state` runs at minute 0, 5, 10, and so on. `pulse_rollup` runs a few minutes after it and also scans the heartbeat dataset (`pulse_metrics`). It never reads `$vt_results`. The three readers (`pulse_alert_missing`, `pulse_alert_source_down` and `pulse_source_digest`) do not scan heartbeats: they read the `pulse_state` snapshot from `$vt_results`. The two alert searches run a few minutes after `pulse_state`, and `pulse_source_digest` runs once an hour.
* **Search impact.** Only `pulse_state` and `pulse_rollup` scan the heartbeat dataset. The three readers make small reads of the `pulse_state` results in `$vt_results` instead. The before figure is about **117,000 CPU-s per day**, from the job history in the spec's *Problem* section (measured 2026-11-18). The after target is **≤ 110 CPU-s per 5-minute cycle**, which is about 31,700 CPU-s per day. This is expected, not measured: the T0 5 probe (`search-pressure.py`) is deferred until the org has Pulse saved searches again. See `specs/034-search-impact/t0.md`.
* **Compute now.** The app no longer recomputes the state on its own. When the snapshot is missing or too old, the Overview shows a *Snapshot not used* warning. Use **Compute now** there to run the state computation once. The app does not run it on page load or on a timer, so Search only does this work when you ask for it.

## Data And Storage

* **Lake dataset** (`pulse_metrics`, plus its 5-minute rollup `pulse_metrics_5m`): one heartbeat per asset per minute. With samples on, it also holds 3 truncated raw events per source every 15 minutes for the Key Advisor; set `PULSE_SAMPLE=false` on the pack to stop them.
* **App KV:** settings, overrides (mutes, thresholds, acknowledgements), inventory, HA clusters, classification rules, maintenance windows, asset keys per group, deployment log, and UI state. AI API keys are written encrypted and cannot be read back by the browser.
* **Search lookups** (published from KV): `pulse_overrides.csv`, `pulse_assets.csv`, `pulse_maintenance.csv`, plus `pulse_state` (written by a scheduled search).
* **Data stays in your Cribl environment.** Pulse sends nothing outside it, except Ask Pulse requests to an AI provider you choose (see [External API Access](#external-api-access)).

### Removing Pulse
Uninstalling the app does not remove what a deploy from Setup created in your environment, so the heartbeat history is kept. To remove it, delete:
* the `pulse_observer` route, the `cribl-pulse` pack and the `pulse_lake` destination on each worker group, then commit and deploy;
* the `pulse_*` scheduled searches, their notifications and the `pulse_*` lookups in Cribl Search;
* the `pulse_metrics` and `pulse_metrics_5m` Lake datasets, if you do not want to keep the history.

## Security

* **Access:** Strict mode — the app can reach only the Cribl API paths in `config/policies.yml`, for whoever an admin shares it with. Policies are app-wide, so anyone the app is shared with can read the heartbeat datasets through Pulse.
* **Least privilege:** read-only grants wherever the app only reads; writes are limited to what a deploy from Setup creates; no DELETE anywhere.
* **Secrets:** none are held in the browser or in the package. API keys you type go to encrypted, write-only app KV and are injected by the platform proxy.
* **Known vulnerabilities:** none open. `npm audit --omit=dev` reports 0 for the shipped dependencies.
* **Report a vulnerability** privately through [Security → Report a vulnerability](https://github.com/Cribl-Community/cc-pulse/security/advisories/new). Please do not open a public issue for it.
* **Fix targets:** Critical within 10 days, High within 4 weeks.

## Support

* **Support model:** community, best effort. Pulse is not covered by Cribl Support.
* **Questions and bugs:** [GitHub Issues](https://github.com/Cribl-Community/cc-pulse/issues). Answers come as time allows; security reports follow the fix targets in [Security](#security).
* **Maintainer:** Simon Duchene.

## Known Limitations

* The heartbeat dataset must be named in `config/policies.yml`, because Search grants datasets by name. So must its `_5m` rollup dataset. A custom dataset name therefore needs both grants added and the app re-packaged.
* Hybrid groups write to Lake. The Search metrics store (PromQL monitors) waits on the hybrid → Search destination.
* A maintenance lookup holds one row per scope, so only one window per scope is active at a time.

## Troubleshooting

### The App Opens But Some Features Do Not Work
* Overview says "Pulse needs its lookups": open **Set up now** and apply the lookups plan shown there. Schedules and saved searches change only when you deploy from Setup.
* A 403 error names the `policies.yml` entry to add.

### Asset Names Look Wrong
* Open Identity, then **Choose key**. The Key Advisor needs pack 1.2 or later for samples.

### No Data After Deploy
* Heartbeats take about 15 minutes to arrive. If Overview still shows *Waiting for the first heartbeats* after that, check that the worker group deployed successfully and that the watched sources receive events.

## Versioning And Releases

Semantic versioning. Each version is a [GitHub Release](https://github.com/Cribl-Community/cc-pulse/releases) with its `.tgz` and release notes. The durable change history is in [CHANGELOG.md](CHANGELOG.md). The bundled pack's version and changelog are in `bundle/stream-pack`.

## Contributing

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). This repository is generated from the maintainer's development repository, so an accepted change is ported there and ships in the next release.

## License

Apache License 2.0. See [LICENSE](./LICENSE).

## App Metadata

| Field | Value |
|---|---|
| App Name | Pulse |
| App ID | cc-pulse |
| Version | 0.2.12 |
| Author | Simon Duchene - sduchene@cribl.io |
| Support Model | community |
| Support Label | Community, best effort |
| Support Contact | https://github.com/Cribl-Community/cc-pulse/issues |
| License | Apache-2.0 |
| License File | [LICENSE](./LICENSE) |
| Product Tags | stream, search, lake |
| Category | monitoring |
| Audience | admin, platform-owner |
| Availability | preview |
| Requires External Access | optional (Anthropic or OpenAI, only if chosen for Ask Pulse) |
| Repository | https://github.com/Cribl-Community/cc-pulse |
| Documentation | https://github.com/Cribl-Community/cc-pulse#readme |
| README Schema Version | 1.0 |
