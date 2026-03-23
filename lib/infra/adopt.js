'use strict';

const { EventEmitter } = require('events');
const capabilities = require('../capabilities');

/**
 * InfraAdopter — workflow de adoção de infra como peer na rede Tulipa.
 *
 * Fluxo:
 *   1. Scanner descobre serviço (ex: Proxmox em 192.168.1.100:8006)
 *   2. adopt() detecta tipo e cria peer no registry
 *   3. Registra capabilities de infra apropriadas
 *   4. Configura credenciais (se fornecidas)
 *   5. Testa conectividade
 *
 * Tipos suportados:
 *   - proxmox: VMs, LXC containers, storage
 *   - docker: containers, images, networks
 *   - ssh: execução remota de comandos
 *   - tulipa: outro agente Tulipa
 */

/** Mapeamento tipo → capabilities */
const TYPE_CAPABILITIES = {
  proxmox:    ['proxmox-vm', 'proxmox-lxc', 'compute', 'backup', 'monitoring'],
  docker:     ['docker', 'compute', 'deploy'],
  'docker-tls': ['docker', 'compute', 'deploy'],
  portainer:  ['docker', 'compute', 'deploy', 'monitoring'],
  'portainer-tls': ['docker', 'compute', 'deploy', 'monitoring'],
  ssh:        ['ssh', 'compute'],
  tulipa:     ['chat', 'relay'],
};

class InfraAdopter extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.registry — PeerRegistry
   * @param {object} options.trust — TrustGraph
   * @param {function} [options.fetch] — fetch function
   */
  constructor(options = {}) {
    super();
    this._registry = options.registry;
    this._trust = options.trust;
    this._fetch = options.fetch || globalThis.fetch;
    this._adopted = new Map(); // endpoint → adoption info
  }

  /**
   * Adota um serviço de infra como peer.
   *
   * @param {object} discovered — resultado do scanner { type, ip, port, endpoint, version }
   * @param {object} [credentials] — { username, password, apiToken, sshKey }
   * @returns {object} { nodeId, peer, capabilities, status }
   */
  adopt(discovered, credentials = {}) {
    const { type, ip, port, endpoint, version } = discovered;

    // Gerar nodeId determinístico para infra (baseado em tipo + endpoint)
    const nodeId = `infra_${type}_${ip.replace(/\./g, '-')}_${port}`;

    // Capabilities para esse tipo
    const caps = TYPE_CAPABILITIES[type] || ['compute'];

    // Registrar como peer
    const peer = this._registry.upsert(nodeId, {
      name: `${type}@${ip}:${port}`,
      capabilities: caps,
      endpoint,
      metadata: {
        infraType: type,
        version,
        ip,
        port,
        credentials: credentials.apiToken ? { apiToken: '***' } : {},
        adoptedAt: new Date().toISOString(),
        isInfra: true,
      },
    });

    // Trust inicial para infra local (LAN = relativamente confiável)
    if (this._trust) {
      this._trust.setDirectTrust(nodeId, 0.7, 'infra-adopt-lan');
    }

    // Armazenar credenciais (em memória, não persistido)
    this._adopted.set(nodeId, {
      ...discovered,
      credentials,
      adoptedAt: new Date().toISOString(),
    });

    this.emit('adopted', { nodeId, type, endpoint, capabilities: caps });

    return {
      nodeId,
      peer,
      capabilities: capabilities.enrich(caps),
      status: 'adopted',
    };
  }

  /**
   * Testa conectividade com um serviço adotado.
   *
   * @param {string} nodeId
   * @returns {Promise<{ ok: boolean, latency: number, error?: string }>}
   */
  async test(nodeId) {
    const info = this._adopted.get(nodeId);
    if (!info) {
      return { ok: false, error: 'Serviço não adotado' };
    }

    const start = Date.now();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);

      try {
        const res = await this._fetch(`${info.endpoint}${this._getHealthPath(info.type)}`, {
          signal: controller.signal,
          headers: this._getAuthHeaders(info),
        });

        const latency = Date.now() - start;

        if (res.ok) {
          // Atualizar latência no registry
          const peer = this._registry.get(nodeId);
          if (peer) {
            peer.latency = latency;
            this._registry.touch(nodeId);
          }
          return { ok: true, latency };
        }
        return { ok: false, latency, error: `HTTP ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      return { ok: false, latency: Date.now() - start, error: err.message };
    }
  }

  /**
   * Remove um serviço adotado.
   */
  remove(nodeId) {
    this._adopted.delete(nodeId);
    this._registry.remove(nodeId);
    this.emit('removed', { nodeId });
    return true;
  }

  /**
   * Lista todos os serviços adotados.
   */
  list() {
    return [...this._adopted.entries()].map(([nodeId, info]) => {
      const peer = this._registry.get(nodeId);
      return {
        nodeId,
        type: info.type,
        endpoint: info.endpoint,
        version: info.version,
        status: peer?.status || 'unknown',
        adoptedAt: info.adoptedAt,
      };
    });
  }

  /**
   * @private
   */
  _getHealthPath(type) {
    switch (type) {
      case 'proxmox': return '/api2/json/version';
      case 'docker':
      case 'docker-tls': return '/version';
      case 'portainer':
      case 'portainer-tls': return '/api/status';
      case 'tulipa': return '/api/health';
      default: return '/';
    }
  }

  /**
   * @private
   */
  _getAuthHeaders(info) {
    const headers = { 'Accept': 'application/json' };
    if (info.credentials?.apiToken) {
      // Proxmox usa PVEAPIToken
      if (info.type === 'proxmox') {
        headers['Authorization'] = `PVEAPIToken=${info.credentials.apiToken}`;
      } else {
        headers['Authorization'] = `Bearer ${info.credentials.apiToken}`;
      }
    }
    return headers;
  }
}

module.exports = InfraAdopter;
