'use strict';

const { createInterceptor } = require('./interceptor');
const { Aggregator } = require('./aggregator');
const { LocalTransport } = require('./transport');
const { ApiForgeDatabase } = require('./database');
const { startDashboard } = require('./dashboard');

/**
 * APIForge Express middleware factory.
 *
 * @param {object} options
 * @param {'local'} options.mode          - Storage mode. Only 'local' (SQLite) in v0.x.
 * @param {string}  [options.dbPath]      - SQLite file path. Default: '.apiforge.db'
 * @param {number}  [options.dashboardPort] - Dashboard port. Default: 4242. Set to 0 to disable.
 * @param {number}  [options.flushInterval] - Aggregation flush interval in ms. Default: 60000.
 * @param {string}  [options.env]         - Environment label. Default: NODE_ENV or 'production'.
 * @param {string}  [options.release]     - Release/version tag for deployment correlation.
 * @param {string}  [options.service]     - Service name for multi-service setups.
 * @param {number}  [options.sampling]    - Sample rate 0.0–1.0. Default: 1.0.
 * @param {string[]}[options.ignorePaths] - Paths to skip. Default: ['/favicon.ico'].
 */
function apiforge(options = {}) {
  if (options.mode && options.mode !== 'local') {
    throw new Error(`[apiforgejs] mode '${options.mode}' is not yet supported. Use 'local'.`);
  }

  const config = {
    mode: 'local',
    dbPath: options.dbPath ?? '.apiforge.db',
    dashboardPort: options.dashboardPort !== undefined ? options.dashboardPort : 4242,
    flushInterval: options.flushInterval ?? 60_000,
    env: options.env ?? process.env.NODE_ENV ?? 'production',
    release: options.release ?? process.env.APP_VERSION ?? null,
    service: options.service ?? 'default',
    sampling: options.sampling ?? 1.0,
    ignorePaths: options.ignorePaths ?? ['/favicon.ico'],
  };

  const db = new ApiForgeDatabase(config.dbPath);
  const transport = new LocalTransport(db);
  const aggregator = new Aggregator(transport, config.flushInterval);

  aggregator.start();

  if (config.dashboardPort) {
    startDashboard(db, config.dashboardPort);
  }

  const middleware = createInterceptor(aggregator, db, config);

  middleware.shutdown = () => {
    aggregator.stop();
    db.close();
  };

  return middleware;
}

module.exports = { apiforge };
