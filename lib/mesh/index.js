'use strict';

const { EventEmitter } = require('events');
const PeerRegistry = require('./registry');
const protocol = require('../protocol');

/**
 * MeshManager — orquestra descoberta P2P e comunicação entre agentes Tulipa.
 *
 * Fluxo:
 *   1. Envia DISCOVER broadcast via router
 *   2. Peers respondem com ANNOUNCE
 *   3. Registry mantém mapa atualizado
 *   4. PING/PONG periódico mantém heartbeat
 *   5. Mensagens entre peers via send_prompt do gateway
 */
class MeshManager extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.router - Router instance (para enviar mensagens)
   * @param {function} options.callMcpTool - função para chamar MCP tools
   * @param {object} options.registryOptions - opções do PeerRegistry
   * @param {number} options.discoveryInterval - ms entre discovery broadcasts (default 2min)
   * @param {number} options.heartbeatInterval - ms entre heartbeats (default 1min)
   */
  constructor(options = {}) {
    super();
    this._router = options.router || null;
    this._callMcpTool = options.callMcpTool || null;
    this._fetch = options.fetch || null; // custom fetch (ex: proxy)
    this.registry = new PeerRegistry(options.registryOptions || {});
    this._discoveryInterval = options.discoveryInterval || 2 * 60 * 1000;
    this._heartbeatInterval = options.heartbeatInterval || 60 * 1000;
    this._discoveryTimer = null;
    this._heartbeatTimer = null;
    this._running = false;

    // Propaga eventos do registry
    for (const evt of ['peer-joined', 'peer-left', 'peer-stale', 'peer-updated']) {
      this.registry.on(evt, (peer) => this.emit(evt, peer));
    }
  }

  get nodeId() {
    return protocol.NODE_ID;
  }

  get nodeName() {
    return protocol.NODE_NAME;
  }

  /**
   * Inicia o mesh: discovery + heartbeat + sweep.
   */
  async start() {
    if (this._running) return;
    this._running = true;
    console.log(`[mesh] Iniciando mesh como ${this.nodeName} (${this.nodeId})`);

    this.registry.startSweep();

    // Discovery inicial
    await this.discover().catch(err =>
      console.error(`[mesh] Erro no discovery inicial: ${err.message}`)
    );

    // Discovery periódico
    this._discoveryTimer = setInterval(() => {
      this.discover().catch(err =>
        console.error(`[mesh] Erro no discovery: ${err.message}`)
      );
    }, this._discoveryInterval);

    // Heartbeat periódico
    this._heartbeatTimer = setInterval(() => {
      this.heartbeatAll().catch(err =>
        console.error(`[mesh] Erro no heartbeat: ${err.message}`)
      );
    }, this._heartbeatInterval);

    this.emit('started');
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._discoveryTimer);
    clearInterval(this._heartbeatTimer);
    this.registry.stopSweep();
    this._discoveryTimer = null;
    this._heartbeatTimer = null;
    console.log('[mesh] Mesh parado');
    this.emit('stopped');
  }

  /**
   * Descobre peers via MCP gateway (list_peers).
   */
  async discover() {
    if (!this._callMcpTool) return [];

    try {
      const result = await this._callMcpTool('list_peers', {});
      const peers = this._parsePeersResult(result);

      for (const p of peers) {
        // Não registra a si mesmo
        if (p.nodeId === this.nodeId) continue;
        this.registry.upsert(p.nodeId, p);
      }

      // Broadcast DISCOVER para que peers respondam com ANNOUNCE
      if (this._router) {
        const channels = this._getOwnChannels();
        const discoverMsg = protocol.discover(['hub', 'relay'], { channel: 'mesh' });
        const announceMsg = protocol.announce(['hub', 'relay'], channels, { channel: 'mesh' });

        // Anuncia a si mesmo via broadcast
        try {
          await this._router.broadcast(protocol.serialize(announceMsg));
        } catch {
          // Broadcast é best-effort
        }
      }

      this.emit('discovery-complete', { found: peers.length });
      return peers;
    } catch (err) {
      this.emit('discovery-error', err);
      throw err;
    }
  }

  /**
   * Envia PING para todos os peers online e mede latência.
   */
  async heartbeatAll() {
    const peers = this.registry.online();
    const results = [];

    for (const peer of peers) {
      try {
        const start = Date.now();
        await this.pingPeer(peer.nodeId);
        const latency = Date.now() - start;
        this.registry.upsert(peer.nodeId, { latency });
        results.push({ nodeId: peer.nodeId, ok: true, latency });
      } catch (err) {
        results.push({ nodeId: peer.nodeId, ok: false, error: err.message });
      }
    }

    this.emit('heartbeat-complete', results);
    return results;
  }

  /**
   * Envia mensagem para um peer.
   * Estratégia: endpoint HTTP direto > WhatsApp relay via router.
   */
  async _sendToPeerRaw(nodeId, content) {
    const peer = this.registry.get(nodeId);

    // 1. Endpoint HTTP direto (peer tem URL pública)
    if (peer?.endpoint) {
      try {
        const res = await (this._fetch || globalThis.fetch)(`${peer.endpoint}/api/mesh/incoming`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(peer.metadata?.remoteToken ? { 'Authorization': `Bearer ${peer.metadata.remoteToken}` } : {}),
          },
          body: JSON.stringify({ from: this.nodeId, message: content }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { method: 'http', result: await res.json() };
      } catch (err) {
        console.log(`[mesh] HTTP para ${peer.name} falhou: ${err.message}, tentando relay...`);
      }
    }

    // 2. Relay via router (WhatsApp, Telegram, etc.)
    if (this._router) {
      const result = await this._router.send(nodeId, content);
      return { method: 'relay', result };
    }

    throw new Error(`Sem rota para peer ${nodeId} (sem endpoint HTTP nem router)`);
  }

  /**
   * Ping um peer específico.
   */
  async pingPeer(nodeId) {
    const pingMsg = protocol.ping({ nodeId });
    const result = await this._sendToPeerRaw(nodeId, protocol.serialize(pingMsg));
    this.registry.touch(nodeId);
    return result;
  }

  /**
   * Envia mensagem para um peer.
   */
  async sendToPeer(nodeId, text) {
    const peer = this.registry.get(nodeId);
    const message = protocol.msg(text, { nodeId, name: peer?.name || nodeId });
    const result = await this._sendToPeerRaw(nodeId, protocol.serialize(message));
    this.emit('message-sent', { to: nodeId, messageId: message.id });
    return result;
  }

  /**
   * Processa mensagem recebida de outro peer.
   */
  handleMessage(raw) {
    const message = protocol.parse(raw);
    if (!message) return null;

    // Atualiza registry com atividade do peer
    if (message.from?.nodeId && message.from.nodeId !== this.nodeId) {
      this.registry.touch(message.from.nodeId);
    }

    switch (message.type) {
      case 'PING':
        this._handlePing(message);
        break;
      case 'PONG':
        this.emit('pong', message);
        break;
      case 'DISCOVER':
        this._handleDiscover(message);
        break;
      case 'ANNOUNCE':
        this._handleAnnounce(message);
        break;
      case 'MSG':
        this.emit('peer-message', message);
        break;
      case 'CMD':
        this.emit('peer-command', message);
        break;
      default:
        this.emit('peer-event', message);
    }

    return message;
  }

  _handlePing(message) {
    if (!message.from?.nodeId) return;

    const pongMsg = protocol.pong(message.id, message.from);
    this._sendToPeerRaw(message.from.nodeId, protocol.serialize(pongMsg))
      .catch(() => {});
  }

  _handleDiscover(message) {
    if (!message.from?.nodeId) return;

    // Registra quem pediu discovery
    this.registry.upsert(message.from.nodeId, {
      name: message.from.name,
      capabilities: message.payload?.capabilities || [],
    });

    // Responde com ANNOUNCE
    const channels = this._getOwnChannels();
    const announceMsg = protocol.announce(['hub', 'relay'], channels, {
      replyTo: message.id,
    });

    this._sendToPeerRaw(message.from.nodeId, protocol.serialize(announceMsg))
      .catch(() => {});
  }

  _handleAnnounce(message) {
    if (!message.from?.nodeId) return;

    this.registry.upsert(message.from.nodeId, {
      name: message.from.name,
      capabilities: message.payload?.capabilities || [],
      channels: message.payload?.channels || [],
    });
  }

  _getOwnChannels() {
    if (!this._router) return [];
    return this._router.available().map(t => t.name);
  }

  _parsePeersResult(result) {
    // Extrai array bruto do resultado MCP (pode vir em vários formatos)
    let raw = [];

    if (Array.isArray(result)) {
      raw = result;
    } else if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        raw = Array.isArray(parsed) ? parsed : parsed.peers || parsed.agents || [];
      } catch { return []; }
    } else if (result?.peers || result?.agents) {
      raw = result.peers || result.agents || [];
    } else if (result?.content) {
      try {
        const text = typeof result.content === 'string'
          ? result.content
          : result.content[0]?.text || '';
        const parsed = JSON.parse(text);
        raw = Array.isArray(parsed) ? parsed : parsed.peers || parsed.agents || [];
      } catch { return []; }
    }

    // Normaliza campos do gateway → formato interno do registry
    // Gateway usa: identityId, agentId, agent_id, id — mapeia para nodeId
    return raw.map(p => ({
      nodeId: p.nodeId || p.identityId || p.agentId || p.agent_id || p.id || null,
      name: p.name || p.agentName || p.agent_name || 'unknown',
      capabilities: p.capabilities || p.caps || [],
      channels: p.channels || p.transports || [],
      endpoint: p.endpoint || p.url || null,
      metadata: {
        ...(p.metadata || {}),
        ...(p.token ? { token: p.token } : {}),
        ...(p.remoteToken ? { remoteToken: p.remoteToken } : {}),
        ...(p.publicKey ? { publicKey: p.publicKey } : {}),
        ...(p.reputation != null ? { reputation: p.reputation } : {}),
        ...(p.relation ? { relation: p.relation } : {}),
        ...(p.endorsed != null ? { endorsed: p.endorsed } : {}),
        ...(p.lastSeen ? { gatewayLastSeen: p.lastSeen } : {}),
      },
    })).filter(p => p.nodeId); // descarta peers sem ID
  }

  toJSON() {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      running: this._running,
      registry: this.registry.toJSON(),
    };
  }
}

module.exports = MeshManager;
