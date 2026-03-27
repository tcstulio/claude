// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// InfraAdopter — workflow to onboard infrastructure as network peers.

import { EventEmitter } from "node:events";
import { enrich } from "../capabilities.js";
import type { TrustGraph } from "../mesh/trust.js";

export const TYPE_CAPABILITIES: Record<string, string[]> = {
  proxmox: ["proxmox-vm", "proxmox-lxc", "compute", "backup", "monitoring"],
  docker: ["docker", "compute", "deploy"],
  "docker-tls": ["docker", "compute", "deploy"],
  portainer: ["docker", "compute", "deploy", "monitoring"],
  "portainer-tls": ["docker", "compute", "deploy", "monitoring"],
  ssh: ["ssh", "compute"],
  tulipa: ["chat", "relay"],
};

interface RegistryLike {
  upsert(nodeId: string, data: Record<string, unknown>): unknown;
  get(nodeId: string): { latency?: number; status?: string } | null;
  remove(nodeId: string): void;
  touch?(nodeId: string): void;
}

interface DiscoveredService {
  type: string; ip: string; port: number; endpoint: string; version?: string;
}

export class InfraAdopter extends EventEmitter {
  private _registry: RegistryLike;
  private _trust: TrustGraph | null;
  private _fetch: typeof globalThis.fetch;
  private _adopted = new Map<string, DiscoveredService & { credentials: Record<string, unknown>; adoptedAt: string }>();

  constructor(options: { registry: RegistryLike; trust?: TrustGraph; fetch?: typeof globalThis.fetch }) {
    super();
    this._registry = options.registry;
    this._trust = options.trust ?? null;
    this._fetch = options.fetch ?? globalThis.fetch;
  }

  adopt(discovered: DiscoveredService, credentials: Record<string, unknown> = {}) {
    const { type, ip, port, endpoint, version } = discovered;
    const nodeId = `infra_${type}_${ip.replace(/\./g, "-")}_${port}`;
    const caps = TYPE_CAPABILITIES[type] ?? ["compute"];
    const peer = this._registry.upsert(nodeId, {
      name: `${type}@${ip}:${port}`, capabilities: caps, endpoint,
      metadata: { infraType: type, version, ip, port, credentials: credentials.apiToken ? { apiToken: "***" } : {}, adoptedAt: new Date().toISOString(), isInfra: true },
    });
    if (this._trust) this._trust.setDirectTrust(nodeId, 0.7, "infra-adopt-lan");
    this._adopted.set(nodeId, { ...discovered, credentials, adoptedAt: new Date().toISOString() });
    this.emit("adopted", { nodeId, type, endpoint, capabilities: caps });
    return { nodeId, peer, capabilities: enrich(caps), status: "adopted" };
  }

  async test(nodeId: string): Promise<{ ok: boolean; latency?: number; error?: string }> {
    const info = this._adopted.get(nodeId);
    if (!info) return { ok: false, error: "Service not adopted" };
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const healthPath = this._getHealthPath(info.type);
        const res = await this._fetch(`${info.endpoint}${healthPath}`, { signal: controller.signal, headers: this._getAuthHeaders(info) });
        const latency = Date.now() - start;
        return res.ok ? { ok: true, latency } : { ok: false, latency, error: `HTTP ${res.status}` };
      } finally { clearTimeout(timer); }
    } catch (err: unknown) { return { ok: false, latency: Date.now() - start, error: (err as Error).message }; }
  }

  remove(nodeId: string): boolean { this._adopted.delete(nodeId); this._registry.remove(nodeId); this.emit("removed", { nodeId }); return true; }

  list() {
    return [...this._adopted.entries()].map(([nodeId, info]) => ({
      nodeId, type: info.type, endpoint: info.endpoint, version: info.version,
      status: this._registry.get(nodeId)?.status ?? "unknown", adoptedAt: info.adoptedAt,
    }));
  }

  private _getHealthPath(type: string): string {
    const paths: Record<string, string> = { proxmox: "/api2/json/version", docker: "/version", "docker-tls": "/version", portainer: "/api/status", "portainer-tls": "/api/status", tulipa: "/api/health" };
    return paths[type] ?? "/";
  }

  private _getAuthHeaders(info: DiscoveredService & { credentials: Record<string, unknown> }): Record<string, string> {
    const headers: Record<string, string> = { Accept: "application/json" };
    const token = info.credentials?.apiToken as string;
    if (token) headers.Authorization = info.type === "proxmox" ? `PVEAPIToken=${token}` : `Bearer ${token}`;
    return headers;
  }
}
