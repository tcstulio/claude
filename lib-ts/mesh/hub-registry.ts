// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// HubRegistry — distributed registry of all hubs in the network.

import { EventEmitter } from "node:events";

export type HubEntryState = "active" | "suspect" | "dead";

export interface HubRegistryEntry {
  nodeId: string;
  name: string;
  endpoint: string | null;
  state: HubEntryState;
  epoch: number;
  promotedAt: number;
  promotedBy: string | null;
  metrics: Record<string, unknown>;
  lastHeartbeat: number;
  consecutiveMisses: number;
  region: string | null;
  peerCount: number;
}

export interface SyncPayload {
  hubs: Array<Omit<HubRegistryEntry, "consecutiveMisses">>;
  epoch: number;
}

export class HubRegistry extends EventEmitter {
  private _hubs = new Map<string, HubRegistryEntry>();
  private _epoch = 0;
  private _heartbeatTimeout: number;
  private _deadTimeout: number;
  private _maxHubs: number;
  private _checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { heartbeatTimeout?: number; deadTimeout?: number; maxHubs?: number } = {}) {
    super();
    this._heartbeatTimeout = options.heartbeatTimeout ?? 90000;
    this._deadTimeout = options.deadTimeout ?? 150000;
    this._maxHubs = options.maxHubs ?? 20;
  }

  upsert(nodeId: string, entry: Partial<HubRegistryEntry>): HubRegistryEntry {
    const existing = this._hubs.get(nodeId);
    if (existing && entry.epoch && existing.epoch > entry.epoch) return existing;

    const now = Date.now();
    const hub: HubRegistryEntry = {
      nodeId,
      name: entry.name ?? existing?.name ?? nodeId,
      endpoint: entry.endpoint ?? existing?.endpoint ?? null,
      state: (entry.state ?? existing?.state ?? "active") as HubEntryState,
      epoch: entry.epoch ?? (existing?.epoch ?? 0) + 1,
      promotedAt: entry.promotedAt ?? existing?.promotedAt ?? now,
      promotedBy: entry.promotedBy ?? existing?.promotedBy ?? null,
      metrics: { ...(existing?.metrics ?? {}), ...(entry.metrics ?? {}) },
      lastHeartbeat: entry.lastHeartbeat ?? now,
      consecutiveMisses: 0,
      region: entry.region ?? existing?.region ?? null,
      peerCount: entry.peerCount ?? existing?.peerCount ?? 0,
    };

    const isNew = !existing;
    this._hubs.set(nodeId, hub);
    this._epoch++;
    this.emit(isNew ? "hub-added" : "hub-updated", hub);
    return hub;
  }

  remove(nodeId: string): HubRegistryEntry | null {
    const hub = this._hubs.get(nodeId);
    if (!hub) return null;
    this._hubs.delete(nodeId);
    this._epoch++;
    this.emit("hub-removed", hub);
    return hub;
  }

  get(nodeId: string): HubRegistryEntry | null { return this._hubs.get(nodeId) ?? null; }
  list(): HubRegistryEntry[] { return Array.from(this._hubs.values()); }
  getActive(): HubRegistryEntry[] { return this.list().filter(h => h.state === "active"); }

  getNearestHub(excludeNodeId?: string): HubRegistryEntry | null {
    const active = this.getActive().filter(h => h.nodeId !== excludeNodeId);
    if (active.length === 0) return null;
    active.sort((a, b) => {
      const latA = (a.metrics?.latency as number) ?? Infinity;
      const latB = (b.metrics?.latency as number) ?? Infinity;
      if (latA !== latB) return latA - latB;
      return (a.peerCount ?? 0) - (b.peerCount ?? 0);
    });
    return active[0];
  }

  processHeartbeat(nodeId: string, metrics?: Record<string, unknown>): HubRegistryEntry {
    const hub = this._hubs.get(nodeId);
    if (!hub) return this.upsert(nodeId, { metrics, state: "active" });
    hub.lastHeartbeat = Date.now();
    hub.consecutiveMisses = 0;
    hub.state = "active";
    if (metrics) {
      hub.metrics = { ...hub.metrics, ...metrics };
      hub.peerCount = (metrics.peerCount as number) ?? hub.peerCount;
    }
    this.emit("hub-heartbeat", hub);
    return hub;
  }

  detectFailures(): Array<{ nodeId: string; state: string; elapsed: number }> {
    const now = Date.now();
    const failures: Array<{ nodeId: string; state: string; elapsed: number }> = [];
    for (const hub of this._hubs.values()) {
      const elapsed = now - hub.lastHeartbeat;
      if (elapsed > this._deadTimeout && hub.state !== "dead") {
        hub.state = "dead" as HubEntryState;
        hub.consecutiveMisses++;
        this.emit("hub-dead", hub);
        failures.push({ nodeId: hub.nodeId, state: "dead", elapsed });
      } else if (elapsed > this._heartbeatTimeout && hub.state === "active") {
        hub.state = "suspect" as HubEntryState;
        hub.consecutiveMisses++;
        this.emit("hub-suspect", hub);
        failures.push({ nodeId: hub.nodeId, state: "suspect", elapsed });
      }
    }
    return failures;
  }

  getSyncPayload(): SyncPayload {
    return {
      hubs: this.list().map(h => ({
        nodeId: h.nodeId, name: h.name, endpoint: h.endpoint, state: h.state,
        epoch: h.epoch, promotedAt: h.promotedAt, promotedBy: h.promotedBy,
        metrics: h.metrics, peerCount: h.peerCount, region: h.region, lastHeartbeat: h.lastHeartbeat,
      })),
      epoch: this._epoch,
    };
  }

  applySync(remoteHubs: Array<Partial<HubRegistryEntry> & { nodeId: string }>, remoteEpoch: number): number {
    let updated = 0;
    for (const remote of remoteHubs) {
      const local = this._hubs.get(remote.nodeId);
      if (!local) {
        this._hubs.set(remote.nodeId, { ...remote, consecutiveMisses: 0 } as HubRegistryEntry);
        updated++;
        this.emit("hub-added", this._hubs.get(remote.nodeId));
      } else if ((remote.epoch ?? 0) > local.epoch) {
        this._hubs.set(remote.nodeId, { ...remote, consecutiveMisses: local.consecutiveMisses } as HubRegistryEntry);
        updated++;
        this.emit("hub-updated", this._hubs.get(remote.nodeId));
      }
    }
    if (remoteEpoch > this._epoch) {
      const remoteIds = new Set(remoteHubs.map(h => h.nodeId));
      for (const [nodeId, hub] of this._hubs) {
        if (!remoteIds.has(nodeId) && hub.state === ("dead" as HubEntryState)) {
          this._hubs.delete(nodeId);
          this.emit("hub-removed", hub);
          updated++;
        }
      }
      this._epoch = remoteEpoch;
    }
    if (updated > 0) this.emit("registry-synced", { updated, remoteEpoch });
    return updated;
  }

  startChecks(interval?: number): void {
    if (this._checkTimer) return;
    this._checkTimer = setInterval(() => this.detectFailures(), interval ?? 30000);
  }

  stopChecks(): void {
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
  }

  toJSON() {
    return { hubs: this.list(), activeCount: this.getActive().length, totalCount: this._hubs.size, epoch: this._epoch };
  }
}
