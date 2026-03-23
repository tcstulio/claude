// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// TrustGraph — trust scoring between Tulipa agents.

export interface TrustEntry {
  score: number;
  reason: string;
  updatedAt: number;
}

export interface TrustConfig {
  defaultTrust: number;
  transitiveDecay: number;
  delegationThreshold: number;
  maxHops: number;
  cacheTtl: number;
}

export interface TransitiveTrustResult {
  score: number;
  path: string[];
  hops: number;
}

export interface DelegationRanking {
  peer: { nodeId: string; name: string };
  score: number;
  trust: number;
  balanceFactor: number;
  eligible: boolean;
}

export interface PeerLike {
  nodeId: string;
  name?: string;
  capabilities?: string[];
  metadata?: {
    endorsed?: boolean;
    relation?: string;
    reputation?: number;
  };
}

export interface InteractionData {
  receiptsCount?: number;
  successRate?: number;
  avgLatency?: number;
}

export interface LedgerLike {
  getPeerBalance(peerId: string): number;
}

const DEFAULT_TRUST = 0.5;
const TRANSITIVE_DECAY = 0.7;
const DELEGATION_THRESHOLD = 0.3;
const MAX_HOPS = 3;
const REPUTATION_WEIGHT = 0.3;
const INTERACTION_WEIGHT = 0.4;
const BASE_WEIGHT = 0.3;

export class TrustGraph {
  readonly nodeId: string;
  private _defaultTrust: number;
  private _transitiveDecay: number;
  private _delegationThreshold: number;
  private _maxHops: number;
  private _directTrust = new Map<string, TrustEntry>();
  private _transitiveCache = new Map<string, { score: number; path: string[]; timestamp: number }>();
  private _cacheTtl: number;

  constructor(options: Partial<TrustConfig> & { nodeId: string }) {
    this.nodeId = options.nodeId;
    this._defaultTrust = options.defaultTrust ?? DEFAULT_TRUST;
    this._transitiveDecay = options.transitiveDecay ?? TRANSITIVE_DECAY;
    this._delegationThreshold = options.delegationThreshold ?? DELEGATION_THRESHOLD;
    this._maxHops = options.maxHops ?? MAX_HOPS;
    this._cacheTtl = options.cacheTtl ?? 5 * 60 * 1000;
  }

  setDirectTrust(peerId: string, score: number, reason = "manual"): void {
    this._directTrust.set(peerId, {
      score: Math.max(0, Math.min(1, score)),
      reason,
      updatedAt: Date.now(),
    });
    this._invalidateCacheFor(peerId);
  }

  getDirectTrust(peerId: string): number | null {
    return this._directTrust.get(peerId)?.score ?? null;
  }

  computeTrust(peer: PeerLike, interactions: InteractionData = {}): number {
    let baseTrust = this._defaultTrust;
    if (peer.metadata?.endorsed) baseTrust = Math.max(baseTrust, 0.6);
    if (peer.metadata?.relation === "owner") baseTrust = 1.0;

    const reputation = (peer.metadata?.reputation ?? 50) / 100;

    let interactionTrust = 0.5;
    if (interactions.receiptsCount && interactions.receiptsCount > 0) {
      const successFactor = interactions.successRate ?? 1.0;
      const volumeFactor = Math.min(1, interactions.receiptsCount / 20);
      interactionTrust = successFactor * 0.7 + volumeFactor * 0.3;
    }

    const score = baseTrust * BASE_WEIGHT + reputation * REPUTATION_WEIGHT + interactionTrust * INTERACTION_WEIGHT;
    return Math.max(0, Math.min(1, score));
  }

  updateTrust(peer: PeerLike, interactions: InteractionData = {}): number {
    const score = this.computeTrust(peer, interactions);
    this.setDirectTrust(peer.nodeId, score, "computed");
    return score;
  }

  getTransitiveTrust(
    targetId: string,
    getNeighborTrust: (peerId: string) => Map<string, number> | null,
  ): TransitiveTrustResult {
    const direct = this.getDirectTrust(targetId);
    if (direct !== null) {
      return { score: direct, path: [this.nodeId, targetId], hops: 0 };
    }

    const cached = this._transitiveCache.get(targetId);
    if (cached && Date.now() - cached.timestamp < this._cacheTtl) {
      return { score: cached.score, path: cached.path, hops: cached.path.length - 1 };
    }

    const result = this._bfsTrust(targetId, getNeighborTrust);
    this._transitiveCache.set(targetId, { ...result, timestamp: Date.now() });
    return { score: result.score, path: result.path, hops: result.path.length - 1 };
  }

  private _bfsTrust(
    targetId: string,
    getNeighborTrust: (peerId: string) => Map<string, number> | null,
  ): { score: number; path: string[] } {
    const queue: Array<{ nodeId: string; trustSoFar: number; path: string[] }> = [];
    const visited = new Set<string>([this.nodeId]);
    let bestScore = 0;
    let bestPath: string[] = [];

    for (const [peerId, entry] of this._directTrust) {
      if (peerId === targetId) {
        return { score: entry.score, path: [this.nodeId, targetId] };
      }
      queue.push({ nodeId: peerId, trustSoFar: entry.score, path: [this.nodeId, peerId] });
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.path.length - 1 >= this._maxHops) continue;
      if (visited.has(current.nodeId)) continue;
      visited.add(current.nodeId);

      const neighbors = getNeighborTrust(current.nodeId);
      if (!neighbors) continue;

      for (const [neighborId, neighborTrust] of neighbors) {
        if (visited.has(neighborId)) continue;
        const transitiveTrust = current.trustSoFar * neighborTrust * this._transitiveDecay;

        if (neighborId === targetId) {
          if (transitiveTrust > bestScore) {
            bestScore = transitiveTrust;
            bestPath = [...current.path, neighborId];
          }
          continue;
        }

        if (transitiveTrust > this._delegationThreshold * 0.5) {
          queue.push({
            nodeId: neighborId,
            trustSoFar: transitiveTrust,
            path: [...current.path, neighborId],
          });
        }
      }
    }

    return { score: bestScore, path: bestPath };
  }

  rankForDelegation(
    peers: PeerLike[],
    options: { skill?: string; ledger?: LedgerLike; getNeighborTrust?: (id: string) => Map<string, number> | null } = {},
  ): DelegationRanking[] {
    const { skill, ledger, getNeighborTrust } = options;

    return peers
      .map(peer => {
        let trust: number;
        const directTrust = this.getDirectTrust(peer.nodeId);
        if (directTrust !== null) {
          trust = directTrust;
        } else if (getNeighborTrust) {
          trust = this.getTransitiveTrust(peer.nodeId, getNeighborTrust).score;
        } else {
          trust = this.computeTrust(peer);
        }

        let balanceFactor = 1.0;
        if (ledger) {
          const peerBalance = ledger.getPeerBalance(peer.nodeId);
          balanceFactor = 1.0 + Math.tanh(-peerBalance / 50) * 0.2;
        }

        const hasSkill = !skill || (peer.capabilities ?? []).includes(skill);
        const score = trust * balanceFactor * (hasSkill ? 1.0 : 0.1);
        const eligible = score >= this._delegationThreshold && hasSkill;

        return {
          peer: { nodeId: peer.nodeId, name: peer.name ?? peer.nodeId },
          score: Math.round(score * 1000) / 1000,
          trust: Math.round(trust * 1000) / 1000,
          balanceFactor: Math.round(balanceFactor * 1000) / 1000,
          eligible,
        };
      })
      .sort((a, b) => b.score - a.score);
  }

  canDelegate(peerId: string): boolean {
    const trust = this.getDirectTrust(peerId);
    return trust !== null && trust >= this._delegationThreshold;
  }

  private _invalidateCacheFor(peerId: string): void {
    for (const [key, cached] of this._transitiveCache) {
      if (cached.path?.includes(peerId)) {
        this._transitiveCache.delete(key);
      }
    }
  }

  getAllDirectTrust(): Record<string, { score: number; reason: string }> {
    const result: Record<string, { score: number; reason: string }> = {};
    for (const [peerId, entry] of this._directTrust) {
      result[peerId] = { score: entry.score, reason: entry.reason };
    }
    return result;
  }

  toJSON(): object {
    return {
      nodeId: this.nodeId,
      config: {
        defaultTrust: this._defaultTrust,
        transitiveDecay: this._transitiveDecay,
        delegationThreshold: this._delegationThreshold,
        maxHops: this._maxHops,
      },
      directTrust: this.getAllDirectTrust(),
      cacheSize: this._transitiveCache.size,
    };
  }
}
