// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { Transport } from './transport-base.js';
import type { TransportConfig, TransportJSON } from './transport-base.js';

type FetchFn = typeof globalThis.fetch;

export interface EndpointConfig {
  url: string;
  headers?: Record<string, string>;
  method?: string;
  template?: ((message: unknown) => unknown) | null;
  format?: 'json' | 'text' | 'slack' | 'discord';
}

interface ResolvedEndpoint {
  url: string;
  headers: Record<string, string>;
  method: string;
  template: ((message: unknown) => unknown) | null;
  format: string;
}

export interface WebhookTransportConfig extends TransportConfig {
  fetch?: FetchFn;
  defaultEndpoint?: string;
  endpoints?: Record<string, EndpointConfig>;
}

export interface WebhookTransportJSON extends TransportJSON {
  configured: boolean;
  endpointCount: number;
  endpoints: Record<string, { url: string; method: string; format: string }>;
  defaultEndpoint: string | null;
}

export class WebhookTransport extends Transport {
  private _endpoints: Map<string, ResolvedEndpoint>;
  private _fetch: FetchFn;
  private _defaultEndpoint: string;

  constructor(config: WebhookTransportConfig = {}) {
    super('webhook', { enabled: true, priority: 4, ...config });
    this._endpoints = new Map();
    this._fetch = config.fetch ?? globalThis.fetch;
    this._defaultEndpoint = config.defaultEndpoint ?? process.env.WEBHOOK_DEFAULT ?? '';
    if (config.endpoints) {
      for (const [name, endpoint] of Object.entries(config.endpoints)) {
        this.addEndpoint(name, endpoint);
      }
    }
    const envUrl = process.env.WEBHOOK_URL;
    const envName = process.env.WEBHOOK_NAME ?? 'default';
    if (envUrl) {
      this.addEndpoint(envName, {
        url: envUrl,
        headers: process.env.WEBHOOK_HEADERS ? JSON.parse(process.env.WEBHOOK_HEADERS) as Record<string, string> : {},
      });
      if (!this._defaultEndpoint) this._defaultEndpoint = envName;
    }
    if (this._endpoints.size > 0) {
      this._markAvailable(true);
    }
  }

  get configured(): boolean { return this._endpoints.size > 0; }

  addEndpoint(name: string, endpoint: EndpointConfig): this {
    if (!endpoint?.url) throw new Error(`Endpoint "${name}" precisa de url`);
    this._endpoints.set(name, {
      url: endpoint.url,
      headers: endpoint.headers ?? {},
      method: endpoint.method ?? 'POST',
      template: endpoint.template ?? null,
      format: endpoint.format ?? 'json',
    });
    this._markAvailable(true);
    console.log(`[webhook] Endpoint registrado: ${name} → ${endpoint.url.slice(0, 50)}...`);
    return this;
  }

  removeEndpoint(name: string): this {
    this._endpoints.delete(name);
    if (this._endpoints.size === 0) this._markAvailable(false);
    return this;
  }

  listEndpoints(): Record<string, { url: string; method: string; format: string }> {
    const list: Record<string, { url: string; method: string; format: string }> = {};
    for (const [name, ep] of this._endpoints) {
      list[name] = { url: `${ep.url.slice(0, 30)}...`, method: ep.method, format: ep.format };
    }
    return list;
  }

  async send(destination: string, message: unknown): Promise<{ ok: boolean; endpoint: string; result: unknown }> {
    if (!this.configured) throw new Error('Webhook não configurado (sem endpoints)');
    const endpointName = destination || this._defaultEndpoint;
    let endpoint = this._endpoints.get(endpointName);
    if (!endpoint && destination?.startsWith('http')) {
      endpoint = { url: destination, headers: {}, method: 'POST', format: 'json', template: null };
    }
    if (!endpoint) {
      throw new Error(`Endpoint "${endpointName}" não encontrado. Disponíveis: ${[...this._endpoints.keys()].join(', ')}`);
    }
    try {
      const body = this._formatBody(message, endpoint);
      const headers: Record<string, string> = {
        'Content-Type': endpoint.format === 'text' ? 'text/plain' : 'application/json',
        ...endpoint.headers,
      };
      const res = await this._fetch(endpoint.url, {
        method: endpoint.method,
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Webhook ${endpointName} retornou ${res.status}: ${text.slice(0, 200)}`);
      }
      let result: unknown;
      const contentType = res.headers.get('content-type') ?? '';
      if (contentType.includes('json')) {
        result = await res.json();
      } else {
        result = await res.text();
      }
      this._countSent();
      this._markAvailable(true);
      this.emit('sent', { endpoint: endpointName, url: endpoint.url });
      return { ok: true, endpoint: endpointName, result };
    } catch (err) {
      this._countError();
      this.emit('error', err);
      throw err;
    }
  }

  async receive(_source?: string, _options: Record<string, unknown> = {}): Promise<unknown[]> { return []; }

  async healthCheck(): Promise<{ ok: boolean; channel: string; error?: string; endpoints?: Record<string, { ok: boolean; status?: number; error?: string }> }> {
    if (!this.configured) {
      return { ok: false, channel: 'webhook', error: 'Sem endpoints configurados' };
    }
    const results: Record<string, { ok: boolean; status?: number; error?: string }> = {};
    let allOk = true;
    for (const [name, ep] of this._endpoints) {
      try {
        const res = await this._fetch(ep.url, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
        results[name] = { ok: res.ok, status: res.status };
        if (!res.ok) allOk = false;
      } catch (err) {
        results[name] = { ok: false, error: (err as Error).message };
        allOk = false;
      }
    }
    this._markAvailable(allOk);
    return { ok: allOk, channel: 'webhook', endpoints: results };
  }

  async broadcast(message: unknown): Promise<Array<{ endpoint: string; ok: boolean; result?: unknown; error?: string }>> {
    const results: Array<{ endpoint: string; ok: boolean; result?: unknown; error?: string }> = [];
    for (const [name] of this._endpoints) {
      try {
        const r = await this.send(name, message);
        results.push({ endpoint: name, ok: true, result: r });
      } catch (err) {
        results.push({ endpoint: name, ok: false, error: (err as Error).message });
      }
    }
    return results;
  }

  private _formatBody(message: unknown, endpoint: ResolvedEndpoint): unknown {
    const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
    if (typeof endpoint.template === 'function') {
      return endpoint.template(message);
    }
    switch (endpoint.format) {
      case 'slack': return { text, unfurl_links: false };
      case 'discord': return { content: text.slice(0, 2000) };
      case 'text': return text;
      case 'json':
      default:
        if (typeof message === 'object' && message !== null && !Array.isArray(message)) {
          return { ...(message as Record<string, unknown>), _source: 'tulipa', _timestamp: new Date().toISOString() };
        }
        return { message: text, _source: 'tulipa', _timestamp: new Date().toISOString() };
    }
  }

  toJSON(): WebhookTransportJSON {
    return {
      ...super.toJSON(),
      configured: this.configured,
      endpointCount: this._endpoints.size,
      endpoints: this.listEndpoints(),
      defaultEndpoint: this._defaultEndpoint || null,
    };
  }
}

export default WebhookTransport;
