# cribl-pulse (Stream pack)
Installed by the **Pulse** Cribl App. It emits one heartbeat metric, `pulse.heartbeat`, per (worker_group, input, asset) every 60 s.
- Fields: `_metric`, `_value` (events in the minute), `bytes`, `event_lag_s`.
- Dimensions: `worker_group`, `input`, `asset`, `asset_src`, `worker`.

Wire it with a Worker Group route at the top: final **off**, filter `!__inputId.startsWith('cribl:')`, pipeline `pack:cribl-pulse`.

## Naming the asset when `host` is missing or useless
`PULSE_KEYS` maps an input id (`type:id`, or just `id`) to a key spec. Sources that are not listed use `auto`.

| Spec | Takes the asset from |
|---|---|
| `host` | the `host` field (placeholders from `PULSE_WEAK_HOSTS` are skipped; values must be lowercase) |
| `field:<path>` | an event field, e.g. `field:host.name`, `field:Computer` |
| `json:<path>` | a path in `_raw` parsed as JSON |
| `syslog` | the hostname in an RFC 3164 / 5424 header |
| `csv:<n>` | column n (0-based) of `_raw`; `csv:2` is the PAN-OS serial |
| `kv:<key>` | `key=value` or `key="value"` in `_raw`, e.g. `kv:devname` (Fortinet), `kv:dvchost` (CEF) |
| `ip` | the source IP, port stripped, IPv6-safe |
| `source` | the `source` field |
| `regex:<pattern>` | the first capture group (must be the last segment of a chain) |
| `none` | no sender identity: the source is one entity labelled `PULSE_SOURCE_LABEL` |

Chain fallbacks with ` | `, e.g. `kv:devname | ip`.

`auto` tries, in order:
1. `host`
2. common host fields
3. the syslog header
4. `kv:devname`
5. `kv:dvchost`
6. `ip`
7. the source-level entity

The rule that matched is written to `asset_src`.
`PULSE_ASSET_CASE` is `keep` (as received), `lower`, or `short` (lowercase with the domain removed).

## Samples for the Key Advisor
When `PULSE_SAMPLE` is true, the first 3 heartbeats per input in each rolling 15-minute window also carry a
truncated sample of the triggering event: `raw_sample` (`_raw`, first 1,500 chars), `fields_json` (up to 40
top-level non-internal fields, values cut to 120 chars / objects to 400), and `src_ip`. There is no longer a
separate `pulse_sample` route or pipeline cloning every event — samples ride on the heartbeat pipeline's own
Suppress gate. The Pulse app reads either shape (1.2.0's `kind=pulse.sample` events or 1.3.0's heartbeats with
`raw_sample`) to suggest a key. Set `PULSE_SAMPLE` to false to stop sending samples.

## Changelog
### 1.3.0 — 2026-11-09
- Samples for the Key Advisor are folded into the heartbeat pipeline: the `pulse_sample` route and pipeline
  (a second `final: false` clone of every event) are gone. `pulse_heartbeat` is now the only route.
- The heartbeat count (`__n`) is captured before a second, tag-only Suppress (`PULSE_SAMPLE`, key `__inputId`,
  allow 3 per 900 s) marks the first 3 heartbeats of each input's 15-minute window; a Code function then adds
  `raw_sample`, `fields_json` and `src_ip` to those events only. Heartbeats are otherwise byte-identical to 1.2.0.
- Faster asset resolver (same results, less per-event work): a fast path for `auto` + a usable `host`, the
  weak-host list scanned in place (ships lowercase, no more per-event `toLowerCase()` of every entry), and the
  input-id fallback chain built lazily.
- Measured in spike 011 (Cribl 4.19.2, 30k eps): worker CPU added per event is about **-37%** for syslog with
  an unusable host and **-42%** for weblog with a good host, against 1.2.0 — removing the second `pulse_sample`
  clone accounts for most of the gain.
### 1.2.0 — 2026-11-08
- Asset identity: per-source key specs (`PULSE_KEYS`), placeholder hosts skipped, and the source-level entity as the last resort.
- New `asset_src` dimension, plus the variables `PULSE_ASSET_CASE` and `PULSE_SOURCE_LABEL`.
- IPv6 source addresses are no longer cut at the first colon.
- Route `pulse_sample` and pipeline `pulse_sample` send samples for the Key Advisor.
### 1.1.0 — 2026-11-06
- Aggregation was replaced by **Suppress** (key input|asset, 1 per 60 s, drop). Per-event work is now one key lookup.
- `_value` = 1 + `suppressCount`; `bytes` is an estimate.
### 1.0.0 — 2026-11-06
- First Pulse release: metric-shaped output, asset fallback variable.
