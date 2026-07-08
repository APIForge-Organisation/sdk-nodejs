'use strict';

// Fixed 60s send cadence — not configurable through the public API. The SDK only
// protects against misconfiguration; real ingest throttling is enforced server-side
// (per-key rate limit + monthly quota). See index.js and CloudTransport.
const FLUSH_INTERVAL_MS = 60_000;

class Aggregator {
  constructor(transport, flushIntervalMs = FLUSH_INTERVAL_MS) {
    this.transport = transport;
    this.flushIntervalMs = flushIntervalMs;
    this.buffer = new Map();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this._flush(), this.flushIntervalMs);
    // Don't prevent the process from exiting if nothing else is running
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this._flush();
  }

  record(event) {
    const key = `${event.method}|${event.route}|${event.env}|${event.release || ''}|${event.is_ghost ? '1' : '0'}`;
    let bucket = this.buffer.get(key);

    if (!bucket) {
      bucket = {
        method: event.method,
        route: event.route,
        env: event.env,
        release: event.release,
        is_ghost: event.is_ghost,
        durations: [],
        ttfb_durations: [],
        response_sizes: [],
        request_sizes: [],
        inflight_samples: [],
        status_2xx: 0,
        status_3xx: 0,
        status_4xx: 0,
        status_5xx: 0,
        status_map: new Map(),
      };
      this.buffer.set(key, bucket);
    }

    bucket.durations.push(event.duration_ms);
    if (event.ttfb_ms != null)      bucket.ttfb_durations.push(event.ttfb_ms);
    if (event.response_size != null) bucket.response_sizes.push(event.response_size);
    if (event.request_size != null)  bucket.request_sizes.push(event.request_size);
    if (event.inflight != null)      bucket.inflight_samples.push(event.inflight);

    const s = event.status;
    if      (s >= 200 && s < 300) bucket.status_2xx++;
    else if (s >= 300 && s < 400) bucket.status_3xx++;
    else if (s >= 400 && s < 500) bucket.status_4xx++;
    else if (s >= 500)            bucket.status_5xx++;

    bucket.status_map.set(s, (bucket.status_map.get(s) ?? 0) + 1);
  }

  _flush() {
    if (this.buffer.size === 0) return;

    // Round down to the current minute as the bucket timestamp
    const bucketTs = Math.floor(Date.now() / 60_000) * 60;
    const rows = [];

    for (const bucket of this.buffer.values()) {
      const sorted     = bucket.durations.slice().sort((a, b) => a - b);
      const sortedTtfb = bucket.ttfb_durations.slice().sort((a, b) => a - b);
      const n = sorted.length;

      const sizes = bucket.response_sizes;
      const bytes_avg = sizes.length > 0
        ? sizes.reduce((a, b) => a + b, 0) / sizes.length
        : null;

      const reqSizes = bucket.request_sizes;
      const request_size_avg = reqSizes.length > 0
        ? reqSizes.reduce((a, b) => a + b, 0) / reqSizes.length
        : null;

      const lat_avg = n > 0
        ? bucket.durations.reduce((a, b) => a + b, 0) / n
        : null;

      const inflight = bucket.inflight_samples;
      const inflight_avg = inflight.length > 0
        ? inflight.reduce((a, b) => a + b, 0) / inflight.length
        : null;
      const inflight_max = inflight.length > 0
        ? Math.max(...inflight)
        : null;

      // Granular distribution — sorted by count desc, all observed codes
      const status_dist = bucket.status_map.size > 0
        ? JSON.stringify(
            Object.fromEntries(
              [...bucket.status_map.entries()].sort((a, b) => b[1] - a[1])
            )
          )
        : null;

      rows.push({
        bucket_ts: bucketTs,
        route: bucket.route,
        method: bucket.method,
        env: bucket.env,
        release_tag: bucket.release,
        is_ghost: bucket.is_ghost ? 1 : 0,
        status_2xx: bucket.status_2xx,
        status_3xx: bucket.status_3xx,
        status_4xx: bucket.status_4xx,
        status_5xx: bucket.status_5xx,
        status_dist,
        total_calls: n,
        lat_p50: percentile(sorted, 0.50),
        lat_p90: percentile(sorted, 0.90),
        lat_p99: percentile(sorted, 0.99),
        lat_avg,
        lat_min: sorted[0] ?? 0,
        lat_max: sorted[n - 1] ?? 0,
        lat_ttfb_p50: sortedTtfb.length > 0 ? percentile(sortedTtfb, 0.50) : null,
        lat_ttfb_p90: sortedTtfb.length > 0 ? percentile(sortedTtfb, 0.90) : null,
        lat_ttfb_p99: sortedTtfb.length > 0 ? percentile(sortedTtfb, 0.99) : null,
        bytes_avg,
        request_size_avg,
        inflight_avg,
        inflight_max,
      });
    }

    this.buffer.clear();
    this.transport.write(rows);
  }
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(Math.ceil(p * sorted.length) - 1, sorted.length - 1);
  return sorted[Math.max(0, idx)];
}

module.exports = { Aggregator, FLUSH_INTERVAL_MS };
