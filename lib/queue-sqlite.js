'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

const DEFAULT_MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || '5', 10);
const INITIAL_DELAY = 2000;

/**
 * MessageQueue backed by SQLite via Storage.
 * Drop-in replacement for the old JSON-based queue.
 */
class MessageQueueSQLite extends EventEmitter {
  constructor(options = {}) {
    super();
    this._storage = options.storage; // Storage instance (pode ser null se async init)
    this._maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this._timer = null;
    this._sendFn = options.sendFn || null;
  }

  /** Permite injetar storage depois da construção (para init async) */
  setStorage(s) { this._storage = s; }

  get pending() { return this._storage ? this._storage.getMessageStats().pending : 0; }
  get delivered() { return this._storage ? this._storage.getMessageStats().delivered : 0; }
  get failed() { return this._storage ? this._storage.getMessageStats().failed : 0; }

  enqueue(message, destination, channel) {
    if (!this._storage) throw new Error('Storage não inicializado');
    const item = {
      id: message.id || crypto.randomUUID(),
      destination,
      channel,
      message,
      attempts: 0,
      lastAttempt: null,
      nextRetry: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (message.ttl || 300) * 1000).toISOString(),
    };
    this._storage.insertMessage(item);
    this.emit('enqueued', item);
    return item;
  }

  async process() {
    if (!this._storage) return;
    const now = new Date();
    const pending = this._storage.getPendingMessages();

    for (const item of pending) {
      // Expirou
      if (new Date(item.expiresAt) < now) {
        this._storage.markExpired(item.id);
        this.emit('expired', item);
        continue;
      }

      // Ainda não é hora do retry
      if (new Date(item.nextRetry) > now) continue;

      if (!this._sendFn) continue;

      item.attempts++;

      try {
        await this._sendFn(item);
        this._storage.markDelivered(item.id);
        this.emit('delivered', item);
      } catch (err) {
        if (item.attempts >= this._maxRetries) {
          this._storage.markFailed(item.id, err.message);
          this.emit('failed', item);
        } else {
          const delay = INITIAL_DELAY * Math.pow(2, item.attempts - 1);
          const nextRetry = new Date(Date.now() + delay).toISOString();
          this._storage.updateMessageRetry(item.id, item.attempts, nextRetry);
          this.emit('retry', { item, delay, error: err.message });
        }
      }
    }
  }

  start(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.process(), intervalMs);
    console.log(`[queue-sqlite] Processando a cada ${intervalMs / 1000}s`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON() {
    if (!this._storage) return { pending: [], delivered: [], failed: [], stats: { pending: 0, delivered: 0, failed: 0, expired: 0 } };
    const stats = this._storage.getMessageStats();
    return {
      pending: this._storage.getRecentMessages('pending', 20),
      delivered: this._storage.getRecentMessages('delivered', 20),
      failed: this._storage.getRecentMessages('failed', 20),
      stats,
    };
  }

  search(query, limit) {
    if (!this._storage) return [];
    return this._storage.searchMessages(query, limit);
  }
}

module.exports = MessageQueueSQLite;
