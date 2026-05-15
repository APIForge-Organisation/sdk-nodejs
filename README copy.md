# apiforgejs

API observability & intelligence SDK for Express.js — local-first, privacy-first.

> Track latency, error rates, and behavioral trends of your APIs. Everything stays on your machine.

## Install

```bash
npm install apiforgejs
```

## Quick start

```javascript
const express = require('express');
const { apiforge } = require('apiforgejs');

const app = express();

// Add the middleware — one line, zero config required
app.use(apiforge({ mode: 'local' }));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.listen(3000, () => {
  console.log('App running on :3000');
  // Dashboard auto-starts at http://localhost:4242
});
```

## Dashboard

Open **http://localhost:4242** after starting your app. The dashboard shows:

- **Health Score** (0–100) — global API health at a glance
- **Latency percentiles** — P50 / P90 / P99 per route
- **Error rates** — 4xx and 5xx breakdown
- **Automatic insights** — latency anomalies, dead endpoints, release regressions
- **Time series chart** — click any route to see its latency over time

Data is collected locally in `.apiforge.db` (SQLite). Nothing leaves your machine.

## Configuration

```javascript
app.use(apiforge({
  mode:          'local',                 // only supported mode in v0.x
  dbPath:        '.apiforge.db',          // SQLite file location
  dashboardPort: 4242,                    // set to 0 to disable dashboard
  flushInterval: 60_000,                  // flush to SQLite every 60s (ms)
  env:           process.env.NODE_ENV,    // 'production' | 'staging' | 'development'
  release:       process.env.APP_VERSION, // enables release regression detection
  service:       'my-api',               // label for multi-service setups
  sampling:      1.0,                     // 0.0–1.0 sample rate
  ignorePaths:   ['/health', '/ping'],    // paths to skip
}));
```

## Release tracking

Pass your release version to enable before/after deployment comparison:

```javascript
app.use(apiforge({
  mode: 'local',
  release: process.env.npm_package_version, // or 'v1.4.0', git SHA, etc.
}));
```

When a new release is detected, APIForge automatically compares P90 latency before vs. after and surfaces regressions as insights.

## Graceful shutdown

```javascript
const forge = apiforge({ mode: 'local' });
app.use(forge);

process.on('SIGTERM', () => {
  forge.shutdown(); // flush remaining buffer to SQLite
  process.exit(0);
});
```

## Privacy by design

The SDK **never** collects:
- Request or response bodies
- HTTP headers (Authorization, Cookie, etc.)
- Query string values
- Route parameter values (`/users/12345` → only `/users/:id` is stored)
- IP addresses or User-Agent strings

Collected fields: route pattern, HTTP method, status code, latency (ms), timestamp, and optional env/release/service labels.

## Data collected

```json
{
  "route":       "GET /users/:id",
  "method":      "GET",
  "status":      200,
  "duration_ms": 134.7,
  "timestamp":   "2026-05-13T10:00:00.000Z",
  "env":         "production",
  "release":     "v1.4.0"
}
```

## Requirements

- Node.js >= 18
- Express >= 4

## License

MIT
