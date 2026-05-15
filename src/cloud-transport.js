'use strict';

const CIRCUIT_OPEN_MS  = 60_000;
const FAILURE_THRESHOLD = 5;

class CloudTransport {
  /**
   * @param {string} cloudUrl  - Base URL of the SaaS API, e.g. 'https://api.apiforge.fr'
   * @param {string} apiKey    - Project API key starting with 'af_'
   * @param {string} service   - Service name passed to every metric row
   */
  constructor(cloudUrl, apiKey, service) {
    this._url     = `${cloudUrl.replace(/\/$/, '')}/ingest`;
    this._apiKey  = apiKey;
    this._service = service;
    this._failures  = 0;
    this._openUntil = 0;
  }

  write(rows) {
    if (rows.length === 0) return;
    if (Date.now() < this._openUntil) return;

    const metrics = rows.map(r => ({
      route:       r.route,
      method:      r.method,
      service:     this._service,
      env:         r.env,
      release:     r.release_tag ?? null,
      time:        new Date(r.bucket_ts * 1000).toISOString(),
      calls_total: r.total_calls,
      calls_2xx:   r.status_2xx,
      calls_4xx:   r.status_4xx,
      calls_5xx:   r.status_5xx,
      lat_p50:     r.lat_p50 ?? null,
      lat_p90:     r.lat_p90 ?? null,
      lat_p99:     r.lat_p99 ?? null,
      lat_avg:     r.lat_avg ?? null,
      bytes_avg:   r.bytes_avg ?? null,
    }));

    fetch(this._url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': this._apiKey },
      body:    JSON.stringify({ metrics }),
    })
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        this._failures = 0;
      })
      .catch(err => {
        this._failures++;
        if (this._failures >= FAILURE_THRESHOLD) {
          this._openUntil = Date.now() + CIRCUIT_OPEN_MS;
          this._failures  = 0;
          console.warn(`[apiforgejs] Cloud flush failures — pausing for ${CIRCUIT_OPEN_MS / 1000}s. Error: ${err.message}`);
        }
      });
  }
}

module.exports = { CloudTransport };
