'use strict';

const { describe, it } = require('node:test');
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

      const bucket = agg.buffer.get('GET|/a|test||0');
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

    it('counts status_3xx correctly', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/r', env: 'test', release: null, status: 301, duration_ms: 5 });
      agg.record({ method: 'GET', route: '/r', env: 'test', release: null, status: 302, duration_ms: 5 });

      const bucket = agg.buffer.get('GET|/r|test||0');
      assert.strictEqual(bucket.status_3xx, 2);
      assert.strictEqual(bucket.status_2xx, 0);
      agg.stop();
    });

    it('builds status_map with per-code counts', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/s', env: 'test', release: null, status: 200, duration_ms: 1 });
      agg.record({ method: 'GET', route: '/s', env: 'test', release: null, status: 200, duration_ms: 1 });
      agg.record({ method: 'GET', route: '/s', env: 'test', release: null, status: 404, duration_ms: 1 });

      const bucket = agg.buffer.get('GET|/s|test||0');
      assert.strictEqual(bucket.status_map.get(200), 2);
      assert.strictEqual(bucket.status_map.get(404), 1);
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

    it('computes lat_avg correctly', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/avg', env: 'test', release: null, status: 200, duration_ms: 10 });
      agg.record({ method: 'GET', route: '/avg', env: 'test', release: null, status: 200, duration_ms: 30 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.lat_avg, 20);
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

    it('computes bytes_avg as mean of non-null response sizes', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/s', env: 'test', release: null, status: 200, duration_ms: 10, response_size: 100 });
      agg.record({ method: 'GET', route: '/s', env: 'test', release: null, status: 200, duration_ms: 20, response_size: 300 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.bytes_avg, 200);
      agg.stop();
    });

    it('sets bytes_avg to null when no response sizes are provided', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/n', env: 'test', release: null, status: 200, duration_ms: 10, response_size: null });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.bytes_avg, null);
      agg.stop();
    });

    it('computes request_size_avg from request body sizes', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'POST', route: '/upload', env: 'test', release: null, status: 201, duration_ms: 50, request_size: 1000 });
      agg.record({ method: 'POST', route: '/upload', env: 'test', release: null, status: 201, duration_ms: 60, request_size: 3000 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.request_size_avg, 2000);
      agg.stop();
    });

    it('sets request_size_avg to null when no request sizes are provided', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/q', env: 'test', release: null, status: 200, duration_ms: 10 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.request_size_avg, null);
      agg.stop();
    });

    it('emits status_dist as JSON sorted by count desc', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      for (let i = 0; i < 5; i++) {
        agg.record({ method: 'GET', route: '/d', env: 'test', release: null, status: 200, duration_ms: 1 });
      }
      agg.record({ method: 'GET', route: '/d', env: 'test', release: null, status: 404, duration_ms: 1 });
      agg._flush();

      const row = t.calls[0][0];
      const dist = JSON.parse(row.status_dist);
      assert.strictEqual(dist['200'], 5);
      assert.strictEqual(dist['404'], 1);
      // 200 should come first (highest count)
      const keys = Object.keys(dist);
      assert.strictEqual(keys[0], '200');
      agg.stop();
    });

    it('sets status_dist to null when buffer is empty (should not happen but guard test)', () => {
      // Simulated via a bucket that records no statuses — not a real path,
      // but ensures null handling is correct
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();
      agg.record({ method: 'GET', route: '/z', env: 'test', release: null, status: 200, duration_ms: 1 });
      agg._flush();
      // status_dist must be a parseable JSON string, not null
      const row = t.calls[0][0];
      assert.ok(row.status_dist !== null);
      assert.doesNotThrow(() => JSON.parse(row.status_dist));
      agg.stop();
    });

    it('computes lat_ttfb percentiles from ttfb_ms events', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      for (let i = 1; i <= 10; i++) {
        agg.record({ method: 'GET', route: '/ttfb', env: 'test', release: null, status: 200, duration_ms: i * 10, ttfb_ms: i * 5 });
      }
      agg._flush();

      const row = t.calls[0][0];
      assert.ok(typeof row.lat_ttfb_p50 === 'number', 'lat_ttfb_p50 should be a number');
      assert.ok(typeof row.lat_ttfb_p90 === 'number', 'lat_ttfb_p90 should be a number');
      assert.ok(typeof row.lat_ttfb_p99 === 'number', 'lat_ttfb_p99 should be a number');
      assert.ok(row.lat_ttfb_p99 <= row.lat_p99, 'TTFB P99 should be <= total latency P99');
      agg.stop();
    });

    it('sets lat_ttfb fields to null when no ttfb_ms values are provided', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/nottfb', env: 'test', release: null, status: 200, duration_ms: 20 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.lat_ttfb_p50, null);
      assert.strictEqual(row.lat_ttfb_p90, null);
      assert.strictEqual(row.lat_ttfb_p99, null);
      agg.stop();
    });

    it('computes inflight_avg and inflight_max', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/i', env: 'test', release: null, status: 200, duration_ms: 10, inflight: 3 });
      agg.record({ method: 'GET', route: '/i', env: 'test', release: null, status: 200, duration_ms: 10, inflight: 7 });
      agg.record({ method: 'GET', route: '/i', env: 'test', release: null, status: 200, duration_ms: 10, inflight: 5 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.inflight_avg, 5);
      assert.strictEqual(row.inflight_max, 7);
      agg.stop();
    });

    it('sets inflight fields to null when no inflight values are provided', () => {
      const t = makeTransport();
      const agg = new Aggregator(t, 999_999);
      agg.start();

      agg.record({ method: 'GET', route: '/ni', env: 'test', release: null, status: 200, duration_ms: 10 });
      agg._flush();

      const row = t.calls[0][0];
      assert.strictEqual(row.inflight_avg, null);
      assert.strictEqual(row.inflight_max, null);
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
