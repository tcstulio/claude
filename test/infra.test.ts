// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { InfraScanner, KNOWN_SERVICES } from '../lib-ts/infra/infra-scanner.js';
import { InfraAdopter } from '../lib-ts/infra/infra-adopt.js';
import { SSHTaskRunner } from '../lib-ts/infra/ssh-task.js';
import PeerRegistry from '../lib-ts/mesh/peer-registry.js';
import { TrustGraph } from '../lib-ts/mesh/trust.js';

// Mock fetch para simular serviços de infra
function createInfraFetch(services: Record<string, unknown> = {}) {
  return async (url: string) => {
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

      expect(result).toBeTruthy();
      expect(result.type).toBe('proxmox');
      expect(result.ip).toBe('192.168.1.100');
      expect(result.port).toBe(8006);
      expect(result.version).toBe('8.1.3');
    });

    it('detecta Docker', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':2375/version': { Version: '24.0.7', ApiVersion: '1.43' },
        }),
      });

      const dockerService = KNOWN_SERVICES.find(s => s.type === 'docker');
      const result = await scanner.probe('10.0.0.5', dockerService);

      expect(result).toBeTruthy();
      expect(result.type).toBe('docker');
      expect(result.version).toBe('24.0.7');
    });

    it('detecta Tulipa agent', async () => {
      const scanner = new InfraScanner({
        fetch: createInfraFetch({
          ':3000/api/health': { status: 'ok', service: 'tulipa-gateway' },
        }),
      });

      const tulipaService = KNOWN_SERVICES.find(s => s.type === 'tulipa');
      const result = await scanner.probe('192.168.1.50', tulipaService);

      expect(result).toBeTruthy();
      expect(result.type).toBe('tulipa');
    });

    it('retorna null para host inacessível', async () => {
      const scanner = new InfraScanner({
        fetch: async () => { throw new Error('Connection refused'); },
      });

      const svc = KNOWN_SERVICES[0];
      const result = await scanner.probe('10.0.0.99', svc);
      expect(result).toBe(null);
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
      expect(results.length >= 2).toBeTruthy();
      const types = results.map(r => r.type);
      expect(types.includes('proxmox')).toBeTruthy();
      expect(types.includes('tulipa')).toBeTruthy();
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
      expect(results.length).toBe(1);
      expect(results[0].type).toBe('proxmox');
    });
  });

  describe('events', () => {
    it('emite discovered ao encontrar serviço', () =>
      new Promise<void>((resolve) => {
        const scanner = new InfraScanner({
          fetch: createInfraFetch({
            ':2375/version': { Version: '24.0', ApiVersion: '1.43' },
          }),
        });

        scanner.on('discovered', (result) => {
          expect(result.type).toBe('docker');
          resolve();
        });

        const svc = KNOWN_SERVICES.find(s => s.type === 'docker');
        scanner.probe('10.0.0.1', svc);
      }));
  });
});

describe('InfraAdopter', () => {
  let registry: InstanceType<typeof PeerRegistry>;
  let trust: InstanceType<typeof TrustGraph>;
  let adopter: InstanceType<typeof InfraAdopter>;

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

      expect(result.nodeId.startsWith('infra_proxmox_')).toBeTruthy();
      expect(result.status).toBe('adopted');
      expect(result.capabilities.some(c => c.name === 'proxmox-vm')).toBeTruthy();
      expect(result.capabilities.some(c => c.name === 'compute')).toBeTruthy();

      // Verificar no registry
      const peer = registry.get(result.nodeId);
      expect(peer).toBeTruthy();
      expect(peer.metadata.isInfra).toBeTruthy();
      expect(peer.metadata.infraType).toBe('proxmox');
    });

    it('define trust 0.7 para infra LAN', () => {
      const result = adopter.adopt({
        type: 'docker', ip: '10.0.0.5', port: 2375,
        endpoint: 'http://10.0.0.5:2375', version: '24.0',
      });

      expect(trust.getDirectTrust(result.nodeId)).toBe(0.7);
    });

    it('emite evento adopted', () =>
      new Promise<void>((resolve) => {
        adopter.on('adopted', ({ type, nodeId }) => {
          expect(type).toBe('docker');
          expect(nodeId).toBeTruthy();
          resolve();
        });

        adopter.adopt({
          type: 'docker', ip: '10.0.0.5', port: 2375,
          endpoint: 'http://10.0.0.5:2375', version: '24.0',
        });
      }));
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
      expect(result.ok).toBeTruthy();
      expect(result.latency >= 0).toBeTruthy();
    });

    it('erro para serviço não adotado', async () => {
      const result = await adopter.test('inexistente');
      expect(!result.ok).toBeTruthy();
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

      expect(adopter.list().length).toBe(2);
    });

    it('remove serviço', () => {
      const { nodeId } = adopter.adopt({
        type: 'docker', ip: '10.0.0.1', port: 2375,
        endpoint: 'http://10.0.0.1:2375', version: '24.0',
      });

      adopter.remove(nodeId);
      expect(adopter.list().length).toBe(0);
      expect(registry.get(nodeId)).toBe(null);
    });
  });
});

describe('SSHTaskRunner', () => {
  describe('_validateCommand', () => {
    it('bloqueia comandos perigosos', () => {
      const ssh = new SSHTaskRunner({ host: 'test' });
      const result = ssh._validateCommand('rm -rf /');
      expect(!result.ok).toBeTruthy();
      expect(result.error.includes('bloqueado')).toBeTruthy();
    });

    it('permite comandos normais', () => {
      const ssh = new SSHTaskRunner({ host: 'test' });
      expect(ssh._validateCommand('ls -la').ok).toBeTruthy();
      expect(ssh._validateCommand('df -h').ok).toBeTruthy();
      expect(ssh._validateCommand('docker ps').ok).toBeTruthy();
    });

    it('allowlist restringe comandos', () => {
      const ssh = new SSHTaskRunner({
        host: 'test',
        allowedCommands: ['ls', 'df', 'uptime'],
      });
      expect(ssh._validateCommand('ls -la').ok).toBeTruthy();
      expect(!ssh._validateCommand('rm file.txt').ok).toBeTruthy();
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
      expect(args.includes('-p')).toBeTruthy();
      expect(args.includes('2222')).toBeTruthy();
      expect(args.includes('-i')).toBeTruthy();
      expect(args.includes('/home/user/.ssh/id_ed25519')).toBeTruthy();
      expect(args.includes('admin@192.168.1.100')).toBeTruthy();
      expect(args.includes('uptime')).toBeTruthy();
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
      expect(json.host).toBe('10.0.0.1');
      expect(json.hasKey).toBe(true);
      expect(!json.keyPath).toBeTruthy(); // não expõe path
    });
  });
});
