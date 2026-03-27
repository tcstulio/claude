'use strict';

const { EventEmitter } = require('events');
const capabilitiesLib = require('./capabilities');

/**
 * DataSourceRegistry — catálogo de fontes de dados disponíveis neste nó.
 *
 * Diferente de capabilities (que são ações/ferramentas), data sources
 * representam informação que o nó pode fornecer à rede.
 *
 * Tipos:
 *   - realtime:    dados ao vivo (sensores, métricas, GPS)
 *   - historical:  dados armazenados (logs, histórico de mensagens)
 *   - computed:    dados derivados (relatórios, análises, agregações)
 */
class DataSourceRegistry extends EventEmitter {
  /**
   * @param {object} platformInfo — resultado de platformDetector.detect()
   */
  constructor(platformInfo = {}) {
    super();
    this._sources = new Map();
    this._platform = platformInfo.platform || 'unknown';

    // Registra fontes de dados detectadas automaticamente
    if (platformInfo.dataSources) {
      for (const ds of platformInfo.dataSources) {
        this.register(ds);
      }
    }
  }

  /**
   * Registra uma fonte de dados.
   * @param {object} source
   * @param {string} source.name — identificador único (ex: 'gps-location')
   * @param {string} source.type — 'realtime' | 'historical' | 'computed'
   * @param {string|null} source.scope — scope necessário (null = público/infra)
   * @param {object} [source.metadata] — dados extras (formato, intervalo, etc.)
   */
  register(source) {
    if (!source.name || !source.type) {
      throw new Error('DataSource requer name e type');
    }

    const entry = {
      name: source.name,
      type: source.type,
      scope: source.scope || null,
      category: source.scope ? 'private' : 'infra',
      platform: this._platform,
      registeredAt: new Date().toISOString(),
      metadata: source.metadata || {},
    };

    this._sources.set(source.name, entry);
    this.emit('registered', entry);
    return entry;
  }

  /**
   * Remove uma fonte de dados.
   */
  unregister(name) {
    const existed = this._sources.delete(name);
    if (existed) this.emit('unregistered', { name });
    return existed;
  }

  /**
   * Busca uma fonte por nome.
   */
  get(name) {
    return this._sources.get(name) || null;
  }

  /**
   * Verifica se uma fonte existe.
   */
  has(name) {
    return this._sources.has(name);
  }

  /**
   * Lista todas as fontes, opcionalmente filtradas.
   * @param {object} [filter]
   * @param {string} [filter.type] — 'realtime' | 'historical' | 'computed'
   * @param {string} [filter.category] — 'infra' | 'private'
   * @param {string} [filter.scope] — scope específico
   */
  list(filter) {
    let sources = [...this._sources.values()];

    if (filter?.type) {
      sources = sources.filter(s => s.type === filter.type);
    }
    if (filter?.category) {
      sources = sources.filter(s => s.category === filter.category);
    }
    if (filter?.scope) {
      sources = sources.filter(s => s.scope === filter.scope);
    }

    return sources;
  }

  /**
   * Retorna fontes acessíveis dado um set de scopes.
   * @param {string[]} grantedScopes
   */
  accessible(grantedScopes = []) {
    return this.list().filter(source => {
      if (source.category === 'infra') return true;
      if (grantedScopes.includes('*')) return true;
      if (!source.scope) return true;
      return grantedScopes.includes(source.scope);
    });
  }

  get size() {
    return this._sources.size;
  }

  /**
   * Serializa para envio via ANNOUNCE/API.
   */
  toJSON() {
    return {
      platform: this._platform,
      count: this._sources.size,
      sources: this.list(),
    };
  }

  /**
   * Formato compacto para ANNOUNCE (só nome + tipo).
   */
  toAnnounce() {
    return this.list().map(s => ({
      name: s.name,
      type: s.type,
      scope: s.scope,
    }));
  }
}

module.exports = DataSourceRegistry;
