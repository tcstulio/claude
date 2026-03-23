'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const PeerRegistry = require('../lib/mesh/registry');

describe('PeerRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new PeerRegistry({ staleTtl: 100, deadTtl: 200, sweepInterval: 50 });
  });

  describe('upsert', () => {
    it('adiciona novo peer', () => {
      const peer = registry.upsert('node-1', { name: 'Agent-1' });
      assert.equal(peer.nodeId, 'node-1');
      assert.equal(peer.name, 'Agent-1');
      assert.equal(peer.status, 'online');
      assert.equal(registry.size, 1);
    });

    it('emite peer-joined para novo peer', (_, done) => {
      registry.on('peer-joined', (peer) => {
        assert.equal(peer.nodeId, 'node-1');
        done();
      });
      registry.upsert('node-1', { name: 'Agent-1' });
    });

    it('atualiza peer existente sem mudar firstSeen', () => {
      const p1 = registry.upsert('node-1', { name: 'V1' });
      const first = p1.firstSeen;
      const p2 = registry.upsert('node-1', { name: 'V2', latency: 42 });
      assert.equal(p2.name, 'V2');
      assert.equal(p2.latency, 42);
      assert.equal(p2.firstSeen, first);
    });

    it('emite peer-updated para peer existente', (_, done) => {
      registry.upsert('node-1', { name: 'V1' });
      registry.on('peer-updated', (peer) => {
        assert.equal(peer.name, 'V2');
        done();
      });
      registry.upsert('node-1', { name: 'V2' });
    });
  });

  describe('touch', () => {
    it('atualiza lastSeen', () => {
      registry.upsert('node-1', {});
      const before = registry.get('node-1').lastSeen;
      // Pequeno delay para garantir timestamp diferente
      const peer = registry.touch('node-1');
      assert.ok(peer.lastSeen >= before);
      assert.equal(peer.status, 'online');
    });

    it('retorna undefined para peer inexistente', () => {
      assert.equal(registry.touch('ghost'), undefined);
    });
  });

  describe('remove', () => {
    it('remove peer existente', () => {
      registry.upsert('node-1', {});
      assert.ok(registry.remove('node-1'));
      assert.equal(registry.size, 0);
    });

    it('emite peer-left', (_, done) => {
      registry.upsert('node-1', { name: 'X' });
      registry.on('peer-left', (peer) => {
        assert.equal(peer.name, 'X');
        done();
      });
      registry.remove('node-1');
    });

    it('retorna false para peer inexistente', () => {
      assert.ok(!registry.remove('ghost'));
    });
  });

  describe('list e filtros', () => {
    beforeEach(() => {
      registry.upsert('n1', { name: 'A', capabilities: ['hub'], channels: ['whatsapp'] });
      registry.upsert('n2', { name: 'B', capabilities: ['relay'], channels: ['telegram'] });
      registry.upsert('n3', { name: 'C', capabilities: ['hub'], channels: ['whatsapp', 'telegram'] });
    });

    it('lista todos os peers', () => {
      assert.equal(registry.list().length, 3);
    });

    it('filtra por status', () => {
      assert.equal(registry.list({ status: 'online' }).length, 3);
      assert.equal(registry.list({ status: 'stale' }).length, 0);
    });

    it('filtra por capability', () => {
      assert.equal(registry.list({ capability: 'hub' }).length, 2);
      assert.equal(registry.list({ capability: 'relay' }).length, 1);
    });

    it('withChannel filtra por canal', () => {
      assert.equal(registry.withChannel('whatsapp').length, 2);
      assert.equal(registry.withChannel('telegram').length, 2);
      assert.equal(registry.withChannel('email').length, 0);
    });

    it('online retorna apenas online', () => {
      assert.equal(registry.online().length, 3);
    });
  });

  describe('sweep', () => {
    it('marca peers antigos como stale', async () => {
      const peer = registry.upsert('n1', { name: 'Old' });
      // Simula peer antigo
      peer.lastSeen = Date.now() - 150; // > staleTtl (100ms)
      registry._sweep();
      assert.equal(registry.get('n1').status, 'stale');
    });

    it('remove peers mortos', () => {
      const peer = registry.upsert('n1', { name: 'Dead' });
      peer.lastSeen = Date.now() - 250; // > deadTtl (200ms)
      registry._sweep();
      assert.equal(registry.size, 0);
    });

    it('não afeta peers recentes', () => {
      registry.upsert('n1', { name: 'Fresh' });
      registry._sweep();
      assert.equal(registry.get('n1').status, 'online');
    });
  });

  describe('toJSON', () => {
    it('retorna formato correto', () => {
      registry.upsert('n1', { name: 'X', channels: ['whatsapp'] });
      const json = registry.toJSON();
      assert.equal(json.count, 1);
      assert.equal(json.online, 1);
      assert.equal(json.peers.length, 1);
      assert.equal(json.peers[0].name, 'X');
    });
  });
});
