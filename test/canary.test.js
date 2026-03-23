'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { CanaryRunner, CANARY_STATES } = require('../lib/infra/canary');
const PeerRegistry = require('../lib/mesh/registry');
const TrustGraph = require('../lib/mesh/trust');

function createMockMesh(peers = []) {
  const registry = new PeerRegistry();
  const trust = new TrustGraph({ nodeId: 'self' });

  for (const p of peers) {
    registry.upsert(p.nodeId, p);
    if (p.trust) trust.setDirectTrust(p.nodeId, p.trust);
  }

  return { registry, trust, nodeId: 'self' };
}

describe('CanaryRunner', () => {
  let canary;
  let mesh;

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
      assert.ok(CANARY_STATES.includes('pending'));
      assert.ok(CANARY_STATES.includes('testing'));
      assert.ok(CANARY_STATES.includes('passed'));
      assert.ok(CANARY_STATES.includes('failed'));
      assert.ok(CANARY_STATES.includes('promoting'));
      assert.ok(CANARY_STATES.includes('done'));
    });
  });

  describe('start', () => {
    it('cria canary run com executor correto', async () => {
      const run = await canary.start({
        version: '0.5.0',
        repo: 'https://github.com/tcstulio/tulipa.git',
        branch: 'main',
      });

      assert.ok(run.id.startsWith('canary_'));
      assert.equal(run.version, '0.5.0');
      assert.equal(run.executor.nodeId, 'compute_1'); // único com compute
      assert.equal(run.state, 'provisioning');
      assert.ok(run.script.commands.length > 0);
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

      assert.equal(run.executor.nodeId, 'compute_2');
    });

    it('falha se nenhum nó compute disponível', async () => {
      const meshNoCompute = createMockMesh([
        { nodeId: 'chat_1', name: 'Chat', capabilities: ['chat'], status: 'online' },
      ]);
      const c = new CanaryRunner({ mesh: meshNoCompute });

      const run = await c.start({ version: '0.5.0', repo: 'https://repo.git' });
      assert.equal(run.state, 'failed');
      assert.ok(run.results.error.includes('Nenhum nó'));
    });

    it('emite evento canary-created', async () => {
      let emitted = false;
      canary.on('canary-created', () => { emitted = true; });

      await canary.start({ version: '0.5.0', repo: 'https://repo.git' });
      assert.ok(emitted);
    });
  });

  describe('execute', () => {
    it('executa e reporta resultado', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      // Mock SSH runner
      const mockSSH = {
        executeMany: async (commands) => {
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
      assert.ok(result.passed);
      assert.equal(canary.getRun(run.id).state, 'passed');
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
      assert.ok(!result.passed);
      assert.equal(canary.getRun(run.id).state, 'failed');
    });
  });

  describe('approve', () => {
    it('aprova promoção', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      // Simular teste passando
      const mockSSH = {
        executeMany: async (cmds) => cmds.map(c => ({ command: c, ok: true, stdout: 'OK', stderr: '', durationMs: 10 })),
      };
      await canary.execute(run.id, mockSSH);

      const updated = canary.approve(run.id, true, 'Looks good');
      assert.equal(updated.state, 'promoting');
      assert.ok(updated.approval.approved);
    });

    it('rejeita promoção', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      const mockSSH = {
        executeMany: async (cmds) => cmds.map(c => ({ command: c, ok: true, stdout: 'OK', stderr: '', durationMs: 10 })),
      };
      await canary.execute(run.id, mockSSH);

      const updated = canary.approve(run.id, false, 'Not ready');
      assert.equal(updated.state, 'rejected');
    });

    it('erro se run não está em passed', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      assert.throws(
        () => canary.approve(run.id, true),
        { message: /não está em estado 'passed'/ },
      );
    });
  });

  describe('listRuns', () => {
    it('lista e filtra por state', async () => {
      await canary.start({ version: '0.4.0', repo: 'https://repo.git' });
      await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      assert.equal(canary.listRuns().length, 2);
      assert.equal(canary.listRuns({ state: 'provisioning' }).length, 2);
    });
  });

  describe('timeline', () => {
    it('registra transições de estado', async () => {
      const run = await canary.start({ version: '0.5.0', repo: 'https://repo.git' });

      const current = canary.getRun(run.id);
      assert.ok(current.timeline.length >= 2); // pending → provisioning
      assert.equal(current.timeline[0].state, 'pending');
      assert.equal(current.timeline[1].state, 'provisioning');
    });
  });
});
