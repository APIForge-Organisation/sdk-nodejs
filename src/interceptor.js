'use strict';

const NUMERIC_SEGMENT = /\/\d+/g;
const UUID_SEGMENT = /\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function normalizePath(path) {
  return path.replace(UUID_SEGMENT, '/:uuid').replace(NUMERIC_SEGMENT, '/:id');
}

// Walk Express router stack and return all declared routes
function extractExpressRoutes(router, prefix = '') {
  const routes = [];
  if (!router?.stack) return routes;

  for (const layer of router.stack) {
    if (layer.route) {
      const path = prefix + layer.route.path;
      const methods = Object.keys(layer.route.methods)
        .filter(m => m !== '_all' && layer.route.methods[m])
        .map(m => m.toUpperCase());
      for (const method of methods) {
        routes.push({ method, route: path || '/' });
      }
    } else if (layer.handle?.stack) {
      // Nested router mounted via app.use(prefix, router)
      const subPrefix = prefix + routerLayerPath(layer);
      extractExpressRoutes(layer.handle, subPrefix).forEach(r => routes.push(r));
    }
  }
  return routes;
}

// Best-effort extraction of the mount path from a router layer's compiled regexp.
// Works for simple static prefixes (/api, /v1/users, etc.) — skips prefixes with params.
function routerLayerPath(layer) {
  if (!layer.regexp || layer.keys?.length > 0) return '';
  const src = layer.regexp.source;
  // regexp for app.use('/prefix') looks like: ^\/prefix\/?(?=\/|$)
  const m = src.match(/^\^\\\/([^?]+?)\\\//);
  if (!m) return '';
  return '/' + m[1].replace(/\\\//g, '/');
}

function createInterceptor(aggregator, db, config) {
  const { env, release, service, sampling, ignorePaths } = config;
  const ignoreSet = new Set(ignorePaths);

  let routesScanned = false;

  function scanRoutes(app) {
    try {
      const routes = extractExpressRoutes(app._router);
      if (routes.length > 0) db.upsertKnownRoutes(routes);
    } catch (_) {
      // Non-critical — never crash the host app
    }
  }

  function middleware(req, res, next) {
    // Scan all declared Express routes once, after the first request
    // (guarantees all app.get/post/etc calls have already executed)
    if (!routesScanned && req.app) {
      routesScanned = true;
      setImmediate(() => scanRoutes(req.app));
    }

    if (ignoreSet.has(req.path)) return next();
    if (sampling < 1.0 && Math.random() > sampling) return next();

    const startHr = process.hrtime.bigint();

    res.on('finish', () => {
      try {
        const durationMs = Number(process.hrtime.bigint() - startHr) / 1_000_000;

        // Use Express matched route pattern — never the concrete URL values
        const routePattern = req.route
          ? (req.baseUrl || '') + req.route.path
          : normalizePath(req.path);

        const contentLength = res.getHeader('content-length');

        aggregator.record({
          route: routePattern,
          method: req.method,
          status: res.statusCode,
          duration_ms: durationMs,
          timestamp: new Date().toISOString(),
          env,
          release: release || null,
          service,
          response_size: contentLength ? parseInt(contentLength, 10) : null,
        });
      } catch (_) {
        // Never let instrumentation crash the host application
      }
    });

    next();
  }

  return middleware;
}

module.exports = { createInterceptor, extractExpressRoutes };
