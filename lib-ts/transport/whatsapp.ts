// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { Transport } from './transport-base.js';
import type { TransportConfig } from './transport-base.js';

type McpToolCaller = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

export interface WhatsAppTransportConfig extends TransportConfig {
  callMcpTool: McpToolCaller;
  groups?: string[];
}

export interface BroadcastResult {
  group: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export class WhatsAppTransport extends Transport {
  private _callMcp: McpToolCaller;
  private _groups: string[];

  constructor(config: WhatsAppTransportConfig) {
    super('whatsapp', { enabled: true, priority: 1, ...config });
    this._callMcp = config.callMcpTool;
    if (!this._callMcp) {
      throw new Error('WhatsAppTransport requer config.callMcpTool');
    }
    this._groups = config.groups ?? [];
  }

  async send(destination: string, message: unknown): Promise<unknown> {
    try {
      const text = typeof message === 'string' ? message : JSON.stringify(message);
      const result = await this._callMcp('send_whatsapp', {
        phone: destination,
        message: text,
      });
      this._countSent();
      this._markAvailable(true);
      this.emit('sent', { destination, message });
      return result;
    } catch (err) {
      this._countError();
      this._markAvailable(false);
      this.emit('error', err);
      throw err;
    }
  }

  async receive(source: string, options: { limit?: number } = {}): Promise<unknown> {
    try {
      const args: Record<string, unknown> = {};
      if (source) args.phone = source;
      if (options.limit) args.limit = options.limit;
      const result = await this._callMcp('get_whatsapp_history', args);
      this._countReceived();
      this._markAvailable(true);
      return result;
    } catch (err) {
      this._countError();
      this._markAvailable(false);
      throw err;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; channel: string; error?: string }> {
    try {
      await this._callMcp('get_status', {});
      this._markAvailable(true);
      return { ok: true, channel: 'whatsapp' };
    } catch (err) {
      this._markAvailable(false);
      return { ok: false, channel: 'whatsapp', error: (err as Error).message };
    }
  }

  async broadcast(message: unknown): Promise<BroadcastResult[]> {
    const results: BroadcastResult[] = [];
    for (const group of this._groups) {
      try {
        const r = await this.send(group, message);
        results.push({ group, ok: true, result: r });
      } catch (err) {
        results.push({ group, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }
}

export default WhatsAppTransport;
