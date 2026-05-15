'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { ApiForgeDatabase } = require('../src/database.js');

function makeDb() {
  return new ApiForgeDatabase(':memory:');
}

// Insert one minimal row at a given timestamp
function insertRow(db, overrides = {}) {
  const defaults = {
    bucket_ts: Math.floor(Date.now() / 1000),
    route: '/test',
    method: 'GET',
    env: 'test',
    release_tag: null,
    status_2xx: 1,
    status_4xx: 0,
    status_5xx: 0,
    total_calls: 1,
    lat_p50: 50,
    lat_p90: 90,
    lat_p99: 99,
    lat_min: 10,
    lat_max: 150,
  };
  db.insertBatch([{ ...defaults, ...overrides }]);
}

describe('ApiForgeDatabase', () => {
  describe('insertBatch()', () => {
    it('stores rows that are returned by getRoutes()', () => {
      const db = makeDb();
      insertRow(db, { route: '/users', method: 'GET' });
      const routes = db.getRoutes(24);
      assert.strictEqual(routes.length, 1);
      assert.strictEqual(routes[0].route, '/users');
      db.close();
    });

    it('accumulates calls from multiple rows for the same route', () => {
      const db = makeDb();
      insertRow(db, { route: '/items', total_calls: 3 });
      insertRow(db, { route: '/items', total_calls: 7 });
      const routes = db.getRoutes(24);
      assert.strictEqual(routes[0].calls, 10);
      db.close();
    });
  });

  describe('getSummary()', () => {
    it('returns zeroes / empty when no data exists', () => {
      const db = makeDb();
      const { recent, baseline, activeRoutes, totalRoutes } = db.getSummary();
      assert.strictEqual(activeRoutes, 0);
      assert.strictEqual(totalRoutes, 0);
      db.close();
    });

    it('counts active and total routes correctly', () => {
      const db = makeDb();
      const nowTs = Math.floor(Date.now() / 1000);
      insertRow(db, { route: '/a', bucket_ts: nowTs });
      insertRow(db, { route: '/b', bucket_ts: nowTs });
      const { activeRoutes, totalRoutes } = db.getSummary();
      assert.strictEqual(activeRoutes, 2);
      assert.strictEqual(totalRoutes, 2);
      db.close();
    });

    it('sums 5xx errors in recent window', () => {
      const db = makeDb();
      const nowTs = Math.floor(Date.now() / 1000);
      insertRow(db, { status_2xx: 0, status_5xx: 3, total_calls: 3, bucket_ts: nowTs });
      const { recent } = db.getSummary();
      assert.strictEqual(recent.calls_5xx, 3);
      db.close();
    });
  });

  describe('getTimeSeries()', () => {
    it('returns bucketed data for a specific route and method', () => {
      const db = makeDb();
      const ts = Math.floor(Date.now() / 1000) - 60;
      insertRow(db, { route: '/ts', method: 'POST', bucket_ts: ts });
      const rows = db.getTimeSeries('/ts', 'POST', 24);
      assert.strictEqual(rows.length, 1);
      assert.ok('p90' in rows[0]);
      db.close();
    });

    it('returns empty when route does not match', () => {
      const db = makeDb();
      insertRow(db, { route: '/other' });
      const rows = db.getTimeSeries('/missing', 'GET', 24);
      assert.strictEqual(rows.length, 0);
      db.close();
    });
  });

  describe('getDeadCandidates()', () => {
    it('returns routes whose last_seen is older than the threshold', () => {
      const db = makeDb();
      const oldTs = Math.floor(Date.now() / 1000) - 25 * 86_400;
      insertRow(db, { route: '/dead', bucket_ts: oldTs });
      const dead = db.getDeadCandidates(21);
      assert.strictEqual(dead.length, 1);
      assert.strictEqual(dead[0].route, '/dead');
      db.close();
    });

    it('does not flag a route active within the threshold', () => {
      const db = makeDb();
      insertRow(db, { route: '/alive', bucket_ts: Math.floor(Date.now() / 1000) - 5 * 86_400 });
      const dead = db.getDeadCandidates(21);
      assert.strictEqual(dead.length, 0);
      db.close();
    });
  });

  describe('getReleaseComparison()', () => {
    it('returns null when no releases are tagged', () => {
      const db = makeDb();
      const result = db.getReleaseComparison();
      assert.strictEqual(result, null);
      db.close();
    });

    it('returns before/after data when a release tag is present', () => {
      const db = makeDb();
      const releaseTs = Math.floor(Date.now() / 1000) - 3600;
      insertRow(db, { release_tag: 'v1.0', bucket_ts: releaseTs });
      const result = db.getReleaseComparison();
      assert.ok(result !== null);
      assert.strictEqual(result.release_tag, 'v1.0');
      assert.ok(Array.isArray(result.before));
      assert.ok(Array.isArray(result.after));
      db.close();
    });
  });

  describe('upsertKnownRoutes() / getUntrackedRoutes()', () => {
    it('returns routes with no traffic as untracked', () => {
      const db = makeDb();
      db.upsertKnownRoutes([{ route: '/declared', method: 'DELETE' }]);
      const untracked = db.getUntrackedRoutes();
      assert.strictEqual(untracked.length, 1);
      assert.strictEqual(untracked[0].route, '/declared');
      db.close();
    });

    it('does not return a route that has traffic', () => {
      const db = makeDb();
      db.upsertKnownRoutes([{ route: '/active', method: 'GET' }]);
      insertRow(db, { route: '/active', method: 'GET' });
      const untracked = db.getUntrackedRoutes();
      assert.strictEqual(untracked.length, 0);
      db.close();
    });
  });

  describe('getLatencyAnomalyData()', () => {
    it('returns recent and baselineRows properties', () => {
      const db = makeDb();
      const data = db.getLatencyAnomalyData();
      assert.ok('recent' in data);
      assert.ok('baselineRows' in data);
      db.close();
    });
  });

  describe('getDriftData()', () => {
    it('returns rows grouped by day when data exists in last 30 days', () => {
      const db = makeDb();
      const ts = Math.floor(Date.now() / 1000) - 10 * 86_400;
      insertRow(db, { route: '/drift', bucket_ts: ts, lat_p90: 120 });
      const rows = db.getDriftData();
      assert.ok(rows.length >= 1);
      assert.ok('day_bucket' in rows[0]);
      assert.ok('p90' in rows[0]);
      db.close();
    });

    it('returns empty array when no data exists', () => {
      const db = makeDb();
      assert.deepStrictEqual(db.getDriftData(), []);
      db.close();
    });
  });

  describe('getGlobalTimeSeries()', () => {
    it('returns time-bucketed global data', () => {
      const db = makeDb();
      insertRow(db, { bucket_ts: Math.floor(Date.now() / 1000) - 60 });
      const rows = db.getGlobalTimeSeries(24);
      assert.ok(rows.length >= 1);
      db.close();
    });
  });
});
