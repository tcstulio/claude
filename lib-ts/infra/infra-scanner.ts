// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';

interface ServiceDefinition {
  type: string;
  port: number;
  path: string;
  tls: boolean;
  detect: (data: Record<string, unknown>) => unknown;
}

interface ProbeResult {
  type: string;
  ip: string;
  port: number;
  endpoint: string;
  version: string | undefined;
  raw: Record<string, unknown>;
  detectedAt: string;
}

interface HostRange {
  start: number;
  end: number;
}

interface ScannerOptions {
  fetch?: typeof globalThis.fetch;
  subnets?: string[];
  timeout?: number;
  hostRange?: HostRange;
  extraServices?: ServiceDefinition[];
}

interface ScanSubnetsOptions {
  subnets?: string[];
  concurrency?: number;
}

interface LastScanResult {
  timestamp: string;
  subnets: string[];
  found: number;
  results: ProbeResult[];
}

export const KNOWN_SERVICES: ServiceDefinition[] = [
  { type: 'proxmox',       port: 8006, path: '/api2/json/version', tls: true,  detect: (d) => (d as Record<string, Record<string, unknown>>)?.data?.version },
  { type: 'docker',        port: 2375, path: '/version',           tls: false, detect: (d) => d?.ApiVersion },
  { type: 'docker-tls',    port: 2376, path: '/version',           tls: true,  detect: (d) => d?.ApiVersion },
  { type: 'portainer',     port: 9000, path: '/api/status',        tls: false, detect: (d) => d?.Version },
  { type: 'portainer-tls', port: 9443, path: '/api/status',        tls: true,  detect: (d) => d?.Version },
  { type: 'tulipa',        port: 3000, path: '/api/health',        tls: false, detect: (d) => d?.service === 'tulipa-gateway' || d?.status === 'ok' },
];

const DEFAULT_TIMEOUT = 3000;
const DEFAULT_SUBNETS = ['192.168.1', '192.168.15', '10.0.0'];

export class InfraScanner extends EventEmitter {
  private _fetch: typeof globalThis.fetch;
  private _subnets: string[];
  private _timeout: number;
  private _hostRange: HostRange;
  private _services: ServiceDefinition[];
  private _lastScan: LastScanResult | null;

  constructor(options: ScannerOptions = {}) {
    super();
    this._fetch = options.fetch || globalThis.fetch;
    this._subnets = options.subnets || DEFAULT_SUBNETS;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._hostRange = options.hostRange || { start: 1, end: 254 };
    this._services = [...KNOWN_SERVICES, ...(options.extraServices || [])];
    this._lastScan = null;
  }

  async probe(ip: string, service: ServiceDefinition): Promise<ProbeResult | null> {
    const protocol = service.tls ? 'https' : 'http';
    const endpoint = `${protocol}://${ip}:${service.port}`;
    const url = `${endpoint}${service.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const res = await this._fetch(url, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        ...(service.tls ? { rejectUnauthorized: false } : {}),
      } as RequestInit);

      if (!res.ok) return null;

      const data = (await res.json()) as Record<string, unknown>;
      if (service.detect(data)) {
        const result: ProbeResult = {
          type: service.type,
          ip,
          port: service.port,
          endpoint,
          version: this._extractVersion(data, service.type),
          raw: data,
          detectedAt: new Date().toISOString(),
        };
        this.emit('discovered', result);
        return result;
      }
    } catch {
      // Host unreachable or timeout
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  async scanHost(ip: string): Promise<ProbeResult[]> {
    const results = await Promise.allSettled(
      this._services.map((svc) => this.probe(ip, svc)),
    );
    return results
      .filter(
        (r): r is PromiseFulfilledResult<ProbeResult | null> =>
          r.status === 'fulfilled' && r.value !== null,
      )
      .map((r) => r.value!);
  }

  async scanEndpoints(endpoints: string[]): Promise<ProbeResult[]> {
    const results: ProbeResult[] = [];

    for (const ep of endpoints) {
      const [ip, portStr] = ep.split(':');
      if (portStr) {
        const port = parseInt(portStr, 10);
        const service = this._services.find((s) => s.port === port);
        if (service) {
          const r = await this.probe(ip, service);
          if (r) results.push(r);
        }
      } else {
        const found = await this.scanHost(ip);
        results.push(...found);
      }
    }

    return results;
  }

  async scanSubnets(options: ScanSubnetsOptions = {}): Promise<ProbeResult[]> {
    const subnets = options.subnets || this._subnets;
    const concurrency = options.concurrency || 20;
    const results: ProbeResult[] = [];

    for (const subnet of subnets) {
      this.emit('scan-subnet', { subnet });
      const hosts: string[] = [];
      for (let i = this._hostRange.start; i <= this._hostRange.end; i++) {
        hosts.push(`${subnet}.${i}`);
      }

      for (let i = 0; i < hosts.length; i += concurrency) {
        const batch = hosts.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map((ip) => this.scanHost(ip)),
        );
        for (const r of batchResults) {
          if (r.status === 'fulfilled' && r.value.length > 0) {
            results.push(...r.value);
          }
        }
      }
    }

    this._lastScan = {
      timestamp: new Date().toISOString(),
      subnets,
      found: results.length,
      results,
    };

    this.emit('scan-complete', this._lastScan);
    return results;
  }

  getLastScan(): LastScanResult | null {
    return this._lastScan;
  }

  private _extractVersion(data: Record<string, unknown>, type: string): string | undefined {
    switch (type) {
      case 'proxmox': {
        const d = data as { data?: { version?: string; release?: string } };
        return d?.data?.version || d?.data?.release;
      }
      case 'docker':
      case 'docker-tls':
        return (data?.Version as string) || (data?.ApiVersion as string);
      case 'portainer':
      case 'portainer-tls':
        return data?.Version as string;
      case 'tulipa':
        return (data?.version as string) || 'unknown';
      default:
        return 'unknown';
    }
  }
}
