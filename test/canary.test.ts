// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { CanaryRunner, CANARY_STATES } from '../lib-ts/infra/canary.js';
import PeerRegistry from '../lib-ts/mesh/peer-registry.js';
import { TrustGraph } from '../lib-ts/mesh/trust.js';

function createMockMesh(peers: Array<{ nodeId: string; name: string; capabilities: string[]; status: string; trust?: number }> = []) {
  const registry = new PeerRegistry();
  const trust = new TrustGraph({ nodeId: 'self' });

  for (const p of peers) {
    registry.upsert(p.nodeId, p);
    if (p.trust) trust.setDirectTrust(p.nodeId, p.trust);
  }

  return { registry, trust, nodeId: 'self' };
}

describe('CanaryRunner', () => {
  let canary: InstanceType<typeof CanaryRunner>;
  let mesh: ReturnType<typeof createMockMesh>;

  beforeEach(() => {
    mesh = createMockMesh([
      { nodeId: 'compute_1', name: 'Compute Node', capabilities: ['compute'], status: 'online', trust: 0.8 },
      { nodeId: 'chat_1', name: 'Chat Node', capabilities: ['chat'], status: 'online', trust: 0.7 },
    ]);
    canary = new CanaryRunner({
      mesh,
      ownerNode: 'owner_1',
      notify: async () => {},
    });
  });

  describe('CANARY_STATES', () => {
    it('contém todos os estados', () => {
      expect(CANARY_STATES.includes('pending')).toBeTruthy();
      expect(CANARY_STATES.includes('testing')).toBeTruthy();
      expect(CANARY_STATES.includes('passed')).toBeTruthy();
      expect(CANARY_STATES.includes('failed')).toBeTruthy();
      expect(CANARY_STATES.includes('promoting')).toBeTruthy();
      expect(CANARY_STATES.includes('done')).toBeTruthy();
    });
  });

  describe('start', () => {
    it('cria canary run com executor correto', async () => {
      const run = await canary.start({
        version: '0.5.0',
        repo: 'https://github.com/tcstulio/tulipa.git',
        branch: 'main',
      });

      expect(run.id.startsWith('canary_')).toBeTruthy();
      expect(run.version).toBe('0.5.0');
      expect(run.executor.nodeId).toBe('compute_1'); // único com compute
      expect(run.state).toBe('provisioning');
      expect(run.script.commands.length > 0).toBeTruthy();
    });

    it('seleciona nó preferido se disponível', async () => {
      mesh.registry.upsert('compute_2', {
        name: 'Compute 2', capabilities: ['compute'], status: 'online',
      });
      mesh.trust.setDirectTrust('compute_2', 0.9);

      const run = await canary.start({
        version: '0.5.0',
        repo: 'https://repo.git',
        preferNode: 'compute_2',
      });

      expect(run.executor.nodeId).toBe('compute_2');
    });

    it('falha se nenhum nó compute disponível', async () => {
      const meshNoCompute = createMockMesh([
        { nodeId: 'chat_1', name: 'Chat', capabilities: ['chat'], status: 'online' },
      ]);
      const c = new CanaryRunner({ mesh: meshNoCompute });

      const run = await c.start({ version: '0.5.0', repo: 'https://repo.git' });
      expect(run.state).toBe('failed');
      expect(run.results.error.includes('No compute node')).toBeTruthy();
    });

    it('emite evento canary-created', async () => {
      let emitted = false;
      canary.on('canary-created', () => { emitted = true; });

      await canary.start({ version: '0.5.0', repo: 'https://repo.git' });
      expect(emitted).toBeTruthy();
    });
  });

  describe('execute', () => {
    it('executa e reporta resultado', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      // Mock SSH runner
      const mockSSH = {
        executeMany: async (commands: string[]) => {
          return commands.map(cmd => ({
            command: cmd,
            ok: true,
            stdout: 'OK',
            stderr: '',
            durationMs: 100,
          }));
        },
      };

      const result = await canary.execute(run.id, mockSSH);
      expect(result.passed).toBeTruthy();
      expect(canary.getRun(run.id).state).toBe('passed');
    });

    it('reporta falha quando teste falha', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      const mockSSH = {
        executeMany: async () => {
          return [
            { command: 'npm test', ok: false, stdout: '', stderr: 'FAIL', durationMs: 50 },
          ];
        },
      };

      const result = await canary.execute(run.id, mockSSH);
      expect(!result.passed).toBeTruthy();
      expect(canary.getRun(run.id).state).toBe('failed');
    });
  });

  describe('approve', () => {
    it('aprova promoção', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      // Simular teste passando
      const mockSSH = {
        executeMany: async (cmds: string[]) => cmds.map(c => ({ command: c, ok: true, stdout: 'OK', stderr: '', durationMs: 10 })),
      };
      await canary.execute(run.id, mockSSH);

      const updated = canary.approve(run.id, true, 'Looks good');
      expect(updated.state).toBe('promoting');
      expect(updated.approval.approved).toBeTruthy();
    });

    it('rejeita promoção', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      const mockSSH = {
        executeMany: async (cmds: string[]) => cmds.map(c => ({ command: c, ok: true, stdout: 'OK', stderr: '', durationMs: 10 })),
      };
      await canary.execute(run.id, mockSSH);

      const updated = canary.approve(run.id, false, 'Not ready');
      expect(updated.state).toBe('rejected');
    });

    it('erro se run não está em passed', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      expect(
        () => canary.approve(run.id, true),
      ).toThrow(/not in 'passed' state/);
    });
  });

  describe('listRuns', () => {
    it('lista e filtra por state', async () => {
      await canary.start({ version: '0.4.0', repo: 'https://repo.git' });
      await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      expect(canary.listRuns().length).toBe(2);
      expect(canary.listRuns({ state: 'provisioning' }).length).toBe(2);
    });
  });

  describe('timeline', () => {
    it('registra transições de estado', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      const current = canary.getRun(run.id);
      expect(current.timeline.length >= 2).toBeTruthy(); // pending → provisioning
      expect(current.timeline[0].state).toBe('pending');
      expect(current.timeline[1].state).toBe('provisioning');
    });
  });
});
