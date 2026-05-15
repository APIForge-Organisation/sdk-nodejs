'use strict';

class Aggregator {
  constructor(transport, flushIntervalMs = 60_000) {
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
    const key = `${event.method}|${event.route}|${event.env}|${event.release || ''}`;
    let bucket = this.buffer.get(key);

    if (!bucket) {
      bucket = {
        method: event.method,
        route: event.route,
        env: event.env,
        release: event.release,
        durations: [],
        response_sizes: [],
        status_2xx: 0,
        status_4xx: 0,
        status_5xx: 0,
      };
      this.buffer.set(key, bucket);
    }

    bucket.durations.push(event.duration_ms);
    if (event.response_size != null) bucket.response_sizes.push(event.response_size);

    const s = event.status;
    if (s >= 200 && s < 300) bucket.status_2xx++;
    else if (s >= 400 && s < 500) bucket.status_4xx++;
    else if (s >= 500) bucket.status_5xx++;
  }

  _flush() {
    if (this.buffer.size === 0) return;

    // Round down to the current minute as the bucket timestamp
    const bucketTs = Math.floor(Date.now() / 60_000) * 60;
    const rows = [];

    for (const bucket of this.buffer.values()) {
      const sorted = bucket.durations.slice().sort((a, b) => a - b);
      const n = sorted.length;
      const sizes = bucket.response_sizes;
      const bytes_avg = sizes.length > 0
        ? sizes.reduce((a, b) => a + b, 0) / sizes.length
        : null;

      rows.push({
        bucket_ts: bucketTs,
        route: bucket.route,
        method: bucket.method,
        env: bucket.env,
        release_tag: bucket.release,
        status_2xx: bucket.status_2xx,
        status_4xx: bucket.status_4xx,
        status_5xx: bucket.status_5xx,
        total_calls: n,
        lat_p50: percentile(sorted, 0.50),
        lat_p90: percentile(sorted, 0.90),
        lat_p99: percentile(sorted, 0.99),
        lat_min: sorted[0] ?? 0,
        lat_max: sorted[n - 1] ?? 0,
        bytes_avg,
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

module.exports = { Aggregator };
