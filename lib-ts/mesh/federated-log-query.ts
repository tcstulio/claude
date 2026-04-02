// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { LogQuery, LogEntry, LogQueryResult } from './log-query.js';
import type { LogQueryService } from './log-query-service.js';

const DEFAULT_QUERY_TIMEOUT = 8000;
const DEFAULT_MAX_HOPS = 1;
const DEFAULT_RATE_LIMIT = { windowMs: 60000, maxQueries: 20 };

interface PeerInfo {
  nodeId: string;
  name?: string;
  endpoint?: string;
}

interface RegistryLike {
  online(): PeerInfo[];
}

interface FederatedLogQueryOptions {
  localService: LogQueryService;
  nodeId: string;
  registry: RegistryLike;
  fetch?: typeof globalThis.fetch;
  queryTimeout?: number;
  maxHops?: number;
  rateLimit?: { windowMs?: number; maxQueries?: number };
}

export class FederatedLogQuery {
  private _localService: LogQueryService;
  private _nodeId: string;
  private _registry: RegistryLike;
  private _fetch: typeof globalThis.fetch;
  private _queryTimeout: number;
  private _maxHops: number;
  private _rateLimit: { windowMs: number; maxQueries: number };
  private _queryLog: number[];
  private _seenQueries: Map<string, number>;

  constructor(options: FederatedLogQueryOptions) {
    this._localService = options.localService;
    this._nodeId = options.nodeId;
    this._registry = options.registry;
    this._fetch = options.fetch || globalThis.fetch;
    this._queryTimeout = options.queryTimeout ?? DEFAULT_QUERY_TIMEOUT;
    this._maxHops = options.maxHops ?? DEFAULT_MAX_HOPS;
    this._rateLimit = { ...DEFAULT_RATE_LIMIT, ...options.rateLimit };
    this._queryLog = [];
    this._seenQueries = new Map();
  }

  async query(q: LogQuery): Promise<LogQueryResult> {
    const start = Date.now();
    const queryId = q.queryId || `lq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const hopsRemaining = q.hopsRemaining ?? this._maxHops;

    // Dedup
    if (this._seenQueries.has(queryId)) {
      return this._emptyResult(queryId, start);
    }
    this._seenQueries.set(queryId, Date.now());
    this._cleanupSeenQueries();

    // Rate limit
    if (!this._checkRateLimit()) {
      return this._emptyResult(queryId, start);
    }

    // Local query
    const localEntries = this._localService.query(q);
    const timing: Record<string, number> = { [this._nodeId]: Date.now() - start };

    // Federated propagation
    let remoteEntries: LogEntry[] = [];
    const nodesFailed: string[] = [];
    let nodesQueried = 1;

    if (hopsRemaining > 0) {
      const peers = this._getTargetPeers(q);
      nodesQueried += peers.length;

      const results = await this._propagateQuery(peers, {
        ...q,
        queryId,
        hopsRemaining: hopsRemaining - 1,
        originNode: q.originNode || this._nodeId,
      }, timing, nodesFailed);

      remoteEntries = results;
    }

    // Merge and sort
    const merged = this._mergeEntries(localEntries, remoteEntries);
    const limit = Math.min(q.limit || 100, 500);
    const truncated = merged.length > limit;
    const entries = merged.slice(0, limit);

    return {
      queryId,
      entries,
      metadata: {
        totalEntries: entries.length,
        nodesQueried,
        nodesResponded: nodesQueried - nodesFailed.length,
        nodesFailed,
        truncated,
        timing: { totalMs: Date.now() - start, perNode: timing },
      },
    };
  }

  private _getTargetPeers(q: LogQuery): PeerInfo[] {
    const online = this._registry.online().filter(p => p.endpoint && p.nodeId !== this._nodeId);
    if (q.targetNodes && q.targetNodes.length > 0) {
      return online.filter(p => q.targetNodes!.includes(p.nodeId));
    }
    return online;
  }

  private async _propagateQuery(
    peers: PeerInfo[],
    q: LogQuery,
    timing: Record<string, number>,
    nodesFailed: string[],
  ): Promise<LogEntry[]> {
    const results: LogEntry[] = [];

    const promises = peers.map(async (peer) => {
      const peerStart = Date.now();
      try {
        const url = `${peer.endpoint!.replace(/\/$/, '')}/api/logs/query`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this._queryTimeout);
        try {
          const res = await this._fetch(url, {
            method: 'POST',
            signal: controller.signal,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(q),
          });
          if (res.ok) {
            const data = (await res.json()) as { entries?: LogEntry[] };
            if (data.entries) {
              results.push(...data.entries);
            }
          } else {
            nodesFailed.push(peer.nodeId);
          }
        } finally {
          clearTimeout(timer);
        }
        timing[peer.nodeId] = Date.now() - peerStart;
      } catch {
        nodesFailed.push(peer.nodeId);
        timing[peer.nodeId] = Date.now() - peerStart;
      }
    });

    await Promise.allSettled(promises);
    return results;
  }

  private _mergeEntries(local: LogEntry[], remote: LogEntry[]): LogEntry[] {
    const seen = new Map<string, LogEntry>();

    for (const e of local) {
      const key = `${e.nodeId}:${e.logType}:${e.id}`;
      if (!seen.has(key)) seen.set(key, e);
    }
    for (const e of remote) {
      const key = `${e.nodeId}:${e.logType}:${e.id}`;
      if (!seen.has(key)) seen.set(key, e);
    }

    return [...seen.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
  }

  private _checkRateLimit(): boolean {
    const now = Date.now();
    this._queryLog = this._queryLog.filter(t => now - t < this._rateLimit.windowMs);
    if (this._queryLog.length >= this._rateLimit.maxQueries) return false;
    this._queryLog.push(now);
    return true;
  }

  private _cleanupSeenQueries(): void {
    const cutoff = Date.now() - 60000;
    for (const [id, ts] of this._seenQueries) {
      if (ts < cutoff) this._seenQueries.delete(id);
    }
  }

  private _emptyResult(queryId: string, start: number): LogQueryResult {
    return {
      queryId,
      entries: [],
      metadata: {
        totalEntries: 0,
        nodesQueried: 0,
        nodesResponded: 0,
        nodesFailed: [],
        truncated: false,
        timing: { totalMs: Date.now() - start, perNode: {} },
      },
    };
  }
}
