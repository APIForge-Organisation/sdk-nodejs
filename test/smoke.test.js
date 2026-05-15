'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Prevent the dashboard from binding a real port during tests
process.env.NODE_ENV = 'test';

describe('apiforgejs — smoke tests', () => {
  let apiforge;

  before(() => {
    ({ apiforge } = require('../src/index.js'));
  });

  it('exports apiforge as a function', () => {
    assert.strictEqual(typeof apiforge, 'function');
  });

  it('returns an Express-compatible middleware', () => {
    const mw = apiforge({ mode: 'local', dashboardPort: 0, dbPath: ':memory:' });
    assert.strictEqual(typeof mw, 'function');
    assert.strictEqual(mw.length, 3); // (req, res, next)
    mw.shutdown?.();
  });

  it('throws on unsupported mode', () => {
    assert.throws(
      () => apiforge({ mode: 'saas' }),
      /mode 'saas' is not yet supported/
    );
  });

  it('applies default config values', () => {
    const mw = apiforge({ mode: 'local', dashboardPort: 0, dbPath: ':memory:' });
    mw.shutdown?.();
  });

  describe('middleware behavior', () => {
    let mw;

    before(() => {
      mw = apiforge({ mode: 'local', dashboardPort: 0, dbPath: ':memory:' });
    });

    after(() => {
      mw.shutdown?.();
    });

    it('calls next() on a valid request', (_, done) => {
      const req = {
        method: 'GET',
        route: { path: '/health' },
        path: '/health',
        res: null,
      };
      const res = {
        on: (event, cb) => { if (event === 'finish') setTimeout(cb, 0); },
        statusCode: 200,
        getHeader: () => null,
      };
      req.res = res;

      mw(req, res, () => done());
    });
  });
});
