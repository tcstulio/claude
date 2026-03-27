'use strict';

const { EventEmitter } = require('events');

/**
 * PeerRegistry — mantém o mapa de peers conhecidos na rede Tulipa.
 *
 * Cada peer é identificado por nodeId e contém:
 *   - name, capabilities, channels, lastSeen, status
 *
 * Peers que não respondem dentro do TTL são marcados como stale/offline.
 */
class PeerRegistry extends EventEmitter {
  /**
   * @param {object} options
   * @param {number} options.staleTtl - ms sem atividade para marcar stale (default 5min)
   * @param {number} options.deadTtl  - ms sem atividade para remover (default 15min)
   * @param {number} options.sweepInterval - ms entre varreduras (default 60s)
   */
  constructor(options = {}) {
    super();
    this._peers = new Map(); // nodeId -> PeerInfo
    this._staleTtl = options.staleTtl || 5 * 60 * 1000;
    this._deadTtl = options.deadTtl || 15 * 60 * 1000;
    this._sweepInterval = options.sweepInterval || 60 * 1000;
    this._sweepTimer = null;
  }

  /**
   * Registra ou atualiza um peer.
   * Emite 'peer-joined' se é novo, 'peer-updated' se existente.
   */
  upsert(nodeId, info = {}) {
    const existing = this._peers.get(nodeId);
    const now = Date.now();

    const peer = {
      nodeId,
      name: info.name || existing?.name || nodeId,
      capabilities: info.capabilities || existing?.capabilities || [],
      channels: info.channels || existing?.channels || [],
      endpoint: info.endpoint || existing?.endpoint || null,
      lastSeen: now,
      firstSeen: existing?.firstSeen || now,
      status: 'online',
      latency: info.latency ?? existing?.latency ?? null,
      platform: info.platform || existing?.platform || null,
      dataSources: info.dataSources || existing?.dataSources || [],
      metadata: { ...(existing?.metadata || {}), ...(info.metadata || {}) },
    };

    this._peers.set(nodeId, peer);

    if (!existing) {
      this.emit('peer-joined', peer);
      console.log(`[mesh] Peer entrou: ${peer.name} (${nodeId})`);
    } else {
      this.emit('peer-updated', peer);
    }
    return peer;
  }

  /**
   * Marca peer como visto agora (heartbeat).
   */
  touch(nodeId) {
    const peer = this._peers.get(nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.status = 'online';
    }
    return peer;
  }

  get(nodeId) {
    return this._peers.get(nodeId) || null;
  }

  has(nodeId) {
    return this._peers.has(nodeId);
  }

  remove(nodeId) {
    const peer = this._peers.get(nodeId);
    if (peer) {
      this._peers.delete(nodeId);
      this.emit('peer-left', peer);
      console.log(`[mesh] Peer saiu: ${peer.name} (${nodeId})`);
    }
    return !!peer;
  }

  /**
   * Lista todos os peers, opcionalmente filtrados por status.
   */
  list(filter) {
    let peers = [...this._peers.values()];
    if (filter?.status) peers = peers.filter(p => p.status === filter.status);
    if (filter?.capability) peers = peers.filter(p => p.capabilities.includes(filter.capability));
    if (filter?.dataSource) peers = peers.filter(p => (p.dataSources || []).some(ds => ds.name === filter.dataSource));
    if (filter?.platform) peers = peers.filter(p => p.platform === filter.platform);
    return peers;
  }

  get size() {
    return this._peers.size;
  }

  online() {
    return this.list({ status: 'online' });
  }

  /**
   * Encontra peers que suportam um canal específico (whatsapp, telegram, etc).
   */
  withChannel(channel) {
    return [...this._peers.values()].filter(p =>
      p.status === 'online' && p.channels.includes(channel)
    );
  }

  /**
   * Varredura periódica: marca stale e remove dead.
   */
  _sweep() {
    const now = Date.now();
    for (const [nodeId, peer] of this._peers) {
      const age = now - peer.lastSeen;

      if (age > this._deadTtl) {
        this.remove(nodeId);
      } else if (age > this._staleTtl && peer.status !== 'stale') {
        peer.status = 'stale';
        this.emit('peer-stale', peer);
        console.log(`[mesh] Peer stale: ${peer.name} (${nodeId})`);
      }
    }
  }

  startSweep() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this._sweep(), this._sweepInterval);
  }

  stopSweep() {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  toJSON() {
    return {
      count: this._peers.size,
      online: this.online().length,
      peers: [...this._peers.values()].map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        status: p.status,
        channels: p.channels,
        capabilities: p.capabilities,
        platform: p.platform,
        dataSources: p.dataSources,
        lastSeen: new Date(p.lastSeen).toISOString(),
        latency: p.latency,
      })),
    };
  }
}

module.exports = PeerRegistry;
