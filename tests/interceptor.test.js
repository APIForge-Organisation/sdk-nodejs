'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createInterceptor, extractExpressRoutes } = require('../src/interceptor.js');

// Minimal aggregator stub
function makeAgg() {
  const events = [];
  return { record: (e) => events.push(e), events };
}

// Minimal db stub (upsertKnownRoutes is called once, silently)
function makeDb() {
  return { upsertKnownRoutes: () => {} };
}

function makeConfig(overrides = {}) {
  return {
    env: 'test',
    release: null,
    service: 'svc',
    sampling: 1.0,
    ignorePaths: ['/health'],
    ...overrides,
  };
}

describe('createInterceptor()', () => {
  it('returns a function with arity 3', () => {
    const mw = createInterceptor(makeAgg(), makeDb(), makeConfig());
    assert.strictEqual(typeof mw, 'function');
    assert.strictEqual(mw.length, 3);
  });

  it('calls next() and records the event after the response finishes', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = { method: 'GET', path: '/users', route: { path: '/users/:id' }, baseUrl: '', app: null };
    const res = {
      on: (evt, cb) => { if (evt === 'finish') finishCb = cb; },
      statusCode: 200,
      getHeader: () => '128',
    };

    mw(req, res, () => {
      // Simulate response finish
      finishCb();
      setImmediate(() => {
        assert.strictEqual(agg.events.length, 1);
        const e = agg.events[0];
        assert.strictEqual(e.method, 'GET');
        assert.strictEqual(e.status, 200);
        assert.strictEqual(e.response_size, 128);
        done();
      });
    });
  });

  it('skips ignored paths and does not call record()', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig({ ignorePaths: ['/health'] }));

    const req = { method: 'GET', path: '/health', route: null, app: null };
    const res = { on: () => {}, statusCode: 200, getHeader: () => null };

    mw(req, res, () => {
      assert.strictEqual(agg.events.length, 0);
      done();
    });
  });

  it('falls back to normalized path when req.route is absent', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = { method: 'GET', path: '/users/123', route: null, app: null };
    const res = {
      on: (evt, cb) => { if (evt === 'finish') finishCb = cb; },
      statusCode: 200,
      getHeader: () => null,
    };

    mw(req, res, () => {
      finishCb();
      setImmediate(() => {
        assert.ok(agg.events[0].route.includes(':id'), `expected normalized route, got ${agg.events[0].route}`);
        done();
      });
    });
  });

  it('respects sampling: at rate 0, no events are recorded', () => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig({ sampling: 0.0 }));

    for (let i = 0; i < 50; i++) {
      const req = { method: 'GET', path: '/x', route: null, app: null };
      const res = { on: () => {}, statusCode: 200, getHeader: () => null };
      mw(req, res, () => {});
    }
    assert.strictEqual(agg.events.length, 0);
  });

  it('does not crash when the finish callback throws', (_, done) => {
    // Aggregator throws — the middleware must swallow the error
    const agg = { record: () => { throw new Error('record failed'); } };
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = { method: 'GET', path: '/ok', route: { path: '/ok' }, baseUrl: '', app: null };
    const res = {
      on: (evt, cb) => { if (evt === 'finish') finishCb = cb; },
      statusCode: 200,
      getHeader: () => null,
    };

    assert.doesNotThrow(() => {
      mw(req, res, () => {
        assert.doesNotThrow(() => finishCb());
        done();
      });
    });
  });
});

describe('extractExpressRoutes()', () => {
  it('returns empty array when router has no stack', () => {
    assert.deepStrictEqual(extractExpressRoutes(null), []);
    assert.deepStrictEqual(extractExpressRoutes({}), []);
  });

  it('extracts a simple route', () => {
    const router = {
      stack: [{
        route: {
          path: '/users',
          methods: { get: true },
        },
      }],
    };
    const routes = extractExpressRoutes(router);
    assert.deepStrictEqual(routes, [{ method: 'GET', route: '/users' }]);
  });

  it('extracts multiple methods from the same route', () => {
    const router = {
      stack: [{
        route: {
          path: '/items',
          methods: { get: true, post: true },
        },
      }],
    };
    const routes = extractExpressRoutes(router);
    assert.strictEqual(routes.length, 2);
    assert.ok(routes.some(r => r.method === 'GET'));
    assert.ok(routes.some(r => r.method === 'POST'));
  });
});
