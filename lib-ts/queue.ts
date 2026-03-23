// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_PERSIST_PATH: string = process.env.QUEUE_PERSIST_PATH || './data/queue.json';
const DEFAULT_MAX_RETRIES: number = parseInt(process.env.QUEUE_MAX_RETRIES || '5', 10);
const DEFAULT_MAX_PENDING: number = parseInt(process.env.QUEUE_MAX_PENDING || '50', 10);
const MAX_HISTORY = 100;
const INITIAL_DELAY = 2000;

export interface QueueMessage {
  id?: string;
  ttl?: number;
  [key: string]: unknown;
}

export interface QueueItem {
  id: string;
  destination: string;
  channel: string | null;
  message: QueueMessage;
  attempts: number;
  lastAttempt: string | null;
  nextRetry: string;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
  reason?: string;
}

export type SendFn = (item: QueueItem) => Promise<void>;

export interface MessageQueueOptions {
  persistPath?: string;
  maxRetries?: number;
  maxPending?: number;
  sendFn?: SendFn | null;
}

export interface QueueJSON {
  pending: QueueItem[];
  delivered: QueueItem[];
  failed: QueueItem[];
  stats: { pending: number; delivered: number; failed: number };
}

export class MessageQueue extends EventEmitter {
  private _persistPath: string;
  private _maxRetries: number;
  private _maxPending: number;
  private _pending: QueueItem[];
  private _delivered: QueueItem[];
  private _failed: (QueueItem & { reason?: string })[];
  private _timer: ReturnType<typeof setInterval> | null;
  private _sendFn: SendFn | null;

  constructor(options: MessageQueueOptions = {}) {
    super();
    this._persistPath = options.persistPath || DEFAULT_PERSIST_PATH;
    this._maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this._maxPending = options.maxPending || DEFAULT_MAX_PENDING;
    this._pending = [];
    this._delivered = [];
    this._failed = [];
    this._timer = null;
    this._sendFn = options.sendFn || null;
    this._load();
  }

  get pending(): number { return this._pending.length; }
  get delivered(): number { return this._delivered.length; }
  get failed(): number { return this._failed.length; }

  enqueue(message: QueueMessage, destination: string, channel: string | null): QueueItem {
    const item: QueueItem = {
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
    while (this._pending.length >= this._maxPending) {
      const dropped = this._pending.shift()!;
      this._failed.push({ ...dropped, reason: 'queue_full' });
      if (this._failed.length > MAX_HISTORY) this._failed = this._failed.slice(-MAX_HISTORY);
      this.emit('dropped', dropped);
    }
    this._pending.push(item);
    this._persist();
    this.emit('enqueued', item);
    return item;
  }

  async process(): Promise<void> {
    const now = new Date();
    const ready = this._pending.filter(item => {
      if (new Date(item.expiresAt) < now) return false;
      if (new Date(item.nextRetry) > now) return false;
      return true;
    });
    const expired = this._pending.filter(item => new Date(item.expiresAt) < now);
    for (const item of expired) {
      this._pending = this._pending.filter(p => p.id !== item.id);
      this._failed.push({ ...item, reason: 'expired' });
      this.emit('expired', item);
    }
    if (expired.length > 0 && this._failed.length > MAX_HISTORY) {
      this._failed = this._failed.slice(-MAX_HISTORY);
    }
    if (!this._sendFn || ready.length === 0) return;
    for (const item of ready) {
      item.attempts++;
      item.lastAttempt = now.toISOString();
      try {
        await this._sendFn(item);
        this._pending = this._pending.filter(p => p.id !== item.id);
        this._delivered.push({ ...item, deliveredAt: now.toISOString() });
        if (this._delivered.length > MAX_HISTORY) this._delivered = this._delivered.slice(-MAX_HISTORY);
        this.emit('delivered', item);
      } catch (err) {
        const error = err as Error;
        if (item.attempts >= this._maxRetries) {
          this._pending = this._pending.filter(p => p.id !== item.id);
          this._failed.push({ ...item, reason: error.message });
          if (this._failed.length > MAX_HISTORY) this._failed = this._failed.slice(-MAX_HISTORY);
          this.emit('failed', item);
        } else {
          const delay = INITIAL_DELAY * Math.pow(2, item.attempts - 1);
          item.nextRetry = new Date(Date.now() + delay).toISOString();
          this.emit('retry', { item, delay, error: error.message });
        }
      }
    }
    this._persist();
  }

  start(intervalMs: number = 5000): void {
    if (this._timer) return;
    this._timer = setInterval(() => this.process(), intervalMs);
    console.log(`[queue] Processando a cada ${intervalMs / 1000}s`);
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  toJSON(): QueueJSON {
    return {
      pending: this._pending,
      delivered: this._delivered.slice(-20),
      failed: this._failed.slice(-20),
      stats: { pending: this._pending.length, delivered: this._delivered.length, failed: this._failed.length },
    };
  }

  private _persist(): void {
    try {
      const dir = path.dirname(this._persistPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._persistPath, JSON.stringify({
        pending: this._pending,
        delivered: this._delivered.slice(-100),
        failed: this._failed.slice(-100),
      }, null, 2));
    } catch (err) {
      const error = err as Error;
      console.error(`[queue] Erro ao persistir: ${error.message}`);
    }
  }

  private _load(): void {
    try {
      if (fs.existsSync(this._persistPath)) {
        const data = JSON.parse(fs.readFileSync(this._persistPath, 'utf-8')) as {
          pending?: QueueItem[];
          delivered?: QueueItem[];
          failed?: QueueItem[];
        };
        this._pending = data.pending || [];
        this._delivered = data.delivered || [];
        this._failed = data.failed || [];
        if (this._pending.length > 0) {
          console.log(`[queue] Carregadas ${this._pending.length} mensagens pendentes`);
        }
      }
    } catch (err) {
      const error = err as Error;
      console.error(`[queue] Erro ao carregar fila: ${error.message}`);
    }
  }
}

export default MessageQueue;
