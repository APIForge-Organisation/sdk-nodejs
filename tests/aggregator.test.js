'use strict';

const { describe, it, before, after, mock } = require('node:test');
const assert = require('node:assert/strict');
const { Aggregator } = require('../src/aggregator.js');

// Minimal transport spy
function makeTransport() {
  const calls = [];
  return { write: (rows) => calls.push(rows), calls };
}

describe('Aggregator', () => {
  describe('record()', () => {
    it('accumulates durations and status counters per key', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/a', env: 'test', release: null, status: 200, duration_ms: 10 });
      agg.record({ method: 'GET', route: '/a', env: 'test', release: null, status: 200, duration_ms: 20 });
      agg.record({ method: 'GET', route: '/a', env: 'test', release: null, status: 500, duration_ms: 30 });

      const bucket = agg.buffer.get('GET|/a|test|');
      assert.strictEqual(bucket.durations.length, 3);
      assert.strictEqual(bucket.status_2xx, 2);
      assert.strictEqual(bucket.status_5xx, 1);
      assert.strictEqual(bucket.status_4xx, 0);
      agg.stop();
    });

    it('creates separate buckets for different routes', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/a', env: 'test', release: null, status: 200, duration_ms: 5 });
      agg.record({ method: 'POST', route: '/b', env: 'test', release: null, status: 201, duration_ms: 15 });

      assert.strictEqual(agg.buffer.size, 2);
      agg.stop();
    });

    it('uses release as part of the bucket key', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/x', env: 'prod', release: 'v1', status: 200, duration_ms: 1 });
      agg.record({ method: 'GET', route: '/x', env: 'prod', release: 'v2', status: 200, duration_ms: 1 });

      assert.strictEqual(agg.buffer.size, 2);
      agg.stop();
    });
  });

  describe('_flush()', () => {
    it('sends rows to transport and clears the buffer', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/r', env: 'test', release: null, status: 200, duration_ms: 100 });
      agg._flush();

      assert.strictEqual(t.calls.length, 1);
      assert.strictEqual(t.calls[0].length, 1);
      assert.strictEqual(agg.buffer.size, 0);
      agg.stop();
    });

    it('is a no-op when the buffer is empty', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();
      agg._flush();
      assert.strictEqual(t.calls.length, 0);
      agg.stop();
    });

    it('computes correct P50/P90/P99 for a sorted sample', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      // 10 values: 10, 20, 30, ..., 100
      for (let i = 1; i <= 10; i++) {
        agg.record({ method: 'GET', route: '/p', env: 'test', release: null, status: 200, duration_ms: i * 10 });
      }
      agg._flush();

      const row = t.calls[0][0];
      assert.ok(row.lat_p50 >= 50 && row.lat_p50 <= 60, `P50 should be ~50-60, got ${row.lat_p50}`);
      assert.ok(row.lat_p90 >= 90 && row.lat_p90 <= 100, `P90 should be ~90-100, got ${row.lat_p90}`);
      assert.ok(row.lat_p99 >= 90, `P99 should be >= 90, got ${row.lat_p99}`);
      agg.stop();
    });

    it('records correct lat_min and lat_max', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/m', env: 'test', release: null, status: 200, duration_ms: 5 });
      agg.record({ method: 'GET', route: '/m', env: 'test', release: null, status: 200, duration_ms: 95 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.lat_min, 5);
      assert.strictEqual(row.lat_max, 95);
      agg.stop();
    });

    it('increments 4xx counter correctly', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/e', env: 'test', release: null, status: 404, duration_ms: 2 });
      agg.record({ method: 'GET', route: '/e', env: 'test', release: null, status: 429, duration_ms: 3 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.status_4xx, 2);
      assert.strictEqual(row.status_2xx, 0);
      agg.stop();
    });
  });

  describe('stop()', () => {
    it('flushes the buffer before stopping', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();
      agg.record({ method: 'GET', route: '/stop', env: 'test', release: null, status: 200, duration_ms: 1 });
      agg.stop();
      assert.strictEqual(t.calls.length, 1, 'stop() should flush remaining events');
    });
  });
});
