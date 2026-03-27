// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';

export interface Transport {
  name: string;
  priority: number;
  enabled: boolean;
  available: boolean;
  send(destination: string, message: unknown): Promise<unknown>;
  broadcast?(message: unknown): Promise<unknown>;
  healthCheck(): Promise<TransportHealth>;
  toJSON(): Record<string, unknown>;
}

export interface TransportHealth {
  ok: boolean;
  [key: string]: unknown;
}

export interface SendOptions {
  preferChannel?: string;
}

export interface SendResult {
  ok: boolean;
  channel?: string;
  result?: unknown;
  queued?: boolean;
  id?: string;
  error?: string;
  errors?: Array<{ channel: string; error: string }>;
}

export interface BroadcastResult {
  channel: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface QueueLike {
  enqueue(message: unknown, destination: string, channel: string | null): { id: string };
  toJSON(): { stats?: Record<string, unknown> };
}

export interface RouterOptions {
  queue?: QueueLike | null;
}

interface MeshMessage {
  v?: number;
  type?: string;
  [key: string]: unknown;
}

export class Router extends EventEmitter {
  private _transports: Map<string, Transport>;
  private _queue: QueueLike | null;

  constructor(options: RouterOptions = {}) {
    super();
    this._transports = new Map();
    this._queue = options.queue || null;
  }

  register(transport: Transport): this {
    this._transports.set(transport.name, transport);
    console.log(`[router] Transport registrado: ${transport.name} (prioridade ${transport.priority})`);
    return this;
  }

  unregister(name: string): this { this._transports.delete(name); return this; }
  get(name: string): Transport | undefined { return this._transports.get(name); }

  private _sorted(): Transport[] {
    return [...this._transports.values()]
      .filter(t => t.enabled)
      .sort((a, b) => a.priority - b.priority);
  }

  available(): Transport[] {
    return this._sorted().filter(t => t.available);
  }

  async send(destination: string, message: unknown, options: SendOptions = {}): Promise<SendResult> {
    const transports = this._sorted();
    if (transports.length === 0) {
      return { ok: false, error: 'Nenhum transport registrado' };
    }
    if (options.preferChannel) {
      const idx = transports.findIndex(t => t.name === options.preferChannel);
      if (idx > 0) {
        const [preferred] = transports.splice(idx, 1);
        transports.unshift(preferred);
      }
    }
    const errors: Array<{ channel: string; error: string }> = [];
    for (const transport of transports) {
      try {
        const result = await transport.send(destination, message);
        this.emit('sent', { channel: transport.name, destination });
        return { ok: true, channel: transport.name, result };
      } catch (err) {
        const error = err as Error;
        errors.push({ channel: transport.name, error: error.message });
        this.emit('channel-failed', { channel: transport.name, error: error.message });
      }
    }
    if (this._queue && !this._isMeshProtocol(message)) {
      const item = this._queue.enqueue(message, destination, null);
      this.emit('queued', { destination, id: item.id });
      return { ok: false, queued: true, id: item.id, errors };
    }
    return { ok: false, errors };
  }

  async broadcast(message: unknown, _options: Record<string, unknown> = {}): Promise<BroadcastResult[]> {
    const results: BroadcastResult[] = [];
    for (const transport of this._sorted()) {
      if (typeof transport.broadcast === 'function') {
        try {
          const r = await transport.broadcast(message);
          results.push({ channel: transport.name, ok: true, result: r });
        } catch (err) {
          const error = err as Error;
          results.push({ channel: transport.name, ok: false, error: error.message });
        }
      }
    }
    return results;
  }

  async healthCheckAll(): Promise<Record<string, TransportHealth>> {
    const results: Record<string, TransportHealth> = {};
    for (const [name, transport] of this._transports) {
      results[name] = await transport.healthCheck();
    }
    return results;
  }

  private _isMeshProtocol(message: unknown): boolean {
    const MESH_TYPES = ['PING', 'PONG', 'DISCOVER', 'ANNOUNCE'];
    let msg = message as MeshMessage;
    if (typeof message === 'string') {
      try { msg = JSON.parse(message) as MeshMessage; } catch { return false; }
    }
    return msg?.v === 1 && MESH_TYPES.includes(msg?.type ?? '');
  }

  toJSON(): { transports: Record<string, Record<string, unknown>>; queueStats: Record<string, unknown> | null } {
    const transports: Record<string, Record<string, unknown>> = {};
    for (const [name, transport] of this._transports) {
      transports[name] = transport.toJSON();
    }
    return { transports, queueStats: this._queue?.toJSON()?.stats || null };
  }
}

export default Router;
