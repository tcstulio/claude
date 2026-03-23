// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';

export interface PeerInfo {
  nodeId: string;
  name: string;
  capabilities: string[];
  channels: string[];
  endpoint: string | null;
  lastSeen: number;
  firstSeen: number;
  status: 'online' | 'stale' | 'offline';
  latency: number | null;
  platform: string | null;
  dataSources: Array<{ name: string; type: string; scope?: string | null }>;
  metadata: Record<string, unknown>;
}

export interface PeerFilter {
  status?: string;
  capability?: string;
  dataSource?: string;
  platform?: string;
}

export interface PeerRegistryOptions {
  staleTtl?: number;
  deadTtl?: number;
  sweepInterval?: number;
}

export interface PeerRegistryJSON {
  count: number;
  online: number;
  peers: Array<{
    nodeId: string;
    name: string;
    status: string;
    channels: string[];
    capabilities: string[];
    platform: string | null;
    dataSources: unknown[];
    lastSeen: string;
    latency: number | null;
  }>;
}

export class PeerRegistry extends EventEmitter {
  private _peers: Map<string, PeerInfo>;
  private _staleTtl: number;
  private _deadTtl: number;
  private _sweepInterval: number;
  private _sweepTimer: ReturnType<typeof setInterval> | null;

  constructor(options: PeerRegistryOptions = {}) {
    super();
    this._peers = new Map();
    this._staleTtl = options.staleTtl || 5 * 60 * 1000;
    this._deadTtl = options.deadTtl || 15 * 60 * 1000;
    this._sweepInterval = options.sweepInterval || 60 * 1000;
    this._sweepTimer = null;
  }

  upsert(nodeId: string, info: Partial<PeerInfo> = {}): PeerInfo {
    const existing = this._peers.get(nodeId);
    const now = Date.now();

    const peer: PeerInfo = {
      nodeId,
      name: info.name || existing?.name || nodeId,
      capabilities: info.capabilities || existing?.capabilities || [],
      channels: info.channels || existing?.channels || [],
      endpoint: info.endpoint || existing?.endpoint || null,
      lastSeen: now,
      firstSeen: existing?.firstSeen || now,
      status: 'online',
      latency: info.latency ?? existing?.latency ?? null,
      platform: info.platform || existing?.platform || null,
      dataSources: info.dataSources || existing?.dataSources || [],
      metadata: { ...(existing?.metadata || {}), ...(info.metadata || {}) },
    };

    this._peers.set(nodeId, peer);

    if (!existing) {
      this.emit('peer-joined', peer);
      console.log(`[mesh] Peer entrou: ${peer.name} (${nodeId})`);
    } else {
      this.emit('peer-updated', peer);
    }
    return peer;
  }

  touch(nodeId: string): PeerInfo | undefined {
    const peer = this._peers.get(nodeId);
    if (peer) {
      peer.lastSeen = Date.now();
      peer.status = 'online';
    }
    return peer;
  }

  get(nodeId: string): PeerInfo | null {
    return this._peers.get(nodeId) || null;
  }

  has(nodeId: string): boolean {
    return this._peers.has(nodeId);
  }

  remove(nodeId: string): boolean {
    const peer = this._peers.get(nodeId);
    if (peer) {
      this._peers.delete(nodeId);
      this.emit('peer-left', peer);
      console.log(`[mesh] Peer saiu: ${peer.name} (${nodeId})`);
    }
    return !!peer;
  }

  list(filter?: PeerFilter): PeerInfo[] {
    let peers = [...this._peers.values()];
    if (filter?.status) peers = peers.filter(p => p.status === filter.status);
    if (filter?.capability) peers = peers.filter(p => p.capabilities.includes(filter.capability!));
    if (filter?.dataSource) peers = peers.filter(p => (p.dataSources || []).some(ds => ds.name === filter.dataSource));
    if (filter?.platform) peers = peers.filter(p => p.platform === filter.platform);
    return peers;
  }

  get size(): number {
    return this._peers.size;
  }

  online(): PeerInfo[] {
    return this.list({ status: 'online' });
  }

  withChannel(channel: string): PeerInfo[] {
    return [...this._peers.values()].filter(p =>
      p.status === 'online' && p.channels.includes(channel)
    );
  }

  private _sweep(): void {
    const now = Date.now();
    for (const [nodeId, peer] of this._peers) {
      const age = now - peer.lastSeen;

      if (age > this._deadTtl) {
        this.remove(nodeId);
      } else if (age > this._staleTtl && peer.status !== 'stale') {
        peer.status = 'stale';
        this.emit('peer-stale', peer);
        console.log(`[mesh] Peer stale: ${peer.name} (${nodeId})`);
      }
    }
  }

  startSweep(): void {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this._sweep(), this._sweepInterval);
  }

  stopSweep(): void {
    if (this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  toJSON(): PeerRegistryJSON {
    return {
      count: this._peers.size,
      online: this.online().length,
      peers: [...this._peers.values()].map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        status: p.status,
        channels: p.channels,
        capabilities: p.capabilities,
        platform: p.platform,
        dataSources: p.dataSources,
        lastSeen: new Date(p.lastSeen).toISOString(),
        latency: p.latency,
      })),
    };
  }
}

export default PeerRegistry;
