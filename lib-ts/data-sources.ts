// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';
// Note: capabilitiesLib was imported but unused in the original JS source.

export interface DataSourceInput {
  name: string;
  type: string;
  scope?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DataSourceEntry {
  name: string;
  type: string;
  scope: string | null;
  category: 'private' | 'infra';
  platform: string;
  registeredAt: string;
  metadata: Record<string, unknown>;
}

export interface DataSourceFilter {
  type?: string;
  category?: string;
  scope?: string;
}

export interface PlatformInfo {
  platform?: string;
  dataSources?: DataSourceInput[];
}

export interface DataSourceAnnounce {
  name: string;
  type: string;
  scope: string | null;
}

export interface DataSourceRegistryJSON {
  platform: string;
  count: number;
  sources: DataSourceEntry[];
}

export default class DataSourceRegistry extends EventEmitter {
  private _sources: Map<string, DataSourceEntry>;
  private _platform: string;

  constructor(platformInfo: PlatformInfo = {}) {
    super();
    this._sources = new Map();
    this._platform = platformInfo.platform || 'unknown';
    if (platformInfo.dataSources) {
      for (const ds of platformInfo.dataSources) {
        this.register(ds);
      }
    }
  }

  register(source: DataSourceInput): DataSourceEntry {
    if (!source.name || !source.type) throw new Error('DataSource requer name e type');
    const entry: DataSourceEntry = {
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

  unregister(name: string): boolean {
    const existed = this._sources.delete(name);
    if (existed) this.emit('unregistered', { name });
    return existed;
  }

  get(name: string): DataSourceEntry | null {
    return this._sources.get(name) || null;
  }

  has(name: string): boolean {
    return this._sources.has(name);
  }

  list(filter?: DataSourceFilter): DataSourceEntry[] {
    let sources = [...this._sources.values()];
    if (filter?.type) sources = sources.filter(s => s.type === filter.type);
    if (filter?.category) sources = sources.filter(s => s.category === filter.category);
    if (filter?.scope) sources = sources.filter(s => s.scope === filter.scope);
    return sources;
  }

  accessible(grantedScopes: string[] = []): DataSourceEntry[] {
    return this.list().filter(source => {
      if (source.category === 'infra') return true;
      if (grantedScopes.includes('*')) return true;
      if (!source.scope) return true;
      return grantedScopes.includes(source.scope);
    });
  }

  get size(): number {
    return this._sources.size;
  }

  toJSON(): DataSourceRegistryJSON {
    return {
      platform: this._platform,
      count: this._sources.size,
      sources: this.list(),
    };
  }

  toAnnounce(): DataSourceAnnounce[] {
    return this.list().map(s => ({ name: s.name, type: s.type, scope: s.scope }));
  }
}
