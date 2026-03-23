'use strict';

const { EventEmitter } = require('events');

class Transport extends EventEmitter {
  constructor(name, config = {}) {
    super();
    if (new.target === Transport) {
      throw new Error('Transport é uma classe abstrata — use uma implementação');
    }
    this._name = name;
    this._config = config;
    this._available = false;
    this._lastSeen = null;
    this._stats = { sent: 0, received: 0, errors: 0 };
  }

  get name() { return this._name; }
  get available() { return this._available; }
  get lastSeen() { return this._lastSeen; }
  get stats() { return { ...this._stats }; }
  get priority() { return this._config.priority || 99; }
  get enabled() { return this._config.enabled !== false; }

  // Subclasses devem implementar esses métodos
  async send(destination, message) {
    throw new Error(`${this._name}.send() não implementado`);
  }

  async receive(source, options = {}) {
    throw new Error(`${this._name}.receive() não implementado`);
  }

  async healthCheck() {
    throw new Error(`${this._name}.healthCheck() não implementado`);
  }

  // Helpers para subclasses
  _markActivity() {
    this._lastSeen = new Date().toISOString();
  }

  _markAvailable(ok) {
    this._available = ok;
    if (ok) this._markActivity();
  }

  _countSent() { this._stats.sent++; }
  _countReceived() { this._stats.received++; }
  _countError() { this._stats.errors++; }

  toJSON() {
    return {
      name: this._name,
      available: this._available,
      enabled: this.enabled,
      priority: this.priority,
      lastSeen: this._lastSeen,
      stats: this._stats,
    };
  }
}

module.exports = Transport;
