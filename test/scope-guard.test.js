'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { requireScope, requireCapability, resolveScopes } = require('../lib/middleware/scope-guard');

// Helper: cria mock req/res/next
function mockReq(overrides = {}) {
  return { grantedScopes: [], ...overrides };
}

function mockRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { res._status = code; return res; },
    json(body) { res._body = body; return res; },
  };
  return res;
}

describe('Scope Guard Middleware', () => {
  describe('requireScope', () => {
    it('permite com scope correto', (_, done) => {
      const middleware = requireScope('messaging');
      const req = mockReq({ grantedScopes: ['messaging'] });
      const res = mockRes();
      middleware(req, res, () => done());
    });

    it('permite com wildcard *', (_, done) => {
      const middleware = requireScope('credentials');
      const req = mockReq({ grantedScopes: ['*'] });
      const res = mockRes();
      middleware(req, res, () => done());
    });

    it('bloqueia sem scope', () => {
      const middleware = requireScope('messaging');
      const req = mockReq({ grantedScopes: [] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      assert.ok(!called);
      assert.equal(res._status, 403);
      assert.ok(res._body.error.includes('Scope insuficiente'));
      assert.equal(res._body.required, 'messaging');
    });

    it('bloqueia com scope errado', () => {
      const middleware = requireScope('credentials');
      const req = mockReq({ grantedScopes: ['messaging', 'personal'] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      assert.ok(!called);
      assert.equal(res._status, 403);
    });
  });

  describe('requireCapability', () => {
    it('infra passa sem scope', (_, done) => {
      const middleware = requireCapability('chat');
      const req = mockReq({ grantedScopes: [] });
      const res = mockRes();
      middleware(req, res, () => done());
    });

    it('private bloqueia sem scope', () => {
      const middleware = requireCapability('whatsapp');
      const req = mockReq({ grantedScopes: [] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      assert.ok(!called);
      assert.equal(res._status, 403);
    });

    it('private permite com scope correto', (_, done) => {
      const middleware = requireCapability('whatsapp');
      const req = mockReq({ grantedScopes: ['messaging'] });
      const res = mockRes();
      middleware(req, res, () => done());
    });
  });

  describe('resolveScopes', () => {
    it('master token recebe wildcard *', (_, done) => {
      const middleware = resolveScopes({
        resolveToken: () => 'master123',
        masterToken: 'master123',
      });
      const req = {};
      middleware(req, {}, () => {
        assert.deepEqual(req.grantedScopes, ['*']);
        done();
      });
    });

    it('sem token recebe [] (só infra)', (_, done) => {
      const middleware = resolveScopes({
        resolveToken: () => '',
        masterToken: 'master123',
      });
      const req = {};
      middleware(req, {}, () => {
        assert.deepEqual(req.grantedScopes, []);
        done();
      });
    });

    it('token de peer resolve scopes do metadata', (_, done) => {
      const fakeMesh = {
        registry: {
          list: () => [{
            nodeId: 'peer_1',
            metadata: { token: 'peer_tok_123', scopes: ['messaging'] },
          }],
        },
      };
      const middleware = resolveScopes({
        resolveToken: () => 'peer_tok_123',
        masterToken: 'master',
        mesh: fakeMesh,
      });
      const req = {};
      middleware(req, {}, () => {
        assert.deepEqual(req.grantedScopes, ['messaging']);
        assert.equal(req.peer.nodeId, 'peer_1');
        done();
      });
    });

    it('token desconhecido recebe []', (_, done) => {
      const fakeMesh = {
        registry: { list: () => [] },
      };
      const middleware = resolveScopes({
        resolveToken: () => 'unknown_token',
        masterToken: 'master',
        mesh: fakeMesh,
      });
      const req = {};
      middleware(req, {}, () => {
        assert.deepEqual(req.grantedScopes, []);
        done();
      });
    });
  });
});
