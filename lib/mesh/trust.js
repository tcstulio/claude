'use strict';

/**
 * TrustGraph — grafo de confiança entre agentes Tulipa.
 *
 * Modelo:
 *   - Trust direto: baseado em interações (receipts, uptime, reputation do gateway)
 *   - Trust transitivo: trust(A→C) = trust(A→B) × trust(B→C) × DECAY
 *   - Ranking: trust × reputation × saldo positivo → score de delegação
 *
 * Trust score: 0.0 a 1.0
 *   - 0.0 = desconhecido / não confiável
 *   - 0.3 = threshold mínimo para delegação
 *   - 0.5 = peer novo com reputation base
 *   - 0.8 = peer confiável com histórico
 *   - 1.0 = máxima confiança (owner / self)
 */

const DEFAULT_TRUST = 0.5;          // Trust inicial para peers novos
const TRANSITIVE_DECAY = 0.7;       // Decay por hop no trust transitivo
const DELEGATION_THRESHOLD = 0.3;   // Mínimo para delegar task
const MAX_HOPS = 3;                 // Máximo de hops para trust transitivo
const REPUTATION_WEIGHT = 0.3;      // Peso da reputation do gateway no score
const INTERACTION_WEIGHT = 0.4;     // Peso das interações (receipts) no score
const BASE_WEIGHT = 0.3;            // Peso do trust base (endorsed, etc)

class TrustGraph {
  /**
   * @param {object} options
   * @param {string} options.nodeId — nosso agent ID
   * @param {number} [options.defaultTrust] — trust inicial (default 0.5)
   * @param {number} [options.transitiveDecay] — decay por hop (default 0.7)
   * @param {number} [options.delegationThreshold] — mínimo para delegar (default 0.3)
   * @param {number} [options.maxHops] — máximo de hops transitivos (default 3)
   */
  constructor(options = {}) {
    this.nodeId = options.nodeId;
    this._defaultTrust = options.defaultTrust ?? DEFAULT_TRUST;
    this._transitiveDecay = options.transitiveDecay ?? TRANSITIVE_DECAY;
    this._delegationThreshold = options.delegationThreshold ?? DELEGATION_THRESHOLD;
    this._maxHops = options.maxHops ?? MAX_HOPS;

    // Trust direto: { peerId: { score, reason, updatedAt } }
    this._directTrust = new Map();

    // Cache de trust transitivo: { peerId: { score, path, ttl } }
    this._transitiveCache = new Map();
    this._cacheTtl = options.cacheTtl || 5 * 60 * 1000; // 5 min
  }

  /**
   * Define trust direto com um peer.
   * @param {string} peerId
   * @param {number} score — 0.0 a 1.0
   * @param {string} [reason]
   */
  setDirectTrust(peerId, score, reason = 'manual') {
    this._directTrust.set(peerId, {
      score: Math.max(0, Math.min(1, score)),
      reason,
      updatedAt: Date.now(),
    });
    // Invalidar cache transitivo que passa por esse peer
    this._invalidateCacheFor(peerId);
  }

  /**
   * Retorna trust direto com um peer.
   * @param {string} peerId
   * @returns {number} score (0.0 a 1.0)
   */
  getDirectTrust(peerId) {
    return this._directTrust.get(peerId)?.score ?? null;
  }

  /**
   * Calcula trust com base em dados do peer (reputation, endorsed, interações).
   *
   * @param {object} peer — peer do registry
   * @param {object} [interactions] — { receiptsCount, successRate, avgLatency }
   * @returns {number} score composto (0.0 a 1.0)
   */
  computeTrust(peer, interactions = {}) {
    // 1. Trust base: endorsed, relation
    let baseTrust = this._defaultTrust;
    if (peer.metadata?.endorsed) baseTrust = Math.max(baseTrust, 0.6);
    if (peer.metadata?.relation === 'owner') baseTrust = 1.0;

    // 2. Reputation do gateway (normalizada 0-100 → 0-1)
    const reputation = (peer.metadata?.reputation ?? 50) / 100;

    // 3. Trust por interações (receipts)
    let interactionTrust = 0.5; // neutro
    if (interactions.receiptsCount > 0) {
      const successFactor = interactions.successRate ?? 1.0;
      const volumeFactor = Math.min(1, interactions.receiptsCount / 20); // satura em 20
      interactionTrust = successFactor * 0.7 + volumeFactor * 0.3;
    }

    // Score composto
    const score = (baseTrust * BASE_WEIGHT) +
                  (reputation * REPUTATION_WEIGHT) +
                  (interactionTrust * INTERACTION_WEIGHT);

    return Math.max(0, Math.min(1, score));
  }

  /**
   * Atualiza trust de um peer com base nos dados atuais.
   *
   * @param {object} peer — peer do registry
   * @param {object} [interactions]
   * @returns {number} novo score
   */
  updateTrust(peer, interactions = {}) {
    const score = this.computeTrust(peer, interactions);
    this.setDirectTrust(peer.nodeId, score, 'computed');
    return score;
  }

  /**
   * Calcula trust transitivo: A→C via intermediários.
   *
   * Fórmula: trust(A→C) = max(trust(A→B) × trust(B→C) × decay) para todos caminhos
   *
   * @param {string} targetId — peer destino
   * @param {function} getNeighborTrust — (peerId) => Map<neighborId, trustScore>
   * @returns {{ score: number, path: string[], hops: number }}
   */
  getTransitiveTrust(targetId, getNeighborTrust) {
    // Trust direto é o melhor caso
    const direct = this.getDirectTrust(targetId);
    if (direct !== null) {
      return { score: direct, path: [this.nodeId, targetId], hops: 0 };
    }

    // Checar cache
    const cached = this._transitiveCache.get(targetId);
    if (cached && Date.now() - cached.timestamp < this._cacheTtl) {
      return { score: cached.score, path: cached.path, hops: cached.path.length - 1 };
    }

    // BFS para encontrar melhor caminho
    const result = this._bfsTrust(targetId, getNeighborTrust);

    // Cachear resultado
    this._transitiveCache.set(targetId, {
      ...result,
      timestamp: Date.now(),
    });

    return { score: result.score, path: result.path, hops: result.path.length - 1 };
  }

  /**
   * BFS: encontra o caminho com maior trust transitivo.
   * @private
   */
  _bfsTrust(targetId, getNeighborTrust) {
    // Queue: [{ nodeId, trustSoFar, path }]
    const queue = [];
    const visited = new Set([this.nodeId]);
    let bestScore = 0;
    let bestPath = [];

    // Seed: nossos vizinhos diretos
    for (const [peerId, entry] of this._directTrust) {
      if (peerId === targetId) {
        return { score: entry.score, path: [this.nodeId, targetId] };
      }
      queue.push({
        nodeId: peerId,
        trustSoFar: entry.score,
        path: [this.nodeId, peerId],
      });
    }

    while (queue.length > 0) {
      const current = queue.shift();

      if (current.path.length - 1 >= this._maxHops) continue;
      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);

      // Pedir os vizinhos deste nó
      const neighbors = getNeighborTrust(current.nodeId);
      if (!neighbors) continue;

      for (const [neighborId, neighborTrust] of neighbors) {
        if (visited.has(neighborId)) continue;

        const transitiveTrust = current.trustSoFar * neighborTrust * this._transitiveDecay;

        if (neighborId === targetId) {
          if (transitiveTrust > bestScore) {
            bestScore = transitiveTrust;
            bestPath = [...current.path, neighborId];
          }
          continue;
        }

        // Continuar BFS se o trust ainda é relevante
        if (transitiveTrust > this._delegationThreshold * 0.5) {
          queue.push({
            nodeId: neighborId,
            trustSoFar: transitiveTrust,
            path: [...current.path, neighborId],
          });
        }
      }
    }

    return { score: bestScore, path: bestPath };
  }

  /**
   * Ranking de peers para delegação de task.
   *
   * Score = trust × reputação × saldo_factor
   *
   * @param {Array} peers — lista de peers do registry
   * @param {object} options
   * @param {string} [options.skill] — filtrar por skill/capability
   * @param {object} [options.ledger] — Ledger instance para saldo
   * @param {function} [options.getNeighborTrust] — para trust transitivo
   * @returns {Array<{peer, score, trust, balance, eligible}>} — ordenado por score desc
   */
  rankForDelegation(peers, options = {}) {
    const { skill, ledger, getNeighborTrust } = options;

    return peers
      .map(peer => {
        // Trust: direto ou transitivo
        let trust;
        const directTrust = this.getDirectTrust(peer.nodeId);
        if (directTrust !== null) {
          trust = directTrust;
        } else if (getNeighborTrust) {
          trust = this.getTransitiveTrust(peer.nodeId, getNeighborTrust).score;
        } else {
          trust = this.computeTrust(peer);
        }

        // Saldo do peer no ledger (positivo = ele contribuiu mais)
        let balanceFactor = 1.0;
        if (ledger) {
          const peerBalance = ledger.getPeerBalance(peer.nodeId);
          // Peer com saldo positivo (nos devem) = prioridade ligeiramente menor
          // Peer com saldo negativo (devemos a eles) = prioridade ligeiramente maior
          balanceFactor = 1.0 + Math.tanh(-peerBalance / 50) * 0.2; // -0.2 a +0.2
        }

        // Capability match
        const hasSkill = !skill || (peer.capabilities || []).includes(skill);

        const score = trust * balanceFactor * (hasSkill ? 1.0 : 0.1);
        const eligible = score >= this._delegationThreshold && hasSkill;

        return {
          peer: { nodeId: peer.nodeId, name: peer.name },
          score: Math.round(score * 1000) / 1000,
          trust: Math.round(trust * 1000) / 1000,
          balanceFactor: Math.round(balanceFactor * 1000) / 1000,
          eligible,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Verifica se um peer é elegível para delegação.
   */
  canDelegate(peerId) {
    const trust = this.getDirectTrust(peerId);
    return trust !== null && trust >= this._delegationThreshold;
  }

  /**
   * Invalida cache transitivo que possa passar por um peer.
   * @private
   */
  _invalidateCacheFor(peerId) {
    for (const [key, cached] of this._transitiveCache) {
      if (cached.path && cached.path.includes(peerId)) {
        this._transitiveCache.delete(key);
      }
    }
  }

  /**
   * Retorna todos os trusts diretos.
   */
  getAllDirectTrust() {
    const result = {};
    for (const [peerId, entry] of this._directTrust) {
      result[peerId] = { score: entry.score, reason: entry.reason };
    }
    return result;
  }

  /**
   * Serializa para JSON.
   */
  toJSON() {
    return {
      nodeId: this.nodeId,
      config: {
        defaultTrust: this._defaultTrust,
        transitiveDecay: this._transitiveDecay,
        delegationThreshold: this._delegationThreshold,
        maxHops: this._maxHops,
      },
      directTrust: this.getAllDirectTrust(),
      cacheSize: this._transitiveCache.size,
    };
  }
}

module.exports = TrustGraph;
