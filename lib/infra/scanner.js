'use strict';

const { EventEmitter } = require('events');

/**
 * InfraScanner — auto-discovery de serviços de infra na LAN.
 *
 * Escaneia IPs/portas conhecidas para detectar:
 *   - Proxmox VE (:8006)
 *   - Docker API (:2375, :2376)
 *   - Portainer (:9000, :9443)
 *   - Tulipa agents (:3000)
 *   - SSH (:22)
 *
 * Não faz brute force — tenta apenas portas/APIs conhecidas.
 */

const KNOWN_SERVICES = [
  { type: 'proxmox',   port: 8006, path: '/api2/json/version', tls: true,  detect: (d) => d?.data?.version },
  { type: 'docker',    port: 2375, path: '/version',           tls: false, detect: (d) => d?.ApiVersion },
  { type: 'docker-tls',port: 2376, path: '/version',           tls: true,  detect: (d) => d?.ApiVersion },
  { type: 'portainer', port: 9000, path: '/api/status',        tls: false, detect: (d) => d?.Version },
  { type: 'portainer-tls', port: 9443, path: '/api/status',    tls: true,  detect: (d) => d?.Version },
  { type: 'tulipa',    port: 3000, path: '/api/health',        tls: false, detect: (d) => d?.service === 'tulipa-gateway' || d?.status === 'ok' },
];

const DEFAULT_TIMEOUT = 3000;      // 3s por probe
const DEFAULT_SUBNETS = ['192.168.1', '192.168.15', '10.0.0'];

class InfraScanner extends EventEmitter {
  /**
   * @param {object} options
   * @param {function} options.fetch — fetch function
   * @param {string[]} [options.subnets] — subnets a escanear (ex: ['192.168.1'])
   * @param {number} [options.timeout] — timeout por probe (ms)
   * @param {number[]} [options.hostRange] — range de hosts (default [1..254])
   * @param {Array} [options.extraServices] — serviços adicionais para detectar
   */
  constructor(options = {}) {
    super();
    this._fetch = options.fetch || globalThis.fetch;
    this._subnets = options.subnets || DEFAULT_SUBNETS;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._hostRange = options.hostRange || { start: 1, end: 254 };
    this._services = [...KNOWN_SERVICES, ...(options.extraServices || [])];
    this._lastScan = null;
  }

  /**
   * Escaneia um único endpoint (ip:port) por um serviço específico.
   *
   * @param {string} ip
   * @param {object} service — { type, port, path, tls, detect }
   * @returns {Promise<object|null>} { type, ip, port, endpoint, version, raw } ou null
   */
  async probe(ip, service) {
    const protocol = service.tls ? 'https' : 'http';
    const endpoint = `${protocol}://${ip}:${service.port}`;
    const url = `${endpoint}${service.path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this._timeout);

    try {
      const res = await this._fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json' },
        // Para APIs com TLS self-signed (Proxmox)
        ...(service.tls ? { rejectUnauthorized: false } : {}),
      });

      if (!res.ok) return null;

      const data = await res.json();
      if (service.detect(data)) {
        const result = {
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
      // Host inacessível ou timeout — normal
    } finally {
      clearTimeout(timer);
    }
    return null;
  }

  /**
   * Escaneia um IP específico por todos os serviços conhecidos.
   *
   * @param {string} ip
   * @returns {Promise<Array>} serviços encontrados
   */
  async scanHost(ip) {
    const results = await Promise.allSettled(
      this._services.map(svc => this.probe(ip, svc))
    );
    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value);
  }

  /**
   * Escaneia endpoints específicos (sem varrer toda a subnet).
   * Mais rápido e preciso quando se sabe os IPs.
   *
   * @param {string[]} endpoints — ['192.168.1.100:8006', '10.0.0.5']
   * @returns {Promise<Array>} serviços encontrados
   */
  async scanEndpoints(endpoints) {
    const results = [];

    for (const ep of endpoints) {
      const [ip, portStr] = ep.split(':');
      if (portStr) {
        // Porta específica — encontrar o serviço dessa porta
        const port = parseInt(portStr, 10);
        const service = this._services.find(s => s.port === port);
        if (service) {
          const r = await this.probe(ip, service);
          if (r) results.push(r);
        }
      } else {
        // IP sem porta — escanear todas as portas conhecidas
        const found = await this.scanHost(ip);
        results.push(...found);
      }
    }

    return results;
  }

  /**
   * Escaneia subnets configuradas (varredura completa).
   * CUIDADO: pode ser lento (254 hosts × N serviços).
   *
   * @param {object} [options]
   * @param {string[]} [options.subnets] — override de subnets
   * @param {number} [options.concurrency] — max probes simultâneos (default 20)
   * @returns {Promise<Array>} serviços encontrados
   */
  async scanSubnets(options = {}) {
    const subnets = options.subnets || this._subnets;
    const concurrency = options.concurrency || 20;
    const results = [];

    for (const subnet of subnets) {
      this.emit('scan-subnet', { subnet });
      const hosts = [];
      for (let i = this._hostRange.start; i <= this._hostRange.end; i++) {
        hosts.push(`${subnet}.${i}`);
      }

      // Processar em batches para não sobrecarregar
      for (let i = 0; i < hosts.length; i += concurrency) {
        const batch = hosts.slice(i, i + concurrency);
        const batchResults = await Promise.allSettled(
          batch.map(ip => this.scanHost(ip))
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

  /**
   * Retorna resultado do último scan.
   */
  getLastScan() {
    return this._lastScan;
  }

  /**
   * Extrai versão do response conforme o tipo de serviço.
   * @private
   */
  _extractVersion(data, type) {
    switch (type) {
      case 'proxmox': return data?.data?.version || data?.data?.release;
      case 'docker':
      case 'docker-tls': return data?.Version || data?.ApiVersion;
      case 'portainer':
      case 'portainer-tls': return data?.Version;
      case 'tulipa': return data?.version || 'unknown';
      default: return 'unknown';
    }
  }
}

module.exports = { InfraScanner, KNOWN_SERVICES };
