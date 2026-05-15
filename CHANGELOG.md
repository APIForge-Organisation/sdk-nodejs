# Changelog

All notable changes to `apiforgejs` are documented here.

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) — versioning follows [Semantic Versioning](https://semver.org/).

---

## [1.0.3] — 2026-05-15

### Added

- `DRIFT` insight type: detects progressive latency degradation using ordinary least squares over the last 30 days — emitted when slope ≥ 5ms/day over 7+ data points, with a 30-day projection
- `DRIFT` filter chip added to the dashboard Insights view
- 50 unit tests covering `aggregator`, `database`, `insights` and `interceptor`

### Fixed

- Insight messages were written in French — all translated to English
- `react` and `react-dom` removed from production `dependencies` (loaded from CDN)
- CI badge was pointing to `main` with no workflow run — CI now triggers on both `main` and `dev`
- `npm tests` → `npm run tests` in CI and release workflows

### Changed

- Test directory renamed from `test/` to `tests/`

---

## [1.0.0] — 2026-05-15

### Changed

- Dashboard UI now loads React and Babel from jsDelivr CDN instead of local node_modules, making the shared `ui.html` SDK-agnostic and compatible with all future SDKs

---

## [0.1.0] — 2026-05-15

### Added

- Express.js middleware `apiforge()` — drop-in observability with zero mandatory configuration
- Local-first mode with SQLite storage via Node.js built-in `node:sqlite` (requires Node.js ≥ 22.5)
- Per-endpoint metrics: P50 / P90 / P99 latency, request count, 2xx / 4xx / 5xx breakdown
- In-memory aggregation with configurable flush interval (default: 60s)
- Circuit breaker on the transport layer — SDK never crashes the host application
- Built-in dashboard on port 4242 (`/api/summary`, `/api/routes`, `/api/timeseries`)
- Three automatic insight types: `ANOMALY` (Z-score P99), `DEAD` (endpoint inactive 21+ days), `PERF`/`OK` (regression or improvement after a release)
- API Health Score (0–100) combining availability, performance, stability and quality
- Configurable sampling rate, ignored paths, environment label, release tag and service name
- `middleware.shutdown()` for graceful teardown

[1.0.0]: https://github.com/APIForge-Organisation/sdk-nodejs/releases/tag/v1.0.0
[0.1.0]: https://github.com/APIForge-Organisation/sdk-nodejs/releases/tag/v0.1.0
