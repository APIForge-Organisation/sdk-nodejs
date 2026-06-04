'use strict';

const { createInterceptor } = require('./interceptor');
const { Aggregator }        = require('./aggregator');
const { LocalTransport }    = require('./transport');
const { CloudTransport }    = require('./cloud-transport');
const { ApiForgeDatabase }  = require('./database');
const { startDashboard }    = require('./dashboard');

/**
 * APIForge Express middleware factory.
 *
 * @param {object}   options
 * @param {string}   [options.mode]          - 'local' (default) or 'cloud'.
 * @param {string}   [options.cloudUrl]      - Cloud mode: SaaS API base URL.
 * @param {string}   [options.apiKey]        - Cloud mode: project API key (af_…).
 * @param {string}   [options.dbPath]        - Local mode: SQLite path. Default: '.apiforge.db'.
 * @param {number}   [options.dashboardPort] - Local mode: dashboard port. Default: 4242. 0 = off.
 * @param {string}   [options.env]           - Environment label. Default: 'production'.
 * @param {string}   [options.release]       - Release/version tag.
 * @param {string}   [options.service]       - Service name. Default: 'default'.
 * @param {number}   [options.sampling]      - Sample rate 0.0–1.0. Default: 1.0.
 * @param {string[]} [options.ignorePaths]   - Paths to skip. Default: ['/favicon.ico'].
 */
function apiforge(options = {}) {
  const hasCloudUrl = Boolean(options.cloudUrl);
  const hasApiKey   = Boolean(options.apiKey);
  const isCloud     = options.mode === 'cloud' || (hasCloudUrl && hasApiKey);

  if ((hasCloudUrl || hasApiKey) && !(hasCloudUrl && hasApiKey)) {
    throw new Error('[apiforgejs] Cloud mode requires both cloudUrl and apiKey options.');
  }

  const config = {
    mode:          isCloud ? 'cloud' : 'local',
    cloudUrl:      options.cloudUrl ?? null,
    apiKey:        options.apiKey   ?? null,
    dbPath:        options.dbPath   ?? '.apiforge.db',
    dashboardPort: isCloud ? 0 : (options.dashboardPort !== undefined ? options.dashboardPort : 4242),
    env:           options.env     ?? 'production',
    release:       options.release ?? null,
    service:       options.service ?? 'default',
    sampling:      options.sampling ?? 1.0,
    ignorePaths:   options.ignorePaths ?? ['/favicon.ico'],
  };

  let transport, db;

  if (isCloud) {
    transport = new CloudTransport(config.cloudUrl, config.apiKey, config.service);
  } else {
    db        = new ApiForgeDatabase(config.dbPath);
    transport = new LocalTransport(db);
  }

  const aggregator = new Aggregator(transport, 60_000);
  aggregator.start();

  const dashboardServer = (!isCloud && config.dashboardPort)
    ? startDashboard(db, config.dashboardPort)
    : null;

  const storeRoutes = isCloud
    ? routes => transport.writeRoutes(routes)
    : routes => db.upsertKnownRoutes(routes);

  const middleware = createInterceptor(aggregator, storeRoutes, config);

  middleware.shutdown = () => {
    aggregator.stop();
    if (dashboardServer) dashboardServer.close();
    if (db) db.close();
  };

  return middleware;
}

module.exports = { apiforge };
