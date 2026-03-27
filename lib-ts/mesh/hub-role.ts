// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// HubRole — state machine managing a node's hub role.

import { EventEmitter } from "node:events";
import os from "node:os";

export type HubState = "leaf" | "candidate" | "nominated" | "promoting" | "active" | "demoting";

export const HUB_STATES: HubState[] = ["leaf", "candidate", "nominated", "promoting", "active", "demoting"];

export const VALID_TRANSITIONS: Record<HubState, HubState[]> = {
  leaf: ["candidate"],
  candidate: ["nominated", "leaf"],
  nominated: ["promoting", "leaf"],
  promoting: ["active", "leaf"],
  active: ["demoting"],
  demoting: ["leaf"],
};

export interface HubMetrics {
  cpu: number;
  memoryUsed: number;
  memoryTotal: number;
  uptime: number;
  requestsPerMin: number;
  peerCount: number;
  loadAvg: number;
  platform: string;
  arch: string;
  state: HubState;
  epoch: number;
  isHub: boolean;
  promotedAt: number | null;
}

export class HubRole extends EventEmitter {
  private _state: HubState = "leaf";
  private _epoch = 0;
  private _promotedAt: number | null = null;
  private _demotedAt: number | null = null;
  private _promotedBy: string | null = null;
  private _metrics: Partial<HubMetrics> = {};
  private _metricsInterval: number;
  private _metricsTimer: ReturnType<typeof setInterval> | null = null;
  private _startedAt = Date.now();
  private _requestCount = 0;
  private _platformCapabilities: string[] = [];

  constructor(options: { initialRole?: string; metricsInterval?: number } = {}) {
    super();
    this._metricsInterval = options.metricsInterval ?? 15000;
    if (options.initialRole === "hub") {
      this._state = "active";
      this._promotedAt = Date.now();
      this._promotedBy = "bootstrap";
      this._epoch = 1;
    }
  }

  get state(): HubState { return this._state; }
  get epoch(): number { return this._epoch; }
  get isHub(): boolean { return this._state === "active"; }
  get isCandidate(): boolean { return this._state === "candidate" || this._state === "nominated"; }
  get isLeaf(): boolean { return this._state === "leaf"; }
  get uptime(): number { return Date.now() - this._startedAt; }

  get capabilities(): string[] {
    const base = this.isHub ? ["hub", "relay"] : ["relay"];
    return [...new Set([...base, ...this._platformCapabilities])];
  }

  setPlatformCapabilities(caps: string[]): void {
    this._platformCapabilities = caps ?? [];
  }

  private _transition(newState: HubState, meta: Record<string, unknown> = {}): { from: HubState; to: HubState; epoch: number } {
    const valid = VALID_TRANSITIONS[this._state];
    if (!valid?.includes(newState)) {
      throw new Error(`Invalid transition: ${this._state} → ${newState}`);
    }
    const oldState = this._state;
    this._state = newState;
    this._epoch++;
    this.emit("transition", { from: oldState, to: newState, epoch: this._epoch, ...meta });
    return { from: oldState, to: newState, epoch: this._epoch };
  }

  selfNominate(reason: string) { return this._transition("candidate", { reason, by: "self" }); }

  nominate(proposerId: string, reason: string) {
    if (this._state === "leaf") this._transition("candidate", { reason, by: proposerId });
    return this._transition("nominated", { reason, by: proposerId });
  }

  promote(epoch: number, promotedBy: string) {
    if (this._state === "nominated" || this._state === "candidate") {
      if (this._state === "candidate") this._transition("nominated", { by: promotedBy });
    }
    this._transition("promoting", { by: promotedBy });
    this._promotedAt = Date.now();
    this._promotedBy = promotedBy;
    return this._transition("active", { epoch, by: promotedBy });
  }

  demote(reason: string, demotedBy: string) {
    this._transition("demoting", { reason, by: demotedBy });
    this._demotedAt = Date.now();
    this._promotedAt = null;
    return this._transition("leaf", { reason, by: demotedBy });
  }

  cancelNomination(reason: string): void {
    if (this._state === "candidate" || this._state === "nominated" || this._state === "promoting") {
      const oldState = this._state;
      this._state = "leaf";
      this._epoch++;
      this.emit("transition", { from: oldState, to: "leaf", reason, epoch: this._epoch });
    }
  }

  trackRequest(): void { this._requestCount++; }

  collectMetrics(): HubMetrics {
    const cpus = os.cpus();
    let cpuUsage = 0;
    if (cpus.length > 0) {
      const totals = cpus.reduce((acc, cpu) => {
        acc.idle += cpu.times.idle;
        acc.total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
        return acc;
      }, { idle: 0, total: 0 });
      cpuUsage = Math.round((1 - totals.idle / totals.total) * 100);
    }
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    this._metrics = {
      cpu: cpuUsage,
      memoryUsed: Math.round(((totalMem - freeMem) / totalMem) * 100),
      memoryTotal: Math.round(totalMem / 1024 / 1024),
      uptime: this.uptime,
      requestsPerMin: this._requestCount,
      peerCount: 0,
      loadAvg: os.loadavg()[0],
      platform: os.platform(),
      arch: os.arch(),
      state: this._state,
      epoch: this._epoch,
      isHub: this.isHub,
      promotedAt: this._promotedAt,
    };
    this._requestCount = 0;
    return this._metrics as HubMetrics;
  }

  startMetrics(): void {
    if (this._metricsTimer) return;
    this.collectMetrics();
    this._metricsTimer = setInterval(() => this.collectMetrics(), this._metricsInterval);
  }

  stopMetrics(): void {
    if (this._metricsTimer) { clearInterval(this._metricsTimer); this._metricsTimer = null; }
  }

  toJSON() {
    return {
      state: this._state, epoch: this._epoch, isHub: this.isHub, uptime: this.uptime,
      promotedAt: this._promotedAt, promotedBy: this._promotedBy,
      metrics: this._metrics, capabilities: this.capabilities,
    };
  }
}
