'use strict';

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const DEFAULT_PERSIST_PATH = process.env.QUEUE_PERSIST_PATH || './data/queue.json';
const DEFAULT_MAX_RETRIES = parseInt(process.env.QUEUE_MAX_RETRIES || '5', 10);
const INITIAL_DELAY = 2000; // 2s

class MessageQueue extends EventEmitter {
  constructor(options = {}) {
    super();
    this._persistPath = options.persistPath || DEFAULT_PERSIST_PATH;
    this._maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this._pending = [];
    this._delivered = [];
    this._failed = [];
    this._timer = null;
    this._sendFn = options.sendFn || null; // (item) => Promise<void>

    this._load();
  }

  get pending() { return this._pending.length; }
  get delivered() { return this._delivered.length; }
  get failed() { return this._failed.length; }

  enqueue(message, destination, channel) {
    const item = {
      id: message.id || require('crypto').randomUUID(),
      destination,
      channel,
      message,
      attempts: 0,
      lastAttempt: null,
      nextRetry: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + (message.ttl || 300) * 1000).toISOString(),
    };
    this._pending.push(item);
    this._persist();
    this.emit('enqueued', item);
    return item;
  }

  async process() {
    const now = new Date();
    const ready = this._pending.filter(item => {
      if (new Date(item.expiresAt) < now) return false; // expirou
      if (new Date(item.nextRetry) > now) return false; // ainda não é hora
      return true;
    });

    // Remove expirados
    const expired = this._pending.filter(item => new Date(item.expiresAt) < now);
    for (const item of expired) {
      this._pending = this._pending.filter(p => p.id !== item.id);
      this._failed.push({ ...item, reason: 'expired' });
      this.emit('expired', item);
    }

    if (!this._sendFn || ready.length === 0) return;

    for (const item of ready) {
      item.attempts++;
      item.lastAttempt = now.toISOString();

      try {
        await this._sendFn(item);
        this._pending = this._pending.filter(p => p.id !== item.id);
        this._delivered.push({ ...item, deliveredAt: now.toISOString() });
        this.emit('delivered', item);
      } catch (err) {
        if (item.attempts >= this._maxRetries) {
          this._pending = this._pending.filter(p => p.id !== item.id);
          this._failed.push({ ...item, reason: err.message });
          this.emit('failed', item);
        } else {
          // Backoff exponencial: 2s, 4s, 8s, 16s, 32s
          const delay = INITIAL_DELAY * Math.pow(2, item.attempts - 1);
          item.nextRetry = new Date(Date.now() + delay).toISOString();
          this.emit('retry', { item, delay, error: err.message });
        }
      }
    }

    this._persist();
  }

  start(intervalMs = 5000) {
    if (this._timer) return;
    this._timer = setInterval(() => this.process(), intervalMs);
    console.log(`[queue] Processando a cada ${intervalMs / 1000}s`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON() {
    return {
      pending: this._pending,
      delivered: this._delivered.slice(-20), // últimos 20
      failed: this._failed.slice(-20),
      stats: {
        pending: this._pending.length,
        delivered: this._delivered.length,
        failed: this._failed.length,
      },
    };
  }

  _persist() {
    try {
      const dir = path.dirname(this._persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._persistPath, JSON.stringify({
        pending: this._pending,
        delivered: this._delivered.slice(-100),
        failed: this._failed.slice(-100),
      }, null, 2));
    } catch (err) {
      console.error(`[queue] Erro ao persistir: ${err.message}`);
    }
  }

  _load() {
    try {
      if (fs.existsSync(this._persistPath)) {
        const data = JSON.parse(fs.readFileSync(this._persistPath, 'utf-8'));
        this._pending = data.pending || [];
        this._delivered = data.delivered || [];
        this._failed = data.failed || [];
        if (this._pending.length > 0) {
          console.log(`[queue] Carregadas ${this._pending.length} mensagens pendentes`);
        }
      }
    } catch (err) {
      console.error(`[queue] Erro ao carregar fila: ${err.message}`);
    }
  }
}

module.exports = MessageQueue;
