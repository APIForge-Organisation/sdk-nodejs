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

// Minimal res mock — includes write/end required by TTFB patch
function makeRes(overrides = {}) {
  return {
    write: () => true,
    end: () => true,
    on: () => {},
    statusCode: 200,
    getHeader: () => null,
    ...overrides,
  };
}

// Minimal req mock — includes headers required for request_size
function makeReq(overrides = {}) {
  return {
    method: 'GET',
    path: '/test',
    route: null,
    baseUrl: '',
    app: null,
    headers: {},
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
    const req = makeReq({ route: { path: '/users/:id' }, path: '/users' });
    const res = makeRes({
      on: (evt, cb) => { if (evt === 'finish') finishCb = cb; },
      statusCode: 200,
      getHeader: () => '128',
    });

    mw(req, res, () => {
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

    const req = makeReq({ path: '/health' });
    const res = makeRes();

    mw(req, res, () => {
      assert.strictEqual(agg.events.length, 0);
      done();
    });
  });

  it('falls back to normalized path when req.route is absent', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = makeReq({ path: '/users/123' });
    const res = makeRes({ on: (evt, cb) => { if (evt === 'finish') finishCb = cb; } });

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
      mw(makeReq(), makeRes(), () => {});
    }
    assert.strictEqual(agg.events.length, 0);
  });

  it('does not crash when the finish callback throws', (_, done) => {
    const agg = { record: () => { throw new Error('record failed'); } };
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = makeReq({ route: { path: '/ok' }, path: '/ok' });
    const res = makeRes({ on: (evt, cb) => { if (evt === 'finish') finishCb = cb; } });

    assert.doesNotThrow(() => {
      mw(req, res, () => {
        assert.doesNotThrow(() => finishCb());
        done();
      });
    });
  });

  it('records request_size from Content-Length request header', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = makeReq({
      method: 'POST',
      path: '/items',
      route: { path: '/items' },
      headers: { 'content-length': '512' },
    });
    const res = makeRes({ on: (evt, cb) => { if (evt === 'finish') finishCb = cb; } });

    mw(req, res, () => {
      finishCb();
      setImmediate(() => {
        assert.strictEqual(agg.events[0].request_size, 512);
        done();
      });
    });
  });

  it('records null request_size when Content-Length header is absent', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = makeReq({ route: { path: '/x' }, path: '/x' });
    const res = makeRes({ on: (evt, cb) => { if (evt === 'finish') finishCb = cb; } });

    mw(req, res, () => {
      finishCb();
      setImmediate(() => {
        assert.strictEqual(agg.events[0].request_size, null);
        done();
      });
    });
  });

  it('records ttfb_ms when res.write is called before finish', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    let finishCb;
    const req = makeReq({ route: { path: '/stream' }, path: '/stream' });
    // res.write is patched by the interceptor — we call it to simulate streaming
    const res = {
      write: () => true,
      end: () => true,
      on: (evt, cb) => { if (evt === 'finish') finishCb = cb; },
      statusCode: 200,
      getHeader: () => null,
    };

    mw(req, res, () => {
      // Simulate first byte sent mid-response
      res.write('chunk');
      finishCb();
      setImmediate(() => {
        const e = agg.events[0];
        assert.ok(typeof e.ttfb_ms === 'number', 'ttfb_ms should be a number');
        assert.ok(e.ttfb_ms <= e.duration_ms, 'TTFB should not exceed total duration');
        done();
      });
    });
  });

  it('records inflight count reflecting concurrent requests', (_, done) => {
    const agg = makeAgg();
    const mw  = createInterceptor(agg, makeDb(), makeConfig());

    // First request enters, does not finish yet
    let finish1;
    const req1 = makeReq({ route: { path: '/a' }, path: '/a' });
    const res1 = makeRes({ on: (evt, cb) => { if (evt === 'finish') finish1 = cb; } });
    mw(req1, res1, () => {});

    // Second request enters while first is still open
    let finish2;
    const req2 = makeReq({ route: { path: '/a' }, path: '/a' });
    const res2 = makeRes({ on: (evt, cb) => { if (evt === 'finish') finish2 = cb; } });
    mw(req2, res2, () => {});

    // Finish both
    finish1();
    finish2();

    setImmediate(() => {
      // Both events recorded; inflight for req2 should be >= 2 (both were in flight)
      assert.ok(agg.events.length >= 2);
      const inflightValues = agg.events.map(e => e.inflight);
      assert.ok(inflightValues.some(v => v >= 2), `expected at least one inflight >= 2, got ${JSON.stringify(inflightValues)}`);
      done();
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
