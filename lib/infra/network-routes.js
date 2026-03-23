'use strict';

/**
 * NetworkRoutes — resolve a melhor rota para acessar um peer.
 *
 * Cada peer pode ter múltiplas rotas de acesso:
 *   - lan: IP direto na mesma subnet (mais rápido, sem auth extra)
 *   - vpn: IP via VPN (Tailscale, WireGuard — cross-subnet)
 *   - tunnel: URL via Cloudflare/ngrok (externo, mais lento)
 *   - public: IP público com port forward
 *
 * O sistema tenta na ordem de prioridade e cacheia qual rota funciona.
 *
 * Também detecta a topologia da rede local para saber quais subnets
 * são acessíveis diretamente.
 */

const { execSync } = require('child_process');

const ROUTE_TYPES = ['lan', 'vpn', 'tunnel', 'public'];
const PROBE_TIMEOUT = 5000; // 5s

/**
 * @typedef {Object} Route
 * @property {string} type - 'lan' | 'vpn' | 'tunnel' | 'public'
 * @property {string} endpoint - URL completa (http://ip:port ou https://domain)
 * @property {number} priority - menor = melhor (0 = lan, 10 = vpn, 20 = tunnel, 30 = public)
 * @property {number|null} latency - ms da última probe (null = não testado)
 * @property {boolean} reachable - última probe foi sucesso?
 * @property {string|null} lastTested - ISO timestamp
 */

const PRIORITY = { lan: 0, vpn: 10, tunnel: 20, public: 30 };

class NetworkRoutes {
  /**
   * @param {object} options
   * @param {function} [options.fetch] - fetch function
   * @param {number} [options.probeTimeout] - timeout por probe (ms)
   */
  constructor(options = {}) {
    this._fetch = options.fetch || globalThis.fetch;
    this._probeTimeout = options.probeTimeout ?? PROBE_TIMEOUT;

    // Rotas por peer: Map<nodeId, Route[]>
    this._routes = new Map();

    // Interfaces locais detectadas
    this._localInterfaces = null;

    // Cache de resolução: Map<nodeId, { endpoint, type, testedAt }>
    this._resolveCache = new Map();
    this._cacheTtl = options.cacheTtl || 5 * 60 * 1000; // 5 min
  }

  /**
   * Registra rotas para um peer.
   * @param {string} nodeId
   * @param {Route[]} routes
   */
  setRoutes(nodeId, routes) {
    const sorted = routes
      .map(r => ({
        ...r,
        priority: r.priority ?? PRIORITY[r.type] ?? 50,
        latency: r.latency ?? null,
        reachable: r.reachable ?? null,
        lastTested: r.lastTested ?? null,
      }))
      .sort((a, b) => a.priority - b.priority);

    this._routes.set(nodeId, sorted);
    this._resolveCache.delete(nodeId);
  }

  /**
   * Adiciona uma rota a um peer.
   */
  addRoute(nodeId, route) {
    const existing = this._routes.get(nodeId) || [];
    // Evitar duplicatas por endpoint
    if (existing.some(r => r.endpoint === route.endpoint)) return;

    existing.push({
      ...route,
      priority: route.priority ?? PRIORITY[route.type] ?? 50,
      latency: route.latency ?? null,
      reachable: route.reachable ?? null,
      lastTested: route.lastTested ?? null,
    });

    existing.sort((a, b) => a.priority - b.priority);
    this._routes.set(nodeId, existing);
    this._resolveCache.delete(nodeId);
  }

  /**
   * Resolve a melhor rota funcional para um peer.
   * Testa cada rota na ordem de prioridade até encontrar uma que responde.
   *
   * @param {string} nodeId
   * @param {object} [options]
   * @param {boolean} [options.force] - ignorar cache
   * @param {string} [options.healthPath] - path para health check (default: /api/health)
   * @returns {Promise<{endpoint: string, type: string, latency: number}|null>}
   */
  async resolve(nodeId, options = {}) {
    // Check cache
    if (!options.force) {
      const cached = this._resolveCache.get(nodeId);
      if (cached && Date.now() - cached.testedAt < this._cacheTtl) {
        return cached;
      }
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
        const resolved = {
          endpoint: route.endpoint,
          type: route.type,
          latency: result.latency,
          testedAt: Date.now(),
        };
        this._resolveCache.set(nodeId, resolved);
        return resolved;
      }
    }

    return null;
  }

  /**
   * Testa todas as rotas de um peer e retorna o status de cada.
   */
  async testAll(nodeId, healthPath = '/api/health') {
    const routes = this._routes.get(nodeId) || [];
    const results = [];

    for (const route of routes) {
      const result = await this._probe(route.endpoint, healthPath);
      route.lastTested = new Date().toISOString();
      route.latency = result.latency;
      route.reachable = result.ok;

      results.push({
        type: route.type,
        endpoint: route.endpoint,
        ...result,
      });
    }

    return results;
  }

  /**
   * Detecta interfaces de rede locais e subnets acessíveis.
   * @returns {{ interfaces: Array, subnets: string[] }}
   */
  detectLocalNetwork() {
    const interfaces = [];

    try {
      // Tentar ifconfig (Termux/Linux)
      const output = execSync('ifconfig 2>/dev/null || ip addr show 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const inetRegex = /inet\s+(\d+\.\d+\.\d+\.\d+)\s+.*?netmask\s+(\S+)/g;
      const inetAltRegex = /inet\s+(\d+\.\d+\.\d+\.\d+)\/(\d+)/g;
      let match;

      while ((match = inetRegex.exec(output)) !== null) {
        if (match[1] !== '127.0.0.1') {
          interfaces.push({ ip: match[1], netmask: match[2] });
        }
      }
      while ((match = inetAltRegex.exec(output)) !== null) {
        if (match[1] !== '127.0.0.1') {
          interfaces.push({ ip: match[1], cidr: match[2] });
        }
      }
    } catch {
      // Sem acesso a ifconfig/ip
    }

    // Extrair subnets
    const subnets = interfaces.map(iface => {
      const parts = iface.ip.split('.');
      return `${parts[0]}.${parts[1]}.${parts[2]}`;
    });

    this._localInterfaces = { interfaces, subnets };
    return this._localInterfaces;
  }

  /**
   * Dado um IP, determina o tipo de rota mais provável.
   */
  classifyIP(ip) {
    if (!this._localInterfaces) this.detectLocalNetwork();

    const parts = ip.split('.');
    const subnet = `${parts[0]}.${parts[1]}.${parts[2]}`;

    // LAN direta
    if (this._localInterfaces?.subnets.includes(subnet)) {
      return 'lan';
    }

    // VPN ranges comuns
    if (ip.startsWith('100.') || ip.startsWith('10.') || ip.startsWith('172.16.')) {
      return 'vpn';
    }

    // Private ranges (outra subnet)
    if (ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('172.')) {
      return 'vpn'; // Precisa de rota/VPN para chegar
    }

    return 'public';
  }

  /**
   * Cria rotas automaticamente a partir de informações do peer.
   *
   * @param {string} nodeId
   * @param {object} peerInfo - { ip, port, endpoint, tunnelUrl, vpnIp, ... }
   */
  autoRegister(nodeId, peerInfo) {
    const routes = [];

    // LAN/VPN por IP
    if (peerInfo.ip && peerInfo.port) {
      const type = this.classifyIP(peerInfo.ip);
      const proto = peerInfo.tls ? 'https' : 'http';
      routes.push({
        type,
        endpoint: `${proto}://${peerInfo.ip}:${peerInfo.port}`,
      });
    }

    // VPN IP separado
    if (peerInfo.vpnIp && peerInfo.port) {
      routes.push({
        type: 'vpn',
        endpoint: `http://${peerInfo.vpnIp}:${peerInfo.port}`,
      });
    }

    // Cloudflare tunnel / external URL
    if (peerInfo.tunnelUrl) {
      routes.push({
        type: 'tunnel',
        endpoint: peerInfo.tunnelUrl,
      });
    }

    // Endpoint genérico (classificar pelo conteúdo)
    if (peerInfo.endpoint && !routes.some(r => r.endpoint === peerInfo.endpoint)) {
      const isExternal = peerInfo.endpoint.startsWith('https://') &&
        !peerInfo.endpoint.match(/\d+\.\d+\.\d+\.\d+/);
      routes.push({
        type: isExternal ? 'tunnel' : this.classifyIP(peerInfo.endpoint.match(/\d+\.\d+\.\d+\.\d+/)?.[0] || ''),
        endpoint: peerInfo.endpoint,
      });
    }

    if (routes.length > 0) {
      this.setRoutes(nodeId, routes);
    }

    return routes;
  }

  /**
   * Retorna todas as rotas de um peer.
   */
  getRoutes(nodeId) {
    return this._routes.get(nodeId) || [];
  }

  /**
   * Retorna todas as rotas de todos os peers.
   */
  getAllRoutes() {
    const result = {};
    for (const [nodeId, routes] of this._routes) {
      result[nodeId] = routes;
    }
    return result;
  }

  /**
   * @private
   */
  async _probe(endpoint, healthPath) {
    const url = `${endpoint.replace(/\/$/, '')}${healthPath}`;
    const start = Date.now();

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this._probeTimeout);

      try {
        const res = await this._fetch(url, {
          signal: controller.signal,
          headers: { Accept: 'application/json' },
        });

        return {
          ok: res.ok,
          status: res.status,
          latency: Date.now() - start,
        };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return {
        ok: false,
        error: err.message,
        latency: Date.now() - start,
      };
    }
  }

  toJSON() {
    return {
      localNetwork: this._localInterfaces,
      peers: this.getAllRoutes(),
      cache: Object.fromEntries(this._resolveCache),
    };
  }
}

module.exports = { NetworkRoutes, ROUTE_TYPES, PRIORITY };
