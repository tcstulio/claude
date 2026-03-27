// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

const DEFAULT_MAX_HOPS = 3;
const DEFAULT_CACHE_TTL = 5 * 60 * 1000;
const DEFAULT_TIMEOUT = 10000;

interface PeerSeed {
  nodeId?: string;
  endpoint?: string;
  [key: string]: unknown;
}

interface CrawlResult {
  peers: Map<string, CrawledPeer>;
  hops: number;
  crawled: number;
  total: number;
  errors: string[];
  cached: boolean;
}

interface CrawledPeer extends PeerSeed {
  discoveredAt?: number;
  discoveredVia?: string;
}

interface CrawlerOptions {
  fetch?: typeof globalThis.fetch;
  maxHops?: number;
  cacheTtl?: number;
  timeout?: number;
}

interface CrawlOptions {
  force?: boolean;
}

interface CacheEntry {
  timestamp: number;
  result: Omit<CrawlResult, 'cached'>;
}

export class NetworkCrawler {
  private _fetch: typeof globalThis.fetch;
  private _maxHops: number;
  private _cacheTtl: number;
  private _timeout: number;
  private _cache: CacheEntry | null;

  constructor(options: CrawlerOptions = {}) {
    this._fetch = options.fetch || globalThis.fetch;
    this._maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this._cacheTtl = options.cacheTtl ?? DEFAULT_CACHE_TTL;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._cache = null;
  }

  async crawl(seeds: PeerSeed[], options: CrawlOptions = {}): Promise<CrawlResult> {
    if (
      !options.force &&
      this._cache &&
      Date.now() - this._cache.timestamp < this._cacheTtl
    ) {
      return { ...this._cache.result, cached: true };
    }

    const visited = new Set<string>();
    const allPeers = new Map<string, CrawledPeer>();
    const errors: string[] = [];
    let maxHopReached = 0;

    const queue: Array<{ peer: PeerSeed; hop: number }> = seeds
      .filter((s) => s.endpoint)
      .map((s) => ({ peer: s, hop: 0 }));

    for (const s of seeds) {
      if (s.nodeId) allPeers.set(s.nodeId, { ...s, discoveredAt: 0 });
    }

    while (queue.length > 0) {
      const { peer, hop } = queue.shift()!;
      if (hop > this._maxHops || !peer.endpoint) continue;
      if (visited.has(peer.endpoint)) continue;

      visited.add(peer.endpoint);
      maxHopReached = Math.max(maxHopReached, hop);

      try {
        const remotePeers = await this._fetchPublicPeers(peer.endpoint);
        for (const rp of remotePeers) {
          if (!rp.nodeId || allPeers.has(rp.nodeId)) continue;
          allPeers.set(rp.nodeId, {
            ...rp,
            discoveredAt: hop + 1,
            discoveredVia: peer.nodeId,
          });
          if (rp.endpoint && hop + 1 < this._maxHops) {
            queue.push({ peer: rp, hop: hop + 1 });
          }
        }
      } catch (err) {
        errors.push(`${peer.endpoint}: ${(err as Error).message}`);
      }
    }

    const result = {
      peers: allPeers,
      hops: maxHopReached,
      crawled: visited.size,
      total: allPeers.size,
      errors,
    };
    this._cache = { timestamp: Date.now(), result };
    return { ...result, cached: false };
  }

  private async _fetchPublicPeers(endpoint: string): Promise<PeerSeed[]> {
    const url = `${endpoint.replace(/\/$/, '')}/api/network/peers/public`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const res = await this._fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as { peers?: PeerSeed[] } | PeerSeed[];
      return (data as { peers?: PeerSeed[] }).peers || (data as PeerSeed[]) || [];
    } finally {
      clearTimeout(timer);
    }
  }

  invalidate(): void {
    this._cache = null;
  }

  cacheInfo(): { cached: boolean; age?: number; ttl?: number; total?: number } {
    if (!this._cache) return { cached: false };
    return {
      cached: true,
      age: Date.now() - this._cache.timestamp,
      ttl: this._cacheTtl,
      total: this._cache.result.total,
    };
  }
}

export default NetworkCrawler;
