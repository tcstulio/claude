// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { FederatedSearch } from '../lib-ts/mesh/federation.js';

// Mock MeshManager mínimo
function createMockMesh(peers: any[] = [], queryResults: any[] = []) {
  return {
    nodeId: 'self_node',
    registry: {
      get: (id: string) => peers.find(p => p.nodeId === id) || null,
      list: () => peers,
      online: () => peers.filter(p => p.status === 'online'),
    },
    queryBySkill: (_skill: string) => queryResults,
    sendPrompt: async (nodeId: string, prompt: string) => ({
      method: 'direct',
      response: `Response from ${nodeId}: ${prompt}`,
      model: 'test',
    }),
  };
}

// Mock fetch para simular hubs remotos
function createMockFetch(responses: Record<string, any> = {}) {
  return async (url: string, options: any = {}) => {
    for (const [pattern, handler] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        const result = typeof handler === 'function' ? handler(url, options) : handler;
        return {
          ok: true,
          status: 200,
          json: async () => result,
        };
      }
    }
    return { ok: false, status: 404 };
  };
}

describe('FederatedSearch', () => {
  describe('query (local)', () => {
    it('retorna resultados locais', async () => {
      const localResults = [
        { peer: { nodeId: 'peer_a', name: 'A' }, score: 0.8, eligible: true },
        { peer: { nodeId: 'peer_b', name: 'B' }, score: 0.5, eligible: true },
      ];

      const mesh = createMockMesh([], localResults);
      const fed = new FederatedSearch({ mesh, maxHops: 0 });

      const result = await fed.query('chat');
      expect(result.local).toBe(2);
      expect(result.total).toBe(2);
      expect(result.results[0].peer.nodeId).toBe('peer_a'); // maior score primeiro
    });

    it('dedup por queryId', async () => {
      const mesh = createMockMesh([], [{ peer: { nodeId: 'a' }, score: 0.5 }]);
      const fed = new FederatedSearch({ mesh, maxHops: 0 });

      const r1 = await fed.query('chat', { queryId: 'q_test_1' });
      expect(r1.total).toBe(1);

      const r2 = await fed.query('chat', { queryId: 'q_test_1' });
      expect(r2.deduplicated).toBeTruthy();
      expect(r2.results.length).toBe(0);
    });
  });

  describe('query (propagação remota)', () => {
    it('propaga para hubs e agrega resultados', async () => {
      const peers = [
        { nodeId: 'hub_1', name: 'Hub 1', endpoint: 'http://hub1:3000', status: 'online' },
      ];

      const mesh = createMockMesh(peers, []);
      const fed = new FederatedSearch({
        mesh,
        fetch: createMockFetch({
          '/api/network/query': {
            results: [
              { peer: { nodeId: 'remote_a', name: 'Remote A' }, score: 0.7, eligible: true },
            ],
            local: 1,
            remote: 0,
            total: 1,
          },
        }),
        maxHops: 1,
      });

      const result = await fed.query('code-execution');
      expect(result.remote).toBe(1);
      expect(result.results.some(r => r.peer?.nodeId === 'remote_a')).toBeTruthy();
      expect(result.results.find(r => r.peer?.nodeId === 'remote_a').via).toBe('hub_1');
    });

    it('merge dedup: local prevalece sobre remote', async () => {
      const peers = [
        { nodeId: 'hub_1', name: 'Hub', endpoint: 'http://hub:3000', status: 'online' },
      ];

      const localResults = [
        { peer: { nodeId: 'peer_a', name: 'A' }, score: 0.9, eligible: true },
      ];

      const mesh = createMockMesh(peers, localResults);
      const fed = new FederatedSearch({
        mesh,
        fetch: createMockFetch({
          '/api/network/query': {
            results: [
              { peer: { nodeId: 'peer_a', name: 'A remote' }, score: 0.6, eligible: true },
              { peer: { nodeId: 'peer_b', name: 'B' }, score: 0.5, eligible: true },
            ],
          },
        }),
        maxHops: 1,
      });

      const result = await fed.query('chat');
      // peer_a aparece só 1x (versão local com score 0.9)
      const peerA = result.results.filter(r => r.peer?.nodeId === 'peer_a');
      expect(peerA.length).toBe(1);
      expect(peerA[0].source).toBe('local');
      expect(result.total).toBe(2); // a (local) + b (remote)
    });
  });

  describe('rate limiting', () => {
    it('bloqueia após exceder maxQueries', async () => {
      const mesh = createMockMesh([], []);
      const fed = new FederatedSearch({
        mesh,
        maxHops: 0,
        rateLimit: { windowMs: 60000, maxQueries: 3, maxRelays: 10 },
      });

      await fed.query('a');
      await fed.query('b');
      await fed.query('c');
      const r4 = await fed.query('d');

      expect(r4.rateLimited).toBeTruthy();
    });
  });

  describe('relay', () => {
    it('relay direto para peer acessível', async () => {
      const peers = [
        { nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000', metadata: { token: 'tok' } },
      ];

      const mesh = createMockMesh(peers);
      const fed = new FederatedSearch({ mesh });

      const result = await fed.relay('peer_a', 'Hello');
      expect(result.method).toBe('direct');
      expect(result.response).toMatch(/peer_a/);
    });

    it('erro para peer inalcançável', async () => {
      const mesh = createMockMesh([
        { nodeId: 'peer_z', name: 'Z', metadata: {} },
      ], []);

      const fed = new FederatedSearch({
        mesh,
        maxHops: 0,
        fetch: async () => ({ ok: false, status: 404 }),
      });

      await expect(
        () => fed.relay('peer_z', 'Hello')
      ).rejects.toThrow(/No route/);
    });

    it('relay via hub intermediário', async () => {
      const peers = [
        { nodeId: 'peer_target', name: 'Target', metadata: { discoveredVia: 'hub_1' } },
        { nodeId: 'hub_1', name: 'Hub', endpoint: 'http://hub:3000', metadata: {} },
      ];

      const mesh = createMockMesh(peers);
      const fed = new FederatedSearch({
        mesh,
        fetch: createMockFetch({
          '/api/network/relay': {
            ok: true,
            response: 'Relayed response',
            model: 'claude',
          },
        }),
      });

      const result = await fed.relay('peer_target', 'Hello via relay');
      expect(result.method).toBe('relay');
      expect(result.via).toBe('hub_1');
      expect(result.response).toBe('Relayed response');
    });

    it('rate limit em relays', async () => {
      const mesh = createMockMesh([
        { nodeId: 'p', name: 'P', endpoint: 'http://p:3000', metadata: { token: 't' } },
      ]);

      const fed = new FederatedSearch({
        mesh,
        rateLimit: { windowMs: 60000, maxQueries: 100, maxRelays: 2 },
      });

      await fed.relay('p', 'a');
      await fed.relay('p', 'b');
      await expect(
        () => fed.relay('p', 'c')
      ).rejects.toThrow(/Rate limit/);
    });
  });

  describe('stats', () => {
    it('retorna estatísticas', async () => {
      const mesh = createMockMesh([], []);
      const fed = new FederatedSearch({ mesh, maxHops: 0 });

      await fed.query('a');
      await fed.query('b');

      const stats = fed.stats();
      expect(stats.queries.recent).toBe(2);
      expect(stats.relays.recent).toBe(0);
      expect(stats.queries.max > 0).toBeTruthy();
    });
  });
});
