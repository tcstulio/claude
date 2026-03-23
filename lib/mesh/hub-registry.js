'use strict';

const { EventEmitter } = require('events');

/**
 * HubRegistry — registro distribuído de todos os hubs na rede.
 *
 * Replicado entre hubs via gossip (piggybacked nos heartbeats).
 * Usa epoch monotônico para resolução de conflitos — epoch maior vence.
 *
 * Cada hub envia HUB_REGISTRY_SYNC periodicamente com seus entries.
 * O receptor faz merge (epoch mais alto ganha) e re-propaga mudanças.
 */

class HubRegistry extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} [options.heartbeatTimeout=90000] — ms até marcar suspect
   * @param {number} [options.deadTimeout=150000] — ms até marcar dead
   * @param {number} [options.maxHubs=20] — máximo de hubs no registry
   */
  constructor(options = {}) {
    super();
    this._hubs = new Map(); // nodeId → HubEntry
    this._epoch = 0;
    this._heartbeatTimeout = options.heartbeatTimeout || 90000;   // 1.5 min
    this._deadTimeout = options.deadTimeout || 150000;             // 2.5 min
    this._maxHubs = options.maxHubs || 20;
    this._checkTimer = null;
  }

  // ─── CRUD ───────────────────────────────────────────────────────────

  /**
   * Adiciona ou atualiza um hub no registry.
   * @param {string} nodeId
   * @param {object} entry — { name, endpoint, metrics, epoch, ... }
   * @returns {object} entry atualizado
   */
  upsert(nodeId, entry) {
    const existing = this._hubs.get(nodeId);

    // Se já existe e o entry remoto tem epoch menor, ignora
    if (existing && entry.epoch && existing.epoch > entry.epoch) {
      return existing;
    }

    const now = Date.now();
    const hub = {
      nodeId,
      name: entry.name || existing?.name || nodeId,
      endpoint: entry.endpoint || existing?.endpoint || null,
      state: entry.state || existing?.state || 'active',
      epoch: entry.epoch || (existing?.epoch || 0) + 1,
      promotedAt: entry.promotedAt || existing?.promotedAt || now,
      promotedBy: entry.promotedBy || existing?.promotedBy || null,
      metrics: { ...(existing?.metrics || {}), ...(entry.metrics || {}) },
      lastHeartbeat: entry.lastHeartbeat || now,
      consecutiveMisses: 0,
      region: entry.region || existing?.region || null,
      peerCount: entry.peerCount || existing?.peerCount || 0,
    };

    const isNew = !existing;
    this._hubs.set(nodeId, hub);
    this._epoch++;

    if (isNew) {
      this.emit('hub-added', hub);
    } else {
      this.emit('hub-updated', hub);
    }

    return hub;
  }

  /**
   * Remove um hub do registry.
   */
  remove(nodeId) {
    const hub = this._hubs.get(nodeId);
    if (!hub) return null;
    this._hubs.delete(nodeId);
    this._epoch++;
    this.emit('hub-removed', hub);
    return hub;
  }

  /** Retorna hub por ID */
  get(nodeId) {
    return this._hubs.get(nodeId) || null;
  }

  /** Retorna todos os hubs */
  list() {
    return Array.from(this._hubs.values());
  }

  /** Retorna apenas hubs ativos */
  getActive() {
    return this.list().filter(h => h.state === 'active');
  }

  /** Retorna hub mais próximo por latência */
  getNearestHub(excludeNodeId) {
    const active = this.getActive().filter(h => h.nodeId !== excludeNodeId);
    if (active.length === 0) return null;

    // Ordena por latência (se disponível) ou peerCount (menos ocupado)
    active.sort((a, b) => {
      const latA = a.metrics?.latency || Infinity;
      const latB = b.metrics?.latency || Infinity;
      if (latA !== latB) return latA - latB;
      return (a.peerCount || 0) - (b.peerCount || 0);
    });

    return active[0];
  }

  // ─── Heartbeat ──────────────────────────────────────────────────────

  /**
   * Processa heartbeat de um hub.
   */
  processHeartbeat(nodeId, metrics) {
    const hub = this._hubs.get(nodeId);
    if (!hub) {
      // Hub desconhecido enviou heartbeat — registra
      return this.upsert(nodeId, { metrics, state: 'active' });
    }

    hub.lastHeartbeat = Date.now();
    hub.consecutiveMisses = 0;
    hub.state = 'active';
    if (metrics) {
      hub.metrics = { ...hub.metrics, ...metrics };
      hub.peerCount = metrics.peerCount || hub.peerCount;
    }

    this.emit('hub-heartbeat', hub);
    return hub;
  }

  /**
   * Detecta hubs com heartbeats perdidos.
   * Deve ser chamado periodicamente.
   */
  detectFailures() {
    const now = Date.now();
    const failures = [];

    for (const hub of this._hubs.values()) {
      const elapsed = now - hub.lastHeartbeat;

      if (elapsed > this._deadTimeout && hub.state !== 'dead') {
        hub.state = 'dead';
        hub.consecutiveMisses++;
        this.emit('hub-dead', hub);
        failures.push({ nodeId: hub.nodeId, state: 'dead', elapsed });
      } else if (elapsed > this._heartbeatTimeout && hub.state === 'active') {
        hub.state = 'suspect';
        hub.consecutiveMisses++;
        this.emit('hub-suspect', hub);
        failures.push({ nodeId: hub.nodeId, state: 'suspect', elapsed });
      }
    }

    return failures;
  }

  // ─── Gossip Sync ────────────────────────────────────────────────────

  /**
   * Retorna payload para sync (enviar para outros hubs).
   */
  getSyncPayload() {
    return {
      hubs: this.list().map(h => ({
        nodeId: h.nodeId,
        name: h.name,
        endpoint: h.endpoint,
        state: h.state,
        epoch: h.epoch,
        promotedAt: h.promotedAt,
        metrics: h.metrics,
        peerCount: h.peerCount,
        region: h.region,
        lastHeartbeat: h.lastHeartbeat,
      })),
      epoch: this._epoch,
    };
  }

  /**
   * Aplica sync recebido de outro hub.
   * Merge baseado em epoch: entrada com epoch maior vence.
   * @returns {number} número de entries atualizados
   */
  applySync(remoteHubs, remoteEpoch) {
    let updated = 0;

    for (const remote of remoteHubs) {
      const local = this._hubs.get(remote.nodeId);

      if (!local) {
        // Hub novo que não conhecemos
        this._hubs.set(remote.nodeId, {
          ...remote,
          consecutiveMisses: 0,
        });
        updated++;
        this.emit('hub-added', this._hubs.get(remote.nodeId));
      } else if (remote.epoch > local.epoch) {
        // Remote tem versão mais nova
        this._hubs.set(remote.nodeId, {
          ...remote,
          consecutiveMisses: local.consecutiveMisses,
        });
        updated++;
        this.emit('hub-updated', this._hubs.get(remote.nodeId));
      }
    }

    // Remover hubs que estão mortos no remote mas ativos aqui
    // (Apenas se remote epoch é maior que o nosso)
    if (remoteEpoch > this._epoch) {
      const remoteIds = new Set(remoteHubs.map(h => h.nodeId));
      for (const [nodeId, hub] of this._hubs) {
        if (!remoteIds.has(nodeId) && hub.state === 'dead') {
          this._hubs.delete(nodeId);
          this.emit('hub-removed', hub);
          updated++;
        }
      }
      this._epoch = remoteEpoch;
    }

    if (updated > 0) {
      this.emit('registry-synced', { updated, remoteEpoch });
    }

    return updated;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  /** Inicia detecção periódica de falhas */
  startChecks(interval) {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(() => this.detectFailures(), interval || 30000);
  }

  /** Para detecção de falhas */
  stopChecks() {
    if (this._checkTimer) {
      clearInterval(this._checkTimer);
      this._checkTimer = null;
    }
  }

  // ─── Serialização ───────────────────────────────────────────────────

  toJSON() {
    return {
      hubs: this.list(),
      activeCount: this.getActive().length,
      totalCount: this._hubs.size,
      epoch: this._epoch,
    };
  }
}

module.exports = { HubRegistry };
