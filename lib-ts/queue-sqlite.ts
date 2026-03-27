// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const DEFAULT_MAX_RETRIES: number = parseInt(process.env.QUEUE_MAX_RETRIES || '5', 10);
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
  failedReason?: string;
  status?: string;
}

export interface MessageStats {
  pending: number;
  delivered: number;
  failed: number;
  expired: number;
}

export interface StorageBackend {
  getMessageStats(): MessageStats;
  insertMessage(item: QueueItem): void;
  getPendingMessages(): QueueItem[];
  markDelivered(id: string): void;
  markFailed(id: string, reason: string): void;
  markExpired(id: string): void;
  updateMessageRetry(id: string, attempts: number, nextRetry: string): void;
  getRecentMessages(status: string, limit: number): QueueItem[];
  searchMessages(query: string, limit: number): QueueItem[];
}

export type SendFn = (item: QueueItem) => Promise<void>;

export interface MessageQueueSQLiteOptions {
  storage?: StorageBackend;
  maxRetries?: number;
  sendFn?: SendFn | null;
}

export interface QueueSQLiteJSON {
  pending: QueueItem[];
  delivered: QueueItem[];
  failed: QueueItem[];
  stats: MessageStats;
}

export class MessageQueueSQLite extends EventEmitter {
  private _storage: StorageBackend | undefined;
  private _maxRetries: number;
  private _timer: ReturnType<typeof setInterval> | null;
  private _sendFn: SendFn | null;

  constructor(options: MessageQueueSQLiteOptions = {}) {
    super();
    this._storage = options.storage;
    this._maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
    this._timer = null;
    this._sendFn = options.sendFn || null;
  }

  setStorage(s: StorageBackend): void { this._storage = s; }

  get pending(): number { return this._storage ? this._storage.getMessageStats().pending : 0; }
  get delivered(): number { return this._storage ? this._storage.getMessageStats().delivered : 0; }
  get failed(): number { return this._storage ? this._storage.getMessageStats().failed : 0; }

  enqueue(message: QueueMessage, destination: string, channel: string | null): QueueItem {
    if (!this._storage) throw new Error('Storage não inicializado');
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
    this._storage.insertMessage(item);
    this.emit('enqueued', item);
    return item;
  }

  async process(): Promise<void> {
    if (!this._storage) return;
    const now = new Date();
    const pending = this._storage.getPendingMessages();
    for (const item of pending) {
      if (new Date(item.expiresAt) < now) {
        this._storage.markExpired(item.id);
        this.emit('expired', item);
        continue;
      }
      if (new Date(item.nextRetry) > now) continue;
      if (!this._sendFn) continue;
      item.attempts++;
      try {
        await this._sendFn(item);
        this._storage.markDelivered(item.id);
        this.emit('delivered', item);
      } catch (err) {
        const error = err as Error;
        if (item.attempts >= this._maxRetries) {
          this._storage.markFailed(item.id, error.message);
          this.emit('failed', item);
        } else {
          const delay = INITIAL_DELAY * Math.pow(2, item.attempts - 1);
          const nextRetry = new Date(Date.now() + delay).toISOString();
          this._storage.updateMessageRetry(item.id, item.attempts, nextRetry);
          this.emit('retry', { item, delay, error: error.message });
        }
      }
    }
  }

  start(intervalMs: number = 5000): void {
    if (this._timer) return;
    this._timer = setInterval(() => this.process(), intervalMs);
    console.log(`[queue-sqlite] Processando a cada ${intervalMs / 1000}s`);
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  toJSON(): QueueSQLiteJSON {
    if (!this._storage) return { pending: [], delivered: [], failed: [], stats: { pending: 0, delivered: 0, failed: 0, expired: 0 } };
    const stats = this._storage.getMessageStats();
    return {
      pending: this._storage.getRecentMessages('pending', 20),
      delivered: this._storage.getRecentMessages('delivered', 20),
      failed: this._storage.getRecentMessages('failed', 20),
      stats,
    };
  }

  search(query: string, limit?: number): QueueItem[] {
    if (!this._storage) return [];
    return this._storage.searchMessages(query, limit ?? 50);
  }
}

export default MessageQueueSQLite;
