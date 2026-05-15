'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { getInsights, computeHealthScore } = require('./insights');

const UI_HTML = path.join(__dirname, 'ui.html');

// Resolve React / ReactDOM UMD bundles from node_modules.
// These are added as direct dependencies of apiforgejs so they are always present.
function resolveAsset(pkg, file) {
  try {
    const main = require.resolve(pkg);
    const pkgDir = path.dirname(main);
    const candidate = path.join(pkgDir, 'umd', file);
    if (fs.existsSync(candidate)) return candidate;
    const alt = path.join(pkgDir, file);
    if (fs.existsSync(alt)) return alt;
  } catch (_) {}
  return null;
}

const REACT_PATH     = resolveAsset('react', 'react.production.min.js');
const REACT_DOM_PATH = resolveAsset('react-dom', 'react-dom.production.min.js');

function startDashboard(db, port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${port}`);
    try {
      route(req, res, url, db);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });

  server.listen(port, '127.0.0.1', () => {
    console.log(`[apiforgejs] Dashboard → http://localhost:${port}`);
  });

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.warn(`[apiforgejs] Port ${port} already in use — dashboard not started.`);
    }
  });

  return server;
}

function route(req, res, url, db) {
  const pathname = url.pathname;

  // ── HTML shell ────────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/') {
    serveFile(res, UI_HTML, 'text/html; charset=utf-8');
    return;
  }

  // ── Static assets (React UMD) ─────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/assets/react.js') {
    if (REACT_PATH) {
      serveFile(res, REACT_PATH, 'application/javascript');
    } else {
      res.writeHead(404);
      res.end('// react not found — run npm install inside apiforgejs');
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/assets/react-dom.js') {
    if (REACT_DOM_PATH) {
      serveFile(res, REACT_DOM_PATH, 'application/javascript');
    } else {
      res.writeHead(404);
      res.end('// react-dom not found — run npm install inside apiforgejs');
    }
    return;
  }

  // ── API: summary ──────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/summary') {
    const data = db.getSummary();
    const healthScore = computeHealthScore(db);
    const insights = getInsights(db);

    const total  = data.recent?.calls_total || 0;
    const errors = (data.recent?.calls_4xx || 0) + (data.recent?.calls_5xx || 0);
    const errorRate = total > 0 ? (errors / total) * 100 : 0;

    sendJson(res, {
      health_score:    healthScore,
      calls_24h:       total,
      error_rate_24h:  parseFloat(errorRate.toFixed(2)),
      avg_p90_24h:     round(data.recent?.avg_p90),
      avg_p99_24h:     round(data.recent?.avg_p99),
      active_routes:   data.activeRoutes,
      total_routes:    data.totalRoutes,
      insights_count:  insights.length,
      insights,
    });
    return;
  }

  // ── API: routes ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/routes') {
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    const routes = db.getRoutes(hours);

    const untracked = db.getUntrackedRoutes().map(r => ({
      route:      r.route,
      method:     r.method,
      calls:      0,
      calls_2xx:  0,
      calls_4xx:  0,
      calls_5xx:  0,
      p50:        null,
      p90:        null,
      p99:        null,
      lat_max:    null,
      untracked:  true,
    }));

    sendJson(res, [...routes, ...untracked]);
    return;
  }

  // ── API: timeseries (per route) ───────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/timeseries') {
    const r     = url.searchParams.get('route');
    const m     = url.searchParams.get('method');
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);

    if (!r || !m) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'route and method are required' }));
      return;
    }

    sendJson(res, db.getTimeSeries(r, m, hours));
    return;
  }

  // ── API: global timeseries (all routes aggregated) ────────────────────────
  if (req.method === 'GET' && pathname === '/api/global-timeseries') {
    const hours = parseInt(url.searchParams.get('hours') || '24', 10);
    sendJson(res, db.getGlobalTimeSeries(hours));
    return;
  }

  // ── API: releases ─────────────────────────────────────────────────────────
  if (req.method === 'GET' && pathname === '/api/releases') {
    sendJson(res, db.getReleases());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('File not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

function sendJson(res, data) {
  const body = JSON.stringify(data);
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(body);
}

function round(v) {
  return v != null ? parseFloat(v.toFixed(2)) : null;
}

module.exports = { startDashboard };
