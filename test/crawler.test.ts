// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { NetworkCrawler } from '../lib-ts/mesh/crawler.js';

// Mock fetch que simula endpoints de peers
function createMockFetch(network: Record<string, any[]>) {
  return async (url: string) => {
    const match = Object.entries(network).find(([endpoint]) =>
      url.startsWith(endpoint)
    );

    if (!match) {
      return { ok: false, status: 404 };
    }

    return {
      ok: true,
      json: async () => ({ peers: match[1] }),
    };
  };
}

describe('NetworkCrawler', () => {
  describe('crawl (BFS)', () => {
    it('descobre peers de hop 0 (seeds)', async () => {
      const crawler = new NetworkCrawler({
        fetch: createMockFetch({}),
        maxHops: 2,
      });

      const seeds = [
        { nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' },
      ];

      const result = await crawler.crawl(seeds);
      expect(result.total).toBe(1);
      expect(result.peers.has('peer_a')).toBeTruthy();
    });

    it('descobre peers de hop 1 (amigos dos seeds)', async () => {
      const network = {
        'http://a:3000': [
          { nodeId: 'peer_b', name: 'B', endpoint: 'http://b:3000', infra: ['chat'] },
          { nodeId: 'peer_c', name: 'C', endpoint: null },
        ],
      };

      const crawler = new NetworkCrawler({
        fetch: createMockFetch(network),
        maxHops: 2,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      const result = await crawler.crawl(seeds);

      expect(result.total).toBe(3); // a + b + c
      expect(result.peers.has('peer_b')).toBeTruthy();
      expect(result.peers.has('peer_c')).toBeTruthy();
      expect(result.peers.get('peer_b').discoveredVia).toBe('peer_a');
    });

    it('descobre peers de hop 2 (amigos dos amigos)', async () => {
      const network = {
        'http://a:3000': [
          { nodeId: 'peer_b', name: 'B', endpoint: 'http://b:3000' },
        ],
        'http://b:3000': [
          { nodeId: 'peer_c', name: 'C', endpoint: 'http://c:3000' },
        ],
      };

      const crawler = new NetworkCrawler({
        fetch: createMockFetch(network),
        maxHops: 3,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      const result = await crawler.crawl(seeds);

      expect(result.total).toBe(3); // a + b + c
      expect(result.peers.get('peer_c').discoveredAt).toBe(2);
    });

    it('respeita maxHops', async () => {
      const network = {
        'http://a:3000': [{ nodeId: 'peer_b', name: 'B', endpoint: 'http://b:3000' }],
        'http://b:3000': [{ nodeId: 'peer_c', name: 'C', endpoint: 'http://c:3000' }],
        'http://c:3000': [{ nodeId: 'peer_d', name: 'D', endpoint: 'http://d:3000' }],
      };

      const crawler = new NetworkCrawler({
        fetch: createMockFetch(network),
        maxHops: 1, // só 1 hop
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      const result = await crawler.crawl(seeds);

      expect(result.peers.has('peer_b')).toBeTruthy();
      expect(result.peers.has('peer_c')).not.toBeTruthy(); // hop 2 — não alcançado
    });

    it('evita loops (visited set)', async () => {
      // A → B → A (loop)
      const network = {
        'http://a:3000': [{ nodeId: 'peer_b', name: 'B', endpoint: 'http://b:3000' }],
        'http://b:3000': [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }],
      };

      const crawler = new NetworkCrawler({
        fetch: createMockFetch(network),
        maxHops: 5,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      const result = await crawler.crawl(seeds);

      expect(result.total).toBe(2); // só a + b, sem loop infinito
      expect(result.crawled).toBe(2);
    });

    it('lida com endpoints que falham', async () => {
      const failFetch = async () => { throw new Error('Network error'); };

      const crawler = new NetworkCrawler({
        fetch: failFetch,
        maxHops: 2,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      const result = await crawler.crawl(seeds);

      expect(result.total).toBe(1); // só o seed
      expect(result.errors.length > 0).toBeTruthy();
    });
  });

  describe('cache', () => {
    it('retorna cache na segunda chamada', async () => {
      const crawler = new NetworkCrawler({
        fetch: createMockFetch({
          'http://a:3000': [{ nodeId: 'peer_b', name: 'B' }],
        }),
        maxHops: 2,
        cacheTtl: 60000,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];

      const r1 = await crawler.crawl(seeds);
      expect(r1.cached).not.toBeTruthy();

      const r2 = await crawler.crawl(seeds);
      expect(r2.cached).toBeTruthy();
    });

    it('force ignora cache', async () => {
      const crawler = new NetworkCrawler({
        fetch: createMockFetch({
          'http://a:3000': [{ nodeId: 'peer_b', name: 'B' }],
        }),
        maxHops: 2,
        cacheTtl: 60000,
      });

      const seeds = [{ nodeId: 'peer_a', name: 'A', endpoint: 'http://a:3000' }];
      await crawler.crawl(seeds);
      const r2 = await crawler.crawl(seeds, { force: true });
      expect(r2.cached).not.toBeTruthy();
    });

    it('invalidate limpa cache', async () => {
      const crawler = new NetworkCrawler({
        fetch: createMockFetch({}),
        cacheTtl: 60000,
      });

      await crawler.crawl([{ nodeId: 'a', endpoint: 'http://a:3000' }]);
      expect(crawler.cacheInfo().cached).toBeTruthy();

      crawler.invalidate();
      expect(crawler.cacheInfo().cached).not.toBeTruthy();
    });
  });
});
