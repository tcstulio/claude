'use strict';

const { EventEmitter } = require('events');

class Router extends EventEmitter {
  constructor(options = {}) {
    super();
    this._transports = new Map(); // name -> Transport instance
    this._queue = options.queue || null;
  }

  register(transport) {
    this._transports.set(transport.name, transport);
    console.log(`[router] Transport registrado: ${transport.name} (prioridade ${transport.priority})`);
    return this;
  }

  unregister(name) {
    this._transports.delete(name);
    return this;
  }

  get(name) {
    return this._transports.get(name);
  }

  // Retorna transports ordenados por prioridade (menor = preferido)
  _sorted() {
    return [...this._transports.values()]
      .filter(t => t.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  // Retorna transports disponíveis (enabled + health ok)
  available() {
    return this._sorted().filter(t => t.available);
  }

  /**
   * Envia mensagem tentando canais em ordem de prioridade.
   * Se todos falharem e há queue, enfileira.
   *
   * @param {string} destination - destinatário (telefone, chatId, etc)
   * @param {object|string} message - mensagem (protocolo ou texto)
   * @param {object} options
   * @param {string} options.preferChannel - tentar este canal primeiro
   * @returns {{ ok, channel, result?, error?, queued? }}
   */
  async send(destination, message, options = {}) {
    const transports = this._sorted();
    if (transports.length === 0) {
      return { ok: false, error: 'Nenhum transport registrado' };
    }

    // Se tem canal preferido, coloca ele primeiro
    if (options.preferChannel) {
      const idx = transports.findIndex(t => t.name === options.preferChannel);
      if (idx > 0) {
        const [preferred] = transports.splice(idx, 1);
        transports.unshift(preferred);
      }
    }

    const errors = [];

    for (const transport of transports) {
      try {
        const result = await transport.send(destination, message);
        this.emit('sent', { channel: transport.name, destination });
        return { ok: true, channel: transport.name, result };
      } catch (err) {
        errors.push({ channel: transport.name, error: err.message });
        this.emit('channel-failed', { channel: transport.name, error: err.message });
      }
    }

    // Todos falharam — enfileira se possível (exceto mensagens de protocolo mesh)
    if (this._queue && !this._isMeshProtocol(message)) {
      const item = this._queue.enqueue(message, destination, null);
      this.emit('queued', { destination, id: item.id });
      return { ok: false, queued: true, id: item.id, errors };
    }

    return { ok: false, errors };
  }

  async broadcast(message, options = {}) {
    const results = [];
    for (const transport of this._sorted()) {
      if (typeof transport.broadcast === 'function') {
        try {
          const r = await transport.broadcast(message);
          results.push({ channel: transport.name, ok: true, result: r });
        } catch (err) {
          results.push({ channel: transport.name, ok: false, error: err.message });
        }
      }
    }
    return results;
  }

  async healthCheckAll() {
    const results = {};
    for (const [name, transport] of this._transports) {
      results[name] = await transport.healthCheck();
    }
    return results;
  }

  _isMeshProtocol(message) {
    const MESH_TYPES = ['PING', 'PONG', 'DISCOVER', 'ANNOUNCE'];
    if (typeof message === 'string') {
      try { message = JSON.parse(message); } catch { return false; }
    }
    return message?.v === 1 && MESH_TYPES.includes(message?.type);
  }

  toJSON() {
    const transports = {};
    for (const [name, transport] of this._transports) {
      transports[name] = transport.toJSON();
    }
    return { transports, queueStats: this._queue?.toJSON()?.stats || null };
  }
}

module.exports = Router;
