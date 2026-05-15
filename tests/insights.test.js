'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { getInsights, computeHealthScore } = require('../src/insights.js');

// Build a minimal database stub with only the methods used by insights
function makeDb(overrides = {}) {
  return {
    getLatencyAnomalyData: () => ({ recent: [], baselineRows: [] }),
    getDeadCandidates:     () => [],
    getReleaseComparison:  () => null,
    getUntrackedRoutes:    () => [],
    getDriftData:          () => [],
    getSummary:            () => ({
      recent:       { calls_total: 0 },
      baseline:     {},
      activeRoutes: 0,
      totalRoutes:  0,
    }),
    ...overrides,
  };
}

describe('getInsights()', () => {
  it('returns an empty array when no data exists', () => {
    const insights = getInsights(makeDb());
    assert.deepStrictEqual(insights, []);
  });

  it('emits ANOMALY when Z-score exceeds threshold', () => {
    const baseline = Array.from({ length: 10 }, () => 100); // mean=100, stdev=0... need variance
    // 10 values that give mean 100, stdev ~15
    const baselineRows = [50, 60, 70, 80, 90, 100, 110, 120, 130, 140].map(v => ({
      method: 'GET', route: '/slow', lat_p99: v,
    }));
    const db = makeDb({
      getLatencyAnomalyData: () => ({
        recent:      [{ method: 'GET', route: '/slow', avg_p99: 500 }],
        baselineRows,
      }),
    });
    const insights = getInsights(db);
    const anomaly = insights.find(i => i.type === 'ANOMALY');
    assert.ok(anomaly, 'expected an ANOMALY insight');
    assert.strictEqual(anomaly.route, '/slow');
    assert.ok(anomaly.message.includes('P99 latency is abnormally high'));
  });

  it('does not emit ANOMALY when baseline has fewer than 5 samples', () => {
    const db = makeDb({
      getLatencyAnomalyData: () => ({
        recent:      [{ method: 'GET', route: '/few', avg_p99: 999 }],
        baselineRows: [{ method: 'GET', route: '/few', lat_p99: 50 }],
      }),
    });
    const insights = getInsights(db);
    assert.ok(!insights.find(i => i.type === 'ANOMALY'));
  });

  it('emits DEAD when endpoint has been inactive', () => {
    const oldTs = Math.floor(Date.now() / 1000) - 30 * 86_400;
    const db = makeDb({
      getDeadCandidates: () => [{ route: '/old', method: 'DELETE', last_seen: oldTs }],
    });
    const insights = getInsights(db);
    const dead = insights.find(i => i.type === 'DEAD');
    assert.ok(dead, 'expected a DEAD insight');
    assert.ok(dead.message.includes('no requests'));
  });

  it('emits PERF when P90 regresses after a release', () => {
    const db = makeDb({
      getReleaseComparison: () => ({
        release_tag: 'v2.0',
        before: [{ method: 'GET', route: '/pay', avg_p90: 100, calls: 10 }],
        after:  [{ method: 'GET', route: '/pay', avg_p90: 200, calls: 10 }],
      }),
    });
    const insights = getInsights(db);
    const perf = insights.find(i => i.type === 'PERF');
    assert.ok(perf, 'expected a PERF insight');
    assert.ok(perf.message.includes('v2.0'));
    assert.ok(perf.message.includes('Before:'));
  });

  it('emits OK when P90 improves after a release', () => {
    const db = makeDb({
      getReleaseComparison: () => ({
        release_tag: 'v3.0',
        before: [{ method: 'GET', route: '/fast', avg_p90: 200, calls: 10 }],
        after:  [{ method: 'GET', route: '/fast', avg_p90: 80, calls: 10 }],
      }),
    });
    const insights = getInsights(db);
    const ok = insights.find(i => i.type === 'OK');
    assert.ok(ok, 'expected an OK insight');
    assert.ok(ok.message.includes('improved'));
  });

  it('emits UNTRACKED for declared routes with no traffic', () => {
    const now = Math.floor(Date.now() / 1000);
    const db = makeDb({
      getUntrackedRoutes: () => [{ route: '/ghost', method: 'GET', first_seen: now }],
    });
    const insights = getInsights(db);
    const untracked = insights.find(i => i.type === 'UNTRACKED');
    assert.ok(untracked, 'expected an UNTRACKED insight');
    assert.ok(untracked.message.includes('no requests since monitoring started'));
  });

  it('emits DRIFT when slope exceeds 5ms/day over 7+ days', () => {
    const today = Math.floor(Date.now() / 1000 / 86_400);
    // 10 days of data with a steep upward trend: p90 = 100 + day * 20
    const driftRows = Array.from({ length: 10 }, (_, i) => ({
      route: '/slow', method: 'GET',
      day_bucket: today - 9 + i,
      p90: 100 + i * 20,
    }));
    const db = makeDb({ getDriftData: () => driftRows });
    const insights = getInsights(db);
    const drift = insights.find(i => i.type === 'DRIFT');
    assert.ok(drift, 'expected a DRIFT insight');
    assert.ok(drift.message.includes('ms/day'));
    assert.ok(drift.message.includes('30-day projection'));
  });

  it('does not emit DRIFT when fewer than 7 daily data points exist', () => {
    const today = Math.floor(Date.now() / 1000 / 86_400);
    const rows = Array.from({ length: 5 }, (_, i) => ({
      route: '/r', method: 'GET', day_bucket: today - 4 + i, p90: 100 + i * 30,
    }));
    const db = makeDb({ getDriftData: () => rows });
    const insights = getInsights(db);
    assert.ok(!insights.find(i => i.type === 'DRIFT'));
  });

  it('does not emit DRIFT when slope is below threshold', () => {
    const today = Math.floor(Date.now() / 1000 / 86_400);
    // Flat trend
    const rows = Array.from({ length: 10 }, (_, i) => ({
      route: '/flat', method: 'GET', day_bucket: today - 9 + i, p90: 100,
    }));
    const db = makeDb({ getDriftData: () => rows });
    const insights = getInsights(db);
    assert.ok(!insights.find(i => i.type === 'DRIFT'));
  });

  it('never throws even when all db methods throw', () => {
    const db = {
      getLatencyAnomalyData: () => { throw new Error('boom'); },
      getDeadCandidates:     () => { throw new Error('boom'); },
      getReleaseComparison:  () => { throw new Error('boom'); },
      getUntrackedRoutes:    () => { throw new Error('boom'); },
      getDriftData:          () => { throw new Error('boom'); },
    };
    assert.doesNotThrow(() => getInsights(db));
    assert.deepStrictEqual(getInsights(db), []);
  });
});

describe('computeHealthScore()', () => {
  it('returns null when there is no traffic', () => {
    const db = makeDb();
    assert.strictEqual(computeHealthScore(db), null);
  });

  it('returns a number between 0 and 100 with normal data', () => {
    const db = makeDb({
      getSummary: () => ({
        recent: { calls_total: 100, calls_2xx: 95, calls_4xx: 3, calls_5xx: 2, avg_p90: 80, avg_p99: 150 },
        baseline: { baseline_p90: 70 },
        activeRoutes: 4,
        totalRoutes: 5,
      }),
    });
    const score = computeHealthScore(db);
    assert.ok(typeof score === 'number', 'score should be a number');
    assert.ok(score >= 0 && score <= 100, `score ${score} out of range`);
  });

  it('returns a high score when availability is 100% and latency is good', () => {
    const db = makeDb({
      getSummary: () => ({
        recent: { calls_total: 200, calls_2xx: 200, calls_4xx: 0, calls_5xx: 0, avg_p90: 50, avg_p99: 80 },
        baseline: { baseline_p90: 60 },
        activeRoutes: 5,
        totalRoutes: 5,
      }),
    });
    const score = computeHealthScore(db);
    assert.ok(score >= 80, `expected high score, got ${score}`);
  });

  it('returns null when getSummary throws', () => {
    const db = { getSummary: () => { throw new Error('db error'); } };
    assert.strictEqual(computeHealthScore(db), null);
  });
});
