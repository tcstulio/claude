'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { InfraScanner, KNOWN_SERVICES } = require('../lib/infra/scanner');
const InfraAdopter = require('../lib/infra/adopt');
const SSHTaskRunner = require('../lib/infra/ssh-task');
const PeerRegistry = require('../lib/mesh/registry');
const TrustGraph = require('../lib/mesh/trust');

// Mock fetch para simular serviços de infra
function createInfraFetch(services = {}) {
  return async (url) => {
    for (const [pattern, response] of Object.entries(services)) {
      if (url.includes(pattern)) {
        return {
          ok: true,
          status: 200,
          json: async () => response,
        };
      }
    }
    throw new Error('Connection refused');
  };
}

describe('InfraScanner', () => {
  describe('probe', () => {
    it('detecta Proxmox', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':8006/api2/json/version': { data: { version: '8.1.3', release: '8.1' } },
        }),
      });

      const proxmoxService = KNOWN_SERVICES.find(s => s.type === 'proxmox');
      const result = await scanner.probe('192.168.1.100', proxmoxService);

      assert.ok(result);
      assert.equal(result.type, 'proxmox');
      assert.equal(result.ip, '192.168.1.100');
      assert.equal(result.port, 8006);
      assert.equal(result.version, '8.1.3');
    });

    it('detecta Docker', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':2375/version': { Version: '24.0.7', ApiVersion: '1.43' },
        }),
      });

      const dockerService = KNOWN_SERVICES.find(s => s.type === 'docker');
      const result = await scanner.probe('10.0.0.5', dockerService);

      assert.ok(result);
      assert.equal(result.type, 'docker');
      assert.equal(result.version, '24.0.7');
    });

    it('detecta Tulipa agent', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':3000/api/health': { status: 'ok', service: 'tulipa-gateway' },
        }),
      });

      const tulipaService = KNOWN_SERVICES.find(s => s.type === 'tulipa');
      const result = await scanner.probe('192.168.1.50', tulipaService);

      assert.ok(result);
      assert.equal(result.type, 'tulipa');
    });

    it('retorna null para host inacessível', async () => {
      const scanner = new InfraScanner({
        fetch: async () => { throw new Error('Connection refused'); },
      });

      const svc = KNOWN_SERVICES[0];
      const result = await scanner.probe('10.0.0.99', svc);
      assert.equal(result, null);
    });
  });

  describe('scanHost', () => {
    it('encontra múltiplos serviços no mesmo host', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':8006/api2/json/version': { data: { version: '8.1' } },
          ':3000/api/health': { status: 'ok', service: 'tulipa-gateway' },
        }),
      });

      const results = await scanner.scanHost('192.168.1.100');
      assert.ok(results.length >= 2);
      const types = results.map(r => r.type);
      assert.ok(types.includes('proxmox'));
      assert.ok(types.includes('tulipa'));
    });
  });

  describe('scanEndpoints', () => {
    it('escaneia endpoint com porta específica', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':8006/api2/json/version': { data: { version: '8.2' } },
        }),
      });

      const results = await scanner.scanEndpoints(['192.168.1.100:8006']);
      assert.equal(results.length, 1);
      assert.equal(results[0].type, 'proxmox');
    });
  });

  describe('events', () => {
    it('emite discovered ao encontrar serviço', (_, done) => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':2375/version': { Version: '24.0', ApiVersion: '1.43' },
        }),
      });

      scanner.on('discovered', (result) => {
        assert.equal(result.type, 'docker');
        done();
      });

      const svc = KNOWN_SERVICES.find(s => s.type === 'docker');
      scanner.probe('10.0.0.1', svc);
    });
  });
});

describe('InfraAdopter', () => {
  let registry, trust, adopter;

  beforeEach(() => {
    registry = new PeerRegistry();
    trust = new TrustGraph({ nodeId: 'self' });
    adopter = new InfraAdopter({ registry, trust });
  });

  describe('adopt', () => {
    it('registra Proxmox como peer com capabilities', () => {
      const result = adopter.adopt({
        type: 'proxmox',
        ip: '192.168.1.100',
        port: 8006,
        endpoint: 'https://192.168.1.100:8006',
        version: '8.1',
      });

      assert.ok(result.nodeId.startsWith('infra_proxmox_'));
      assert.equal(result.status, 'adopted');
      assert.ok(result.capabilities.some(c => c.name === 'proxmox-vm'));
      assert.ok(result.capabilities.some(c => c.name === 'compute'));

      // Verificar no registry
      const peer = registry.get(result.nodeId);
      assert.ok(peer);
      assert.ok(peer.metadata.isInfra);
      assert.equal(peer.metadata.infraType, 'proxmox');
    });

    it('define trust 0.7 para infra LAN', () => {
      const result = adopter.adopt({
        type: 'docker', ip: '10.0.0.5', port: 2375,
        endpoint: 'http://10.0.0.5:2375', version: '24.0',
      });

      assert.equal(trust.getDirectTrust(result.nodeId), 0.7);
    });

    it('emite evento adopted', (_, done) => {
      adopter.on('adopted', ({ type, nodeId }) => {
        assert.equal(type, 'docker');
        assert.ok(nodeId);
        done();
      });

      adopter.adopt({
        type: 'docker', ip: '10.0.0.5', port: 2375,
        endpoint: 'http://10.0.0.5:2375', version: '24.0',
      });
    });
  });

  describe('test', () => {
    it('testa conectividade', async () => {
      const adopter2 = new InfraAdopter({
        registry, trust,
        fetch: createInfraFetch({
          '/api/health': { status: 'ok' },
        }),
      });

      const { nodeId } = adopter2.adopt({
        type: 'tulipa', ip: '192.168.1.50', port: 3000,
        endpoint: 'http://192.168.1.50:3000', version: 'unknown',
      });

      const result = await adopter2.test(nodeId);
      assert.ok(result.ok);
      assert.ok(result.latency >= 0);
    });

    it('erro para serviço não adotado', async () => {
      const result = await adopter.test('inexistente');
      assert.ok(!result.ok);
    });
  });

  describe('list e remove', () => {
    it('lista serviços adotados', () => {
      adopter.adopt({
        type: 'docker', ip: '10.0.0.1', port: 2375,
        endpoint: 'http://10.0.0.1:2375', version: '24.0',
      });
      adopter.adopt({
        type: 'proxmox', ip: '10.0.0.2', port: 8006,
        endpoint: 'https://10.0.0.2:8006', version: '8.1',
      });

      assert.equal(adopter.list().length, 2);
    });

    it('remove serviço', () => {
      const { nodeId } = adopter.adopt({
        type: 'docker', ip: '10.0.0.1', port: 2375,
        endpoint: 'http://10.0.0.1:2375', version: '24.0',
      });

      adopter.remove(nodeId);
      assert.equal(adopter.list().length, 0);
      assert.equal(registry.get(nodeId), null);
    });
  });
});

describe('SSHTaskRunner', () => {
  describe('_validateCommand', () => {
    it('bloqueia comandos perigosos', () => {
      const ssh = new SSHTaskRunner({ host: 'test' });
      const result = ssh._validateCommand('rm -rf /');
      assert.ok(!result.ok);
      assert.ok(result.error.includes('bloqueado'));
    });

    it('permite comandos normais', () => {
      const ssh = new SSHTaskRunner({ host: 'test' });
      assert.ok(ssh._validateCommand('ls -la').ok);
      assert.ok(ssh._validateCommand('df -h').ok);
      assert.ok(ssh._validateCommand('docker ps').ok);
    });

    it('allowlist restringe comandos', () => {
      const ssh = new SSHTaskRunner({
        host: 'test',
        allowedCommands: ['ls', 'df', 'uptime'],
      });
      assert.ok(ssh._validateCommand('ls -la').ok);
      assert.ok(!ssh._validateCommand('rm file.txt').ok);
    });
  });

  describe('_buildSSHArgs', () => {
    it('constrói args corretos', () => {
      const ssh = new SSHTaskRunner({
        host: '192.168.1.100',
        user: 'admin',
        port: 2222,
        keyPath: '/home/user/.ssh/id_ed25519',
      });

      const args = ssh._buildSSHArgs('uptime');
      assert.ok(args.includes('-p'));
      assert.ok(args.includes('2222'));
      assert.ok(args.includes('-i'));
      assert.ok(args.includes('/home/user/.ssh/id_ed25519'));
      assert.ok(args.includes('admin@192.168.1.100'));
      assert.ok(args.includes('uptime'));
    });
  });

  describe('toJSON', () => {
    it('não expõe credenciais', () => {
      const ssh = new SSHTaskRunner({
        host: '10.0.0.1',
        user: 'root',
        keyPath: '/secret/key',
      });

      const json = ssh.toJSON();
      assert.equal(json.host, '10.0.0.1');
      assert.equal(json.hasKey, true);
      assert.ok(!json.keyPath); // não expõe path
    });
  });
});
