// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';

export interface TransportConfig {
  priority?: number;
  enabled?: boolean;
  [key: string]: unknown;
}

export interface TransportStats {
  sent: number;
  received: number;
  errors: number;
}

export interface TransportJSON {
  name: string;
  available: boolean;
  enabled: boolean;
  priority: number;
  lastSeen: string | null;
  stats: TransportStats;
}

export class Transport extends EventEmitter {
  protected _name: string;
  protected _config: TransportConfig;
  protected _available: boolean;
  protected _lastSeen: string | null;
  protected _stats: TransportStats;

  constructor(name: string, config: TransportConfig = {}) {
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

  get name(): string { return this._name; }
  get available(): boolean { return this._available; }
  get lastSeen(): string | null { return this._lastSeen; }
  get stats(): TransportStats { return { ...this._stats }; }
  get priority(): number { return this._config.priority ?? 99; }
  get enabled(): boolean { return this._config.enabled !== false; }

  async send(_destination: string, _message: unknown): Promise<unknown> {
    throw new Error(`${this._name}.send() não implementado`);
  }

  async receive(_source: string, _options: Record<string, unknown> = {}): Promise<unknown> {
    throw new Error(`${this._name}.receive() não implementado`);
  }

  async healthCheck(): Promise<{ ok: boolean; channel?: string; error?: string; [key: string]: unknown }> {
    throw new Error(`${this._name}.healthCheck() não implementado`);
  }

  protected _markActivity(): void {
    this._lastSeen = new Date().toISOString();
  }

  protected _markAvailable(ok: boolean): void {
    this._available = ok;
    if (ok) this._markActivity();
  }

  protected _countSent(): void { this._stats.sent++; }
  protected _countReceived(): void { this._stats.received++; }
  protected _countError(): void { this._stats.errors++; }

  toJSON(): TransportJSON {
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

export default Transport;
