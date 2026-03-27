// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { execSync } from 'node:child_process';

export const ROUTE_TYPES = ['lan', 'vpn', 'tunnel', 'public'] as const;
export type RouteType = (typeof ROUTE_TYPES)[number];

const PROBE_TIMEOUT = 5000;

export const PRIORITY: Record<RouteType, number> = { lan: 0, vpn: 10, tunnel: 20, public: 30 };

interface Route {
  type: RouteType | string;
  endpoint: string;
  priority: number;
  latency: number | null;
  reachable: boolean | null;
  lastTested: string | null;
}

interface ProbeResult {
  ok: boolean;
  status?: number;
  error?: string;
  latency: number;
}

interface ResolvedRoute {
  endpoint: string;
  type: RouteType | string;
  latency: number;
  testedAt: number;
}

interface TestResult {
  type: RouteType | string;
  endpoint: string;
  ok: boolean;
  status?: number;
  error?: string;
  latency: number;
}

interface NetworkInterface {
  ip: string;
  netmask?: string;
  cidr?: string;
}

interface LocalInterfaces {
  interfaces: NetworkInterface[];
  subnets: string[];
}

interface PeerInfo {
  ip?: string;
  port?: number;
  tls?: boolean;
  vpnIp?: string;
  tunnelUrl?: string;
  endpoint?: string;
}

interface ResolveOptions {
  force?: boolean;
  healthPath?: string;
}

type FetchFn = typeof globalThis.fetch;

interface NetworkRoutesOptions {
  fetch?: FetchFn;
  probeTimeout?: number;
  cacheTtl?: number;
}

interface NetworkRoutesJSON {
  localNetwork: LocalInterfaces | null;
  peers: Record<string, Route[]>;
  cache: Record<string, ResolvedRoute>;
}

export class NetworkRoutes {
  private _fetch: FetchFn;
  private _probeTimeout: number;
  private _routes: Map<string, Route[]>;
  private _localInterfaces: LocalInterfaces | null;
  private _resolveCache: Map<string, ResolvedRoute>;
  private _cacheTtl: number;

  constructor(options: NetworkRoutesOptions = {}) {
    this._fetch = options.fetch || globalThis.fetch;
    this._probeTimeout = options.probeTimeout ?? PROBE_TIMEOUT;
    this._routes = new Map();
    this._localInterfaces = null;
    this._resolveCache = new Map();
    this._cacheTtl = options.cacheTtl || 5 * 60 * 1000;
  }

  setRoutes(nodeId: string, routes: Partial<Route>[]): void {
    const sorted = routes
      .map(r => ({
        ...r,
        type: r.type ?? 'public',
        endpoint: r.endpoint ?? '',
        priority: r.priority ?? PRIORITY[r.type as RouteType] ?? 50,
        latency: r.latency ?? null,
        reachable: r.reachable ?? null,
        lastTested: r.lastTested ?? null,
      } as Route))
      .sort((a, b) => a.priority - b.priority);
    this._routes.set(nodeId, sorted);
    this._resolveCache.delete(nodeId);
  }

  addRoute(nodeId: string, route: Partial<Route>): void {
    const existing = this._routes.get(nodeId) || [];
    if (existing.some(r => r.endpoint === route.endpoint)) return;
    existing.push({
      ...route,
      type: route.type ?? 'public',
      endpoint: route.endpoint ?? '',
      priority: route.priority ?? PRIORITY[route.type as RouteType] ?? 50,
      latency: route.latency ?? null,
      reachable: route.reachable ?? null,
      lastTested: route.lastTested ?? null,
    } as Route);
    existing.sort((a, b) => a.priority - b.priority);
    this._routes.set(nodeId, existing);
    this._resolveCache.delete(nodeId);
  }

  async resolve(nodeId: string, options: ResolveOptions = {}): Promise<ResolvedRoute | null> {
    if (!options.force) {
      const cached = this._resolveCache.get(nodeId);
      if (cached && Date.now() - cached.testedAt < this._cacheTtl) return cached;
    }
    const routes = this._routes.get(nodeId);
    if (!routes || routes.length === 0) return null;
    const healthPath = options.healthPath || '/api/health';
    for (const route of routes) {
      const result = await this._probe(route.endpoint, healthPath);
      route.lastTested = new Date().toISOString();
      route.latency = result.latency;
      route.reachable = result.ok;
      if (result.ok) {
        const resolved: ResolvedRoute = { endpoint: route.endpoint, type: route.type, latency: result.latency, testedAt: Date.now() };
        this._resolveCache.set(nodeId, resolved);
        return resolved;
      }
    }
    return null;
  }

  async testAll(nodeId: string, healthPath: string = '/api/health'): Promise<TestResult[]> {
    const routes = this._routes.get(nodeId) || [];
    const results: TestResult[] = [];
    for (const route of routes) {
      const result = await this._probe(route.endpoint, healthPath);
      route.lastTested = new Date().toISOString();
      route.latency = result.latency;
      route.reachable = result.ok;
      results.push({ type: route.type, endpoint: route.endpoint, ...result });
    }
    return results;
  }

  detectLocalNetwork(): LocalInterfaces {
    const interfaces: NetworkInterface[] = [];
    try {
      const output = execSync('ifconfig 2>/dev/null || ip addr show 2>/dev/null', { encoding: 'utf-8', timeout: 5000 });
      const inetRegex = /inet\s+(\d+\.\d+\.\d+\.\d+)\s+.*?netmask\s+(\S+)/g;
      const inetAltRegex = /inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/g;
      let match: RegExpExecArray | null;
      while ((match = inetRegex.exec(output)) !== null) {
        if (match[1] !== '127.0.0.1') interfaces.push({ ip: match[1], netmask: match[2] });
      }
      while ((match = inetAltRegex.exec(output)) !== null) {
        if (match[1] !== '127.0.0.1') interfaces.push({ ip: match[1], cidr: match[2] });
      }
    } catch {
      // Ignore errors from network detection commands
    }
    const subnets = interfaces.map(iface => {
      const parts = iface.ip.split('.');
      return `${parts[0]}.${parts[1]}.${parts[2]}`;
    });
    this._localInterfaces = { interfaces, subnets };
    return this._localInterfaces;
  }

  classifyIP(ip: string): RouteType {
    if (!this._localInterfaces) this.detectLocalNetwork();
    const parts = ip.split('.');
    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;
    if (this._localInterfaces?.subnets.includes(subnet)) return 'lan';
    if (ip.startsWith('100.') || ip.startsWith('10.') || ip.startsWith('172.16.')) return 'vpn';
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) return 'vpn';
    return 'public';
  }

  autoRegister(nodeId: string, peerInfo: PeerInfo): Partial<Route>[] {
    const routes: Partial<Route>[] = [];
    if (peerInfo.ip && peerInfo.port) {
      const type = this.classifyIP(peerInfo.ip);
      const proto = peerInfo.tls ? 'https' : 'http';
      routes.push({ type, endpoint: `${proto}://${peerInfo.ip}:${peerInfo.port}` });
    }
    if (peerInfo.vpnIp && peerInfo.port) routes.push({ type: 'vpn', endpoint: `http://${peerInfo.vpnIp}:${peerInfo.port}` });
    if (peerInfo.tunnelUrl) routes.push({ type: 'tunnel', endpoint: peerInfo.tunnelUrl });
    if (peerInfo.endpoint && !routes.some(r => r.endpoint === peerInfo.endpoint)) {
      const isExternal = peerInfo.endpoint.startsWith('https://') && !peerInfo.endpoint.match(/\d+\.\d+\.\d+\.\d+/);
      routes.push({
        type: isExternal ? 'tunnel' : this.classifyIP(peerInfo.endpoint.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || ''),
        endpoint: peerInfo.endpoint,
      });
    }
    if (routes.length > 0) this.setRoutes(nodeId, routes);
    return routes;
  }

  getRoutes(nodeId: string): Route[] {
    return this._routes.get(nodeId) || [];
  }

  getAllRoutes(): Record<string, Route[]> {
    const result: Record<string, Route[]> = {};
    for (const [nodeId, routes] of this._routes) result[nodeId] = routes;
    return result;
  }

  private async _probe(endpoint: string, healthPath: string): Promise<ProbeResult> {
    const url = `${endpoint.replace(/\/$/, '')}${healthPath}`;
    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._probeTimeout);
      try {
        const res = await this._fetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
        return { ok: res.ok, status: res.status, latency: Date.now() - start };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { ok: false, error, latency: Date.now() - start };
    }
  }

  toJSON(): NetworkRoutesJSON {
    return {
      localNetwork: this._localInterfaces,
      peers: this.getAllRoutes(),
      cache: Object.fromEntries(this._resolveCache),
    };
  }
}
