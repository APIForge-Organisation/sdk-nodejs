'use strict';

// Suppress the built-in SQLite experimental warning before the first require —
// we intentionally depend on this API and the warning adds noise to user logs.
process.on('warning', function _sqLiteWarnFilter(w) {
  if (w.name === 'ExperimentalWarning' && w.message.startsWith('SQLite')) {
    process.off('warning', _sqLiteWarnFilter);
  }
});

// node:sqlite is built into Node.js 22.5+ — no native addon required
const { DatabaseSync } = require('node:sqlite');

class ApiForgeDatabase {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath);
    this._init();
  }

  _init() {
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS known_routes (
        route      TEXT NOT NULL,
        method     TEXT NOT NULL,
        first_seen INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (route, method)
      );

      CREATE TABLE IF NOT EXISTS api_metrics (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        bucket_ts   INTEGER NOT NULL,
        route       TEXT NOT NULL,
        method      TEXT NOT NULL,
        env         TEXT NOT NULL DEFAULT 'production',
        release_tag TEXT,
        status_2xx  INTEGER NOT NULL DEFAULT 0,
        status_4xx  INTEGER NOT NULL DEFAULT 0,
        status_5xx  INTEGER NOT NULL DEFAULT 0,
        total_calls INTEGER NOT NULL DEFAULT 0,
        lat_p50     REAL,
        lat_p90     REAL,
        lat_p99     REAL,
        lat_min     REAL,
        lat_max     REAL
      );
      CREATE INDEX IF NOT EXISTS idx_route_ts  ON api_metrics (route, method, bucket_ts);
      CREATE INDEX IF NOT EXISTS idx_bucket_ts ON api_metrics (bucket_ts);
      CREATE INDEX IF NOT EXISTS idx_release   ON api_metrics (release_tag) WHERE release_tag IS NOT NULL;
    `);

    this._stmtInsert = this.db.prepare(`
      INSERT INTO api_metrics
        (bucket_ts, route, method, env, release_tag,
         status_2xx, status_4xx, status_5xx, total_calls,
         lat_p50, lat_p90, lat_p99, lat_min, lat_max)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this._begin    = this.db.prepare('BEGIN');
    this._commit   = this.db.prepare('COMMIT');
    this._rollback = this.db.prepare('ROLLBACK');
  }

  insertBatch(rows) {
    this._begin.run();
    try {
      for (const r of rows) {
        this._stmtInsert.run(
          r.bucket_ts, r.route, r.method, r.env, r.release_tag ?? null,
          r.status_2xx, r.status_4xx, r.status_5xx, r.total_calls,
          r.lat_p50, r.lat_p90, r.lat_p99, r.lat_min, r.lat_max
        );
      }
      this._commit.run();
    } catch (err) {
      this._rollback.run();
      throw err;
    }
  }

  getSummary() {
    const since24h = nowSec() - 86_400;
    const since7d  = nowSec() - 604_800;

    const recent = this.db.prepare(`
      SELECT
        SUM(total_calls) as calls_total,
        SUM(status_2xx)  as calls_2xx,
        SUM(status_4xx)  as calls_4xx,
        SUM(status_5xx)  as calls_5xx,
        AVG(lat_p90)     as avg_p90,
        AVG(lat_p99)     as avg_p99
      FROM api_metrics WHERE bucket_ts >= ?
    `).get(since24h);

    const baseline = this.db.prepare(`
      SELECT AVG(lat_p90) as baseline_p90
      FROM api_metrics WHERE bucket_ts >= ? AND bucket_ts < ?
    `).get(since7d, since24h);

    const activeRoutes = this.db.prepare(`
      SELECT COUNT(DISTINCT route || '|' || method) as n
      FROM api_metrics WHERE bucket_ts >= ?
    `).get(since24h);

    const totalRoutes = this.db.prepare(`
      SELECT COUNT(DISTINCT route || '|' || method) as n
      FROM api_metrics
    `).get();

    return {
      recent,
      baseline,
      activeRoutes: activeRoutes?.n ?? 0,
      totalRoutes: totalRoutes?.n ?? 0,
    };
  }

  getRoutes(hours = 24) {
    const since = nowSec() - hours * 3600;
    return this.db.prepare(`
      SELECT
        route, method,
        SUM(total_calls) as calls,
        SUM(status_2xx)  as calls_2xx,
        SUM(status_4xx)  as calls_4xx,
        SUM(status_5xx)  as calls_5xx,
        AVG(lat_p50)     as p50,
        AVG(lat_p90)     as p90,
        AVG(lat_p99)     as p99,
        MAX(lat_max)     as lat_max
      FROM api_metrics
      WHERE bucket_ts >= ?
      GROUP BY route, method
      ORDER BY calls DESC
      LIMIT 50
    `).all(since);
  }

  getTimeSeries(route, method, hours = 24) {
    const since = nowSec() - hours * 3600;
    return this.db.prepare(`
      SELECT
        bucket_ts,
        SUM(total_calls) as calls,
        AVG(lat_p50) as p50,
        AVG(lat_p90) as p90,
        AVG(lat_p99) as p99,
        SUM(status_5xx) as errors
      FROM api_metrics
      WHERE route = ? AND method = ? AND bucket_ts >= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `).all(route, method, since);
  }

  getDeadCandidates(inactiveDays = 21) {
    const cutoff = nowSec() - inactiveDays * 86_400;
    return this.db.prepare(`
      SELECT route, method, MAX(bucket_ts) as last_seen
      FROM api_metrics
      GROUP BY route, method
      HAVING last_seen < ?
      ORDER BY last_seen ASC
    `).all(cutoff);
  }

  getReleaseComparison() {
    const latestRelease = this.db.prepare(`
      SELECT release_tag, MIN(bucket_ts) as release_ts
      FROM api_metrics
      WHERE release_tag IS NOT NULL AND release_tag != ''
      GROUP BY release_tag
      ORDER BY release_ts DESC
      LIMIT 1
    `).get();

    if (!latestRelease) return null;

    const { release_tag, release_ts } = latestRelease;
    const windowBefore = release_ts - 86_400;

    const before = this.db.prepare(`
      SELECT route, method, AVG(lat_p90) as avg_p90, SUM(total_calls) as calls
      FROM api_metrics
      WHERE bucket_ts >= ? AND bucket_ts < ?
      GROUP BY route, method
    `).all(windowBefore, release_ts);

    const after = this.db.prepare(`
      SELECT route, method, AVG(lat_p90) as avg_p90, SUM(total_calls) as calls
      FROM api_metrics
      WHERE bucket_ts >= ? AND release_tag = ?
      GROUP BY route, method
    `).all(release_ts, release_tag);

    return { release_tag, release_ts, before, after };
  }

  getLatencyAnomalyData() {
    const since1h = nowSec() - 3_600;
    const since7d  = nowSec() - 604_800;

    const recent = this.db.prepare(`
      SELECT route, method, AVG(lat_p99) as avg_p99
      FROM api_metrics
      WHERE bucket_ts >= ?
      GROUP BY route, method
    `).all(since1h);

    const baselineRows = this.db.prepare(`
      SELECT route, method, lat_p99
      FROM api_metrics
      WHERE bucket_ts >= ? AND bucket_ts < ? AND lat_p99 IS NOT NULL
    `).all(since7d, since1h);

    return { recent, baselineRows };
  }

  // Called once at startup with all routes discovered in the Express router
  upsertKnownRoutes(routes) {
    const stmt = this.db.prepare(`
      INSERT INTO known_routes (route, method) VALUES (?, ?)
      ON CONFLICT (route, method) DO NOTHING
    `);
    this._begin.run();
    try {
      for (const r of routes) stmt.run(r.route, r.method);
      this._commit.run();
    } catch (err) {
      this._rollback.run();
      throw err;
    }
  }

  // Routes declared in Express but with zero traffic ever recorded
  getUntrackedRoutes() {
    return this.db.prepare(`
      SELECT k.route, k.method, k.first_seen
      FROM known_routes k
      WHERE NOT EXISTS (
        SELECT 1 FROM api_metrics m
        WHERE m.route = k.route AND m.method = k.method
      )
      ORDER BY k.method, k.route
    `).all();
  }

  // All known routes with their traffic status (for dashboard routes table)
  getKnownRoutes() {
    return this.db.prepare(`
      SELECT route, method FROM known_routes ORDER BY method, route
    `).all();
  }

  getReleases() {
    return this.db.prepare(`
      SELECT release_tag,
             MIN(bucket_ts) as release_ts,
             COUNT(DISTINCT route || '|' || method) as routes_affected
      FROM api_metrics
      WHERE release_tag IS NOT NULL AND release_tag != ''
      GROUP BY release_tag
      ORDER BY release_ts DESC
      LIMIT 20
    `).all();
  }

  getGlobalTimeSeries(hours = 24) {
    const since = nowSec() - hours * 3600;
    return this.db.prepare(`
      SELECT
        bucket_ts,
        SUM(total_calls) as calls,
        AVG(lat_p50) as p50,
        AVG(lat_p90) as p90,
        AVG(lat_p99) as p99,
        SUM(status_5xx) as errors
      FROM api_metrics
      WHERE bucket_ts >= ?
      GROUP BY bucket_ts
      ORDER BY bucket_ts ASC
    `).all(since);
  }

  close() {
    this.db.close();
  }
}

function nowSec() {
  return Math.floor(Date.now() / 1000);
}

module.exports = { ApiForgeDatabase };
