'use strict';

const CIRCUIT_OPEN_MS = 60_000;
const FAILURE_THRESHOLD = 5;

class LocalTransport {
  constructor(db) {
    this.db = db;
    this._failures = 0;
    this._openUntil = 0;
  }

  write(rows) {
    if (rows.length === 0) return;

    // Circuit breaker: if too many consecutive failures, pause writes temporarily
    if (Date.now() < this._openUntil) return;

    try {
      this.db.insertBatch(rows);
      this._failures = 0;
    } catch (err) {
      this._failures++;
      if (this._failures >= FAILURE_THRESHOLD) {
        this._openUntil = Date.now() + CIRCUIT_OPEN_MS;
        this._failures = 0;
        console.warn(`[apiforgejs] SQLite write failures — pausing for ${CIRCUIT_OPEN_MS / 1000}s. Error: ${err.message}`);
      }
    }
  }
}

module.exports = { LocalTransport };
