// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

const DEFAULT_QUERY_TIMEOUT = 15000;
const DEFAULT_MAX_HOPS = 2;
const DEFAULT_RATE_LIMIT = { windowMs: 60000, maxQueries: 30, maxRelays: 10 };

interface RateLimitConfig {
  windowMs: number;
  maxQueries: number;
  maxRelays: number;
}

interface PeerInfo {
  nodeId: string;
  name?: string;
  endpoint?: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

interface MeshInterface {
  nodeId: string;
  registry: {
    online(): PeerInfo[];
    get(nodeId: string): PeerInfo | undefined;
  };
  queryBySkill(skill: string, options?: { eligibleOnly?: boolean }): SearchResult[];
  sendPrompt(targetNodeId: string, prompt: string, options?: Record<string, unknown>): Promise<unknown>;
}

interface SearchResult {
  peer?: PeerInfo;
  nodeId?: string;
  score?: number;
  source?: string;
  via?: string;
  viaName?: string;
}

interface QueryOptions {
  queryId?: string;
  hopsRemaining?: number;
  originNode?: string;
  skill?: string;
}

interface QueryResult {
  queryId?: string;
  skill?: string;
  results: SearchResult[];
  local: number;
  remote: number;
  total?: number;
  hops?: number;
  deduplicated?: boolean;
  rateLimited?: boolean;
}

interface RelayResult {
  method: string;
  via: string;
  viaName: string;
  response: unknown;
  model: unknown;
  raw: unknown;
}

interface FederatedSearchOptions {
  mesh: MeshInterface;
  fetch?: typeof globalThis.fetch;
  queryTimeout?: number;
  maxHops?: number;
  rateLimit?: Partial<RateLimitConfig>;
}

export class FederatedSearch {
  private _mesh: MeshInterface;
  private _fetch: typeof globalThis.fetch;
  private _queryTimeout: number;
  private _maxHops: number;
  private _rateLimit: RateLimitConfig;
  private _queryLog: number[];
  private _relayLog: number[];
  private _seenQueries: Map<string, number>;
  private _seenQueryTtl: number;

  constructor(options: FederatedSearchOptions) {
    this._mesh = options.mesh;
    this._fetch = options.fetch || globalThis.fetch;
    this._queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    this._maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this._rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
    this._queryLog = [];
    this._relayLog = [];
    this._seenQueries = new Map();
    this._seenQueryTtl = 60000;
  }

  async query(skill: string, options: QueryOptions = {}): Promise<QueryResult> {
    const queryId =
      options.queryId ||
      `q_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const hopsRemaining = options.hopsRemaining ?? this._maxHops;
    const originNode = options.originNode || this._mesh.nodeId;

    if (this._seenQueries.has(queryId)) {
      return { results: [], local: 0, remote: 0, hops: 0, deduplicated: true };
    }

    this._seenQueries.set(queryId, Date.now());
    this._cleanupSeenQueries();

    if (!this._checkRateLimit('query')) {
      return { results: [], local: 0, remote: 0, hops: 0, rateLimited: true };
    }

    const localResults = this._mesh.queryBySkill(skill, { eligibleOnly: false });

    let remoteResults: SearchResult[] = [];
    if (hopsRemaining > 0) {
      remoteResults = await this._propagateQuery(skill, {
        queryId,
        hopsRemaining: hopsRemaining - 1,
        originNode,
      });
    }

    const merged = this._mergeResults(localResults, remoteResults);

    return {
      queryId,
      skill,
      results: merged,
      local: localResults.length,
      remote: remoteResults.length,
      total: merged.length,
      hops: this._maxHops - hopsRemaining,
    };
  }

  private async _propagateQuery(
    skill: string,
    options: { queryId: string; hopsRemaining: number; originNode: string },
  ): Promise<SearchResult[]> {
    const peers = this._mesh.registry.online().filter((p) => p.endpoint);
    const results: SearchResult[] = [];

    const promises = peers.map(async (peer) => {
      try {
        const url = `${peer.endpoint!.replace(/\/$/, '')}/api/network/query`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._queryTimeout);
        try {
          const res = await this._fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              skill,
              queryId: options.queryId,
              hopsRemaining: options.hopsRemaining,
              originNode: options.originNode,
            }),
          });
          if (res.ok) {
            const data = (await res.json()) as { results?: SearchResult[] };
            if (data.results) {
              for (const r of data.results) {
                results.push({ ...r, via: peer.nodeId, viaName: peer.name });
              }
            }
          }
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // peer unreachable
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  private _mergeResults(local: SearchResult[], remote: SearchResult[]): SearchResult[] {
    const seen = new Map<string, SearchResult>();

    for (const r of local) {
      const key = r.peer?.nodeId || r.nodeId;
      if (key && !seen.has(key)) seen.set(key, { ...r, source: 'local' });
    }
    for (const r of remote) {
      const key = r.peer?.nodeId || r.nodeId;
      if (key && !seen.has(key)) seen.set(key, { ...r, source: 'remote' });
    }

    return [...seen.values()].sort((a, b) => (b.score || 0) - (a.score || 0));
  }

  async relay(
    targetNodeId: string,
    prompt: string,
    options: QueryOptions & Record<string, unknown> = {},
  ): Promise<RelayResult> {
    if (!this._checkRateLimit('relay')) {
      throw new Error('Rate limit exceeded for relays');
    }

    const peer = this._mesh.registry.get(targetNodeId);

    if (peer?.endpoint || peer?.metadata?.token) {
      return this._mesh.sendPrompt(targetNodeId, prompt, options) as Promise<RelayResult>;
    }

    const via = peer?.metadata?.discoveredVia as string | undefined;
    if (via) {
      const hub = this._mesh.registry.get(via);
      if (hub?.endpoint) return this._relayViaHub(hub, targetNodeId, prompt, options);
    }

    const searchResult = await this.query(options.skill || 'chat');
    const match = searchResult.results.find(
      (r) => (r.peer?.nodeId || r.nodeId) === targetNodeId && r.via,
    );
    if (match) {
      const hub = this._mesh.registry.get(match.via!);
      if (hub?.endpoint) return this._relayViaHub(hub, targetNodeId, prompt, options);
    }

    throw new Error(`No route to ${targetNodeId}`);
  }

  private async _relayViaHub(
    hub: PeerInfo,
    targetNodeId: string,
    prompt: string,
    options: Record<string, unknown> = {},
  ): Promise<RelayResult> {
    const url = `${hub.endpoint!.replace(/\/$/, '')}/api/network/relay`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._queryTimeout * 2);

    try {
      const res = await this._fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          targetNodeId,
          prompt,
          skill: (options.skill as string) || 'chat',
          originNode: this._mesh.nodeId,
        }),
      });

      if (!res.ok) throw new Error(`Hub ${hub.name} returned ${res.status}`);
      const data = (await res.json()) as { response: unknown; model: unknown };

      return {
        method: 'relay',
        via: hub.nodeId,
        viaName: hub.name || '',
        response: data.response,
        model: data.model,
        raw: data,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private _checkRateLimit(type: 'query' | 'relay'): boolean {
    const log = type === 'relay' ? this._relayLog : this._queryLog;
    const max = type === 'relay' ? this._rateLimit.maxRelays : this._rateLimit.maxQueries;
    const now = Date.now();

    while (log.length > 0 && now - log[0] > this._rateLimit.windowMs) log.shift();
    if (log.length >= max) return false;
    log.push(now);
    return true;
  }

  private _cleanupSeenQueries(): void {
    const now = Date.now();
    for (const [id, ts] of this._seenQueries) {
      if (now - ts > this._seenQueryTtl) this._seenQueries.delete(id);
    }
  }

  stats(): {
    queries: { recent: number; max: number };
    relays: { recent: number; max: number };
    seenQueries: number;
  } {
    const now = Date.now();
    return {
      queries: {
        recent: this._queryLog.filter((t) => now - t < this._rateLimit.windowMs).length,
        max: this._rateLimit.maxQueries,
      },
      relays: {
        recent: this._relayLog.filter((t) => now - t < this._rateLimit.windowMs).length,
        max: this._rateLimit.maxRelays,
      },
      seenQueries: this._seenQueries.size,
    };
  }
}

export default FederatedSearch;
