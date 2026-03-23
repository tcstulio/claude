'use strict';

const Transport = require('./base');

/**
 * WebhookTransport — envia mensagens via HTTP POST para qualquer endpoint.
 *
 * Funciona como conector genérico para Slack, Discord, n8n, Zapier,
 * ou qualquer serviço que aceite webhooks.
 *
 * Config:
 *   - endpoints: Map ou objeto { nome: { url, headers?, template? } }
 *   - fetch: fetch customizado (para proxy)
 *   - defaultEndpoint: nome do endpoint padrão
 */
class WebhookTransport extends Transport {
  /**
   * @param {object} config
   * @param {object} config.endpoints - { nome: { url, headers?, template? } }
   * @param {string} config.defaultEndpoint - nome do endpoint padrão
   * @param {function} config.fetch - fetch customizado
   */
  constructor(config = {}) {
    super('webhook', { enabled: true, priority: 4, ...config });
    this._endpoints = new Map();
    this._fetch = config.fetch || globalThis.fetch;
    this._defaultEndpoint = config.defaultEndpoint || process.env.WEBHOOK_DEFAULT || '';

    // Carrega endpoints da config
    if (config.endpoints) {
      for (const [name, endpoint] of Object.entries(config.endpoints)) {
        this.addEndpoint(name, endpoint);
      }
    }

    // Carrega endpoint de env var (WEBHOOK_URL + WEBHOOK_NAME)
    const envUrl = process.env.WEBHOOK_URL;
    const envName = process.env.WEBHOOK_NAME || 'default';
    if (envUrl) {
      this.addEndpoint(envName, {
        url: envUrl,
        headers: process.env.WEBHOOK_HEADERS ? JSON.parse(process.env.WEBHOOK_HEADERS) : {},
      });
      if (!this._defaultEndpoint) this._defaultEndpoint = envName;
    }

    if (this._endpoints.size > 0) {
      this._markAvailable(true);
    }
  }

  get configured() {
    return this._endpoints.size > 0;
  }

  /**
   * Adiciona um endpoint webhook.
   * @param {string} name - identificador (ex: 'slack', 'discord', 'n8n')
   * @param {object} endpoint
   * @param {string} endpoint.url - URL do webhook
   * @param {object} endpoint.headers - headers extras
   * @param {string} endpoint.method - HTTP method (default POST)
   * @param {function|object} endpoint.template - transforma mensagem antes de enviar
   */
  addEndpoint(name, endpoint) {
    if (!endpoint?.url) throw new Error(`Endpoint "${name}" precisa de url`);
    this._endpoints.set(name, {
      url: endpoint.url,
      headers: endpoint.headers || {},
      method: endpoint.method || 'POST',
      template: endpoint.template || null,
      format: endpoint.format || 'json', // 'json' | 'text' | 'slack' | 'discord'
    });
    this._markAvailable(true);
    console.log(`[webhook] Endpoint registrado: ${name} → ${endpoint.url.slice(0, 50)}...`);
    return this;
  }

  removeEndpoint(name) {
    this._endpoints.delete(name);
    if (this._endpoints.size === 0) this._markAvailable(false);
    return this;
  }

  listEndpoints() {
    const list = {};
    for (const [name, ep] of this._endpoints) {
      list[name] = {
        url: `${ep.url.slice(0, 30)}...`,
        method: ep.method,
        format: ep.format,
      };
    }
    return list;
  }

  /**
   * Envia mensagem para um endpoint.
   * @param {string} destination - nome do endpoint (ou URL direta)
   * @param {string|object} message - mensagem a enviar
   */
  async send(destination, message) {
    if (!this.configured) throw new Error('Webhook não configurado (sem endpoints)');

    const endpointName = destination || this._defaultEndpoint;
    let endpoint = this._endpoints.get(endpointName);

    // Se destination é uma URL direta, usa inline
    if (!endpoint && destination?.startsWith('http')) {
      endpoint = { url: destination, headers: {}, method: 'POST', format: 'json' };
    }

    if (!endpoint) {
      throw new Error(`Endpoint "${endpointName}" não encontrado. Disponíveis: ${[...this._endpoints.keys()].join(', ')}`);
    }

    try {
      const body = this._formatBody(message, endpoint);
      const headers = {
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

      let result;
      const contentType = res.headers.get('content-type') || '';
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

  async receive(_source, _options = {}) {
    // Webhooks são push-only por natureza. Para receber, use o endpoint HTTP do server.
    return [];
  }

  async healthCheck() {
    if (!this.configured) {
      return { ok: false, channel: 'webhook', error: 'Sem endpoints configurados' };
    }
    // Verifica se os endpoints são alcançáveis (HEAD request)
    const results = {};
    let allOk = true;

    for (const [name, ep] of this._endpoints) {
      try {
        const res = await this._fetch(ep.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(5000),
        });
        results[name] = { ok: res.ok, status: res.status };
        if (!res.ok) allOk = false;
      } catch (err) {
        results[name] = { ok: false, error: err.message };
        allOk = false;
      }
    }

    this._markAvailable(allOk);
    return { ok: allOk, channel: 'webhook', endpoints: results };
  }

  async broadcast(message) {
    const results = [];
    for (const [name] of this._endpoints) {
      try {
        const r = await this.send(name, message);
        results.push({ endpoint: name, ok: true, result: r });
      } catch (err) {
        results.push({ endpoint: name, ok: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * Formata o body conforme o format do endpoint.
   */
  _formatBody(message, endpoint) {
    const text = typeof message === 'string' ? message : JSON.stringify(message, null, 2);

    // Template customizado
    if (typeof endpoint.template === 'function') {
      return endpoint.template(message);
    }

    switch (endpoint.format) {
      case 'slack':
        return { text, unfurl_links: false };

      case 'discord':
        return { content: text.slice(0, 2000) };

      case 'text':
        return text;

      case 'json':
      default:
        if (typeof message === 'object' && !Array.isArray(message)) {
          return { ...message, _source: 'tulipa', _timestamp: new Date().toISOString() };
        }
        return { message: text, _source: 'tulipa', _timestamp: new Date().toISOString() };
    }
  }

  toJSON() {
    return {
      ...super.toJSON(),
      configured: this.configured,
      endpointCount: this._endpoints.size,
      endpoints: this.listEndpoints(),
      defaultEndpoint: this._defaultEndpoint || null,
    };
  }
}

module.exports = WebhookTransport;
