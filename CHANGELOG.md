# Changelog

All notable Pulse changes are documented here. The public repository and the
GitHub Release for each version carry the matching section.

## [0.2.11] - 2026-11-23

### Added

- Added a Setup page centered on the worker-group fleet, with filtering,
  group selection, and an All/Pick source drawer.
- Added a single deployment plan that can apply Stream, Lake, and Search
  changes together after one confirmation.
- Added Standard, Hourly, and Economy Search load modes.
- Added incident lifecycle tracking, alert routing, recovery handling, and
  notification channels for Slack, Teams, PagerDuty, SNS, and webhooks.

### Fixed

- Made Search queries run against the configured Search org and handle empty
  roll-call results safely.
- Improved live Setup parity, deployment retries, stale-search handling, and
  README/install documentation.

