# apiforgejs

**API observability & intelligence for Express.js — local-first, privacy-first.**

[![npm version](https://img.shields.io/npm/v/apiforgejs?color=0066FF)](https://www.npmjs.com/package/apiforgejs)
[![CI](https://img.shields.io/github/actions/workflow/status/APIForge-Organisation/sdk-nodejs/ci.yml?branch=main&label=CI)](https://github.com/APIForge-Organisation/sdk-nodejs/actions)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22.5-brightgreen)](https://nodejs.org)

> Track latency, error rates, and behavioral trends of your APIs. Everything stays on your machine.

**→ [Full documentation](https://apiforge-organisation.github.io/docs/)**

---

## Install

```bash
npm install apiforgejs
```

## Quick start

```javascript
const express = require('express');
const { apiforge } = require('apiforgejs');

const app = express();

app.use(apiforge({ mode: 'local' }));

app.get('/users/:id', (req, res) => res.json({ id: req.params.id }));

app.listen(3000, () => {
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
  mode:          'local',
  dbPath:        '.apiforge.db',
  dashboardPort: 4242,             // set to 0 to disable
  flushInterval: 60_000,           // flush to SQLite every 60s (ms)
  env:           process.env.NODE_ENV,
  release:       process.env.APP_VERSION,
  service:       'my-api',
  sampling:      1.0,              // 0.0–1.0 sample rate
  ignorePaths:   ['/health', '/ping'],
}));
```

## Release tracking

Pass your release version to enable before/after deployment comparison:

```javascript
app.use(apiforge({
  mode: 'local',
  release: process.env.npm_package_version,
}));
```

When a new release is detected, APIForge compares P90 latency before vs. after and surfaces regressions as insights automatically.

## Graceful shutdown

```javascript
const forge = apiforge({ mode: 'local' });
app.use(forge);

process.on('SIGTERM', () => {
  forge.shutdown();
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

## Requirements

- Node.js ≥ 22.5 (uses the built-in `node:sqlite` module)
- Express.js v4 or v5

## License

MIT — [APIForge Organisation](https://github.com/APIForge-Organisation)
