'use strict';

/**
 * NetworkCrawler — BFS crawler para descobrir peers além dos vizinhos diretos.
 *
 * Fluxo:
 *   1. Começa pelos peers conhecidos (registry)
 *   2. Para cada peer com endpoint, faz GET /api/network/peers/public
 *   3. Descobre peers de segundo grau (amigos dos amigos)
 *   4. Continua até maxHops ou sem novos peers
 *   5. Resultado cacheado com TTL configurável
 *
 * Respeita:
 *   - visited set (evita loops)
 *   - maxHops (limita profundidade)
 *   - timeout por request
 *   - cache TTL (evita flood na rede)
 */

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_CACHE_TTL = 5 * 60 * 1000; // 5 min
const DEFAULT_TIMEOUT = 10000; // 10s por request

class NetworkCrawler {
  /**
   * @param {object} options
   * @param {function} options.fetch — fetch function (com proxy se necessário)
   * @param {number} [options.maxHops] — profundidade máxima do BFS (default 3)
   * @param {number} [options.cacheTtl] — TTL do cache em ms (default 5 min)
   * @param {number} [options.timeout] — timeout por request em ms (default 10s)
   */
  constructor(options = {}) {
    this._fetch = options.fetch || globalThis.fetch;
    this._maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this._cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;

    // Cache: { timestamp, peers: Map<nodeId, peerInfo> }
    this._cache = null;
  }

  /**
   * Crawl a rede a partir de seeds (peers com endpoint conhecido).
   *
   * @param {Array} seeds — peers iniciais [{ nodeId, name, endpoint, ... }]
   * @param {object} [options]
   * @param {boolean} [options.force] — ignorar cache
   * @returns {Promise<{ peers: Map<string, object>, hops: number, crawled: number, errors: string[] }>}
   */
  async crawl(seeds, options = {}) {
    // Check cache
    if (!options.force && this._cache && Date.now() - this._cache.timestamp < this._cacheTtl) {
      return { ...this._cache.result, cached: true };
    }

    const visited = new Set();
    const allPeers = new Map();
    const errors = [];
    let maxHopReached = 0;

    // Queue: [{ peer, hop }]
    const queue = seeds
      .filter(s => s.endpoint)
      .map(s => ({ peer: s, hop: 0 }));

    // Adicionar seeds ao mapa
    for (const s of seeds) {
      if (s.nodeId) {
        allPeers.set(s.nodeId, { ...s, discoveredAt: 0 });
      }
    }

    while (queue.length > 0) {
      const { peer, hop } = queue.shift();

      if (hop > this._maxHops) continue;
      if (!peer.endpoint) continue;

      const endpointKey = peer.endpoint;
      if (visited.has(endpointKey)) continue;
      visited.add(endpointKey);

      maxHopReached = Math.max(maxHopReached, hop);

      try {
        const remotePeers = await this._fetchPublicPeers(peer.endpoint);

        for (const rp of remotePeers) {
          if (!rp.nodeId) continue;

          // Adicionar ao mapa se novo
          if (!allPeers.has(rp.nodeId)) {
            allPeers.set(rp.nodeId, {
              ...rp,
              discoveredAt: hop + 1,
              discoveredVia: peer.nodeId,
            });

            // Enfileirar para próximo hop se tem endpoint
            if (rp.endpoint && hop + 1 < this._maxHops) {
              queue.push({ peer: rp, hop: hop + 1 });
            }
          }
        }
      } catch (err) {
        errors.push(`${peer.endpoint}: ${err.message}`);
      }
    }

    const result = {
      peers: allPeers,
      hops: maxHopReached,
      crawled: visited.size,
      total: allPeers.size,
      errors,
    };

    // Cachear
    this._cache = { timestamp: Date.now(), result };

    return { ...result, cached: false };
  }

  /**
   * Busca peers públicos de um endpoint remoto.
   * @private
   */
  async _fetchPublicPeers(endpoint) {
    const url = `${endpoint.replace(/\/$/, '')}/api/network/peers/public`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const res = await this._fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      return data.peers || data || [];
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Invalida o cache.
   */
  invalidate() {
    this._cache = null;
  }

  /**
   * Retorna info do cache.
   */
  cacheInfo() {
    if (!this._cache) return { cached: false };
    return {
      cached: true,
      age: Date.now() - this._cache.timestamp,
      ttl: this._cacheTtl,
      total: this._cache.result.total,
    };
  }
}

module.exports = NetworkCrawler;
