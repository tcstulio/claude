// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, expect } from 'vitest';
import { requireScope, requireCapability, resolveScopes } from '../lib-ts/middleware/scope-guard.js';

// Helper: cria mock req/res/next
function mockReq(overrides: any = {}) {
  return { grantedScopes: [], ...overrides };
}

function mockRes() {
  const res: any = {
    _status: 200,
    _body: null,
    status(code: number) { res._status = code; return res; },
    json(body: any) { res._body = body; return res; },
  };
  return res;
}

describe('Scope Guard Middleware', () => {
  describe('requireScope', () => {
    it('permite com scope correto', () => {
      return new Promise<void>((resolve) => {
        const middleware = requireScope('messaging');
        const req = mockReq({ grantedScopes: ['messaging'] });
        const res = mockRes();
        middleware(req, res, () => resolve());
      });
    });

    it('permite com wildcard *', () => {
      return new Promise<void>((resolve) => {
        const middleware = requireScope('credentials');
        const req = mockReq({ grantedScopes: ['*'] });
        const res = mockRes();
        middleware(req, res, () => resolve());
      });
    });

    it('bloqueia sem scope', () => {
      const middleware = requireScope('messaging');
      const req = mockReq({ grantedScopes: [] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      expect(!called).toBeTruthy();
      expect(res._status).toBe(403);
      expect(res._body.error.includes('Scope insuficiente')).toBeTruthy();
      expect(res._body.required).toBe('messaging');
    });

    it('bloqueia com scope errado', () => {
      const middleware = requireScope('credentials');
      const req = mockReq({ grantedScopes: ['messaging', 'personal'] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      expect(!called).toBeTruthy();
      expect(res._status).toBe(403);
    });
  });

  describe('requireCapability', () => {
    it('infra passa sem scope', () => {
      return new Promise<void>((resolve) => {
        const middleware = requireCapability('chat');
        const req = mockReq({ grantedScopes: [] });
        const res = mockRes();
        middleware(req, res, () => resolve());
      });
    });

    it('private bloqueia sem scope', () => {
      const middleware = requireCapability('whatsapp');
      const req = mockReq({ grantedScopes: [] });
      const res = mockRes();
      let called = false;
      middleware(req, res, () => { called = true; });

      expect(!called).toBeTruthy();
      expect(res._status).toBe(403);
    });

    it('private permite com scope correto', () => {
      return new Promise<void>((resolve) => {
        const middleware = requireCapability('whatsapp');
        const req = mockReq({ grantedScopes: ['messaging'] });
        const res = mockRes();
        middleware(req, res, () => resolve());
      });
    });
  });

  describe('resolveScopes', () => {
    it('master token recebe wildcard *', () => {
      return new Promise<void>((resolve) => {
        const middleware = resolveScopes({
          resolveToken: () => 'master123',
          masterToken: 'master123',
        });
        const req: any = {};
        middleware(req, {}, () => {
          expect(req.grantedScopes).toEqual(['*']);
          resolve();
        });
      });
    });

    it('sem token recebe [] (só infra)', () => {
      return new Promise<void>((resolve) => {
        const middleware = resolveScopes({
          resolveToken: () => '',
          masterToken: 'master123',
        });
        const req: any = {};
        middleware(req, {}, () => {
          expect(req.grantedScopes).toEqual([]);
          resolve();
        });
      });
    });

    it('token de peer resolve scopes do metadata', () => {
      return new Promise<void>((resolve) => {
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
        const req: any = {};
        middleware(req, {}, () => {
          expect(req.grantedScopes).toEqual(['messaging']);
          expect(req.peer.nodeId).toBe('peer_1');
          resolve();
        });
      });
    });

    it('token desconhecido recebe []', () => {
      return new Promise<void>((resolve) => {
        const fakeMesh = {
          registry: { list: () => [] },
        };
        const middleware = resolveScopes({
          resolveToken: () => 'unknown_token',
          masterToken: 'master',
          mesh: fakeMesh,
        });
        const req: any = {};
        middleware(req, {}, () => {
          expect(req.grantedScopes).toEqual([]);
          resolve();
        });
      });
    });
  });
});
