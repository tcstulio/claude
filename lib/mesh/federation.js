'use strict';

/**
 * FederatedSearch — busca distribuída por skills/capabilities na rede Tulipa.
 *
 * Fluxo:
 *   1. Nó A quer encontrar quem faz "code-execution"
 *   2. Busca local no registry
 *   3. Se insuficiente, propaga query para hubs conhecidos
 *   4. Hubs propagam para seus peers (com hop limit)
 *   5. Resultados agregados, dedup, ranked por trust
 *
 * Relay:
 *   Se o melhor peer não é alcançável diretamente, o hub intermediário
 *   faz relay da task (proxy transparente).
 */

const DEFAULT_QUERY_TIMEOUT = 15000;  // 15s
const DEFAULT_MAX_HOPS = 2;          // Quantas vezes a query pode ser repassada
const DEFAULT_RATE_LIMIT = {
  windowMs: 60000,       // 1 minuto
  maxQueries: 30,        // máximo 30 queries por minuto
  maxRelays: 10,         // máximo 10 relays por minuto
};

class FederatedSearch {
  /**
   * @param {object} options
   * @param {object} options.mesh — MeshManager
   * @param {function} options.fetch — fetch function
   * @param {number} [options.queryTimeout] — timeout por query remota (ms)
   * @param {number} [options.maxHops] — max propagações da query
   * @param {object} [options.rateLimit] — { windowMs, maxQueries, maxRelays }
   */
  constructor(options = {}) {
    this._mesh = options.mesh;
    this._fetch = options.fetch || globalThis.fetch;
    this._queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    this._maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this._rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };

    // Rate limit tracking
    this._queryLog = [];  // timestamps
    this._relayLog = [];  // timestamps

    // Query dedup: evitar processar a mesma query propagada 2x
    this._seenQueries = new Map(); // queryId -> timestamp
    this._seenQueryTtl = 60000;    // 1 min
  }

  /**
   * Busca federada por skill na rede.
   *
   * @param {string} skill — capability procurada
   * @param {object} [options]
   * @param {string} [options.queryId] — ID da query (para dedup em propagação)
   * @param {number} [options.hopsRemaining] — hops restantes (para propagação)
   * @param {string} [options.originNode] — quem originou a query
   * @param {number} [options.minTrust] — trust mínimo (default: delegation threshold)
   * @returns {Promise<{ results: Array, local: number, remote: number, hops: number }>}
   */
  async query(skill, options = {}) {
    const queryId = options.queryId || `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const hopsRemaining = options.hopsRemaining ?? this._maxHops;
    const originNode = options.originNode || this._mesh.nodeId;

    // Dedup: já processamos essa query?
    if (this._seenQueries.has(queryId)) {
      return { results: [], local: 0, remote: 0, hops: 0, deduplicated: true };
    }
    this._seenQueries.set(queryId, Date.now());
    this._cleanupSeenQueries();

    // Rate limit
    if (!this._checkRateLimit('query')) {
      return { results: [], local: 0, remote: 0, hops: 0, rateLimited: true };
    }

    // 1. Busca local
    const localResults = this._mesh.queryBySkill(skill, { eligibleOnly: false });

    // 2. Propagação remota (se hops restantes > 0)
    let remoteResults = [];
    if (hopsRemaining > 0) {
      remoteResults = await this._propagateQuery(skill, {
        queryId,
        hopsRemaining: hopsRemaining - 1,
        originNode,
      });
    }

    // 3. Merge + dedup + rank
    const merged = this._mergeResults(localResults, remoteResults);

    return {
      queryId,
      skill,
      results: merged,
      local: localResults.length,
      remote: remoteResults.length,
      total: merged.length,
      hops: this._maxHops - hopsRemaining,
    };
  }

  /**
   * Propaga query para peers com endpoint que podem ter o skill.
   * @private
   */
  async _propagateQuery(skill, options) {
    const peers = this._mesh.registry.online().filter(p => p.endpoint);
    const results = [];

    const promises = peers.map(async (peer) => {
      try {
        const url = `${peer.endpoint.replace(/\/$/, '')}/api/network/query`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._queryTimeout);

        try {
          const res = await this._fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'Accept': 'application/json',
            },
            body: JSON.stringify({
              skill,
              queryId: options.queryId,
              hopsRemaining: options.hopsRemaining,
              originNode: options.originNode,
            }),
          });

          if (res.ok) {
            const data = await res.json();
            if (data.results) {
              for (const r of data.results) {
                results.push({
                  ...r,
                  via: peer.nodeId,
                  viaName: peer.name,
                });
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Peer inacessível — silenciar
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  /**
   * Merge resultados locais e remotos, dedup por nodeId, rank por score.
   * @private
   */
  _mergeResults(local, remote) {
    const seen = new Map();

    // Locais primeiro (preferência)
    for (const r of local) {
      const key = r.peer?.nodeId || r.nodeId;
      if (key && !seen.has(key)) {
        seen.set(key, { ...r, source: 'local' });
      }
    }

    // Remotos (só se novo)
    for (const r of remote) {
      const key = r.peer?.nodeId || r.nodeId;
      if (key && !seen.has(key)) {
        seen.set(key, { ...r, source: 'remote' });
      }
    }

    return [...seen.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  /**
   * Relay: executa uma task em nome de outro nó via hub intermediário.
   *
   * @param {string} targetNodeId — peer destino
   * @param {string} prompt — prompt a enviar
   * @param {object} [options] — opções do sendPrompt
   * @returns {Promise<object>} resultado do sendPrompt
   */
  async relay(targetNodeId, prompt, options = {}) {
    if (!this._checkRateLimit('relay')) {
      throw new Error('Rate limit excedido para relays');
    }

    const peer = this._mesh.registry.get(targetNodeId);

    // Caso 1: peer direto — sem relay necessário
    if (peer?.endpoint || peer?.metadata?.token) {
      return this._mesh.sendPrompt(targetNodeId, prompt, options);
    }

    // Caso 2: peer descoberto via outro nó — relay pelo intermediário
    const via = peer?.metadata?.discoveredVia;
    if (via) {
      const hub = this._mesh.registry.get(via);
      if (hub?.endpoint) {
        return this._relayViaHub(hub, targetNodeId, prompt, options);
      }
    }

    // Caso 3: buscar rota na rede
    const searchResult = await this.query(options.skill || 'chat');
    const match = searchResult.results.find(r =>
      (r.peer?.nodeId || r.nodeId) === targetNodeId && r.via
    );

    if (match) {
      const hub = this._mesh.registry.get(match.via);
      if (hub?.endpoint) {
        return this._relayViaHub(hub, targetNodeId, prompt, options);
      }
    }

    throw new Error(`Sem rota para ${targetNodeId} — peer não alcançável diretamente nem via relay`);
  }

  /**
   * Executa relay via hub intermediário.
   * @private
   */
  async _relayViaHub(hub, targetNodeId, prompt, options = {}) {
    const url = `${hub.endpoint.replace(/\/$/, '')}/api/network/relay`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._queryTimeout * 2);

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({
          targetNodeId,
          prompt,
          skill: options.skill || 'chat',
          originNode: this._mesh.nodeId,
        }),
      });

      if (!res.ok) {
        throw new Error(`Hub ${hub.name} retornou ${res.status}`);
      }

      const data = await res.json();
      return {
        method: 'relay',
        via: hub.nodeId,
        viaName: hub.name,
        response: data.response,
        model: data.model,
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  // ─── Rate Limiting ────────────────────────────────────────────────────

  /**
   * @private
   */
  _checkRateLimit(type) {
    const log = type === 'relay' ? this._relayLog : this._queryLog;
    const max = type === 'relay' ? this._rateLimit.maxRelays : this._rateLimit.maxQueries;
    const now = Date.now();

    // Limpar entradas velhas
    while (log.length > 0 && now - log[0] > this._rateLimit.windowMs) {
      log.shift();
    }

    if (log.length >= max) return false;

    log.push(now);
    return true;
  }

  /**
   * Limpa queries vistas (dedup) mais velhas que o TTL.
   * @private
   */
  _cleanupSeenQueries() {
    const now = Date.now();
    for (const [id, ts] of this._seenQueries) {
      if (now - ts > this._seenQueryTtl) {
        this._seenQueries.delete(id);
      }
    }
  }

  /**
   * Retorna estatísticas do rate limiter.
   */
  stats() {
    const now = Date.now();
    const recentQueries = this._queryLog.filter(t => now - t < this._rateLimit.windowMs).length;
    const recentRelays = this._relayLog.filter(t => now - t < this._rateLimit.windowMs).length;

    return {
      queries: { recent: recentQueries, max: this._rateLimit.maxQueries },
      relays: { recent: recentRelays, max: this._rateLimit.maxRelays },
      seenQueries: this._seenQueries.size,
    };
  }
}

module.exports = FederatedSearch;
