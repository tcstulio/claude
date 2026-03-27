// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { PeerRegistry } from '../lib-ts/mesh/peer-registry.js';

describe('PeerRegistry', () => {
  let registry: any;

  beforeEach(() => {
    registry = new PeerRegistry({ staleTtl: 100, deadTtl: 200, sweepInterval: 50 });
  });

  describe('upsert', () => {
    it('adiciona novo peer', () => {
      const peer = registry.upsert('node-1', { name: 'Agent-1' });
      expect(peer.nodeId).toBe('node-1');
      expect(peer.name).toBe('Agent-1');
      expect(peer.status).toBe('online');
      expect(registry.size).toBe(1);
    });

    it('emite peer-joined para novo peer', () => {
      return new Promise<void>((resolve) => {
        registry.on('peer-joined', (peer: any) => {
          expect(peer.nodeId).toBe('node-1');
          resolve();
        });
        registry.upsert('node-1', { name: 'Agent-1' });
      });
    });

    it('atualiza peer existente sem mudar firstSeen', () => {
      const p1 = registry.upsert('node-1', { name: 'V1' });
      const first = p1.firstSeen;
      const p2 = registry.upsert('node-1', { name: 'V2', latency: 42 });
      expect(p2.name).toBe('V2');
      expect(p2.latency).toBe(42);
      expect(p2.firstSeen).toBe(first);
    });

    it('emite peer-updated para peer existente', () => {
      return new Promise<void>((resolve) => {
        registry.upsert('node-1', { name: 'V1' });
        registry.on('peer-updated', (peer: any) => {
          expect(peer.name).toBe('V2');
          resolve();
        });
        registry.upsert('node-1', { name: 'V2' });
      });
    });
  });

  describe('touch', () => {
    it('atualiza lastSeen', () => {
      registry.upsert('node-1', {});
      const before = registry.get('node-1').lastSeen;
      // Pequeno delay para garantir timestamp diferente
      const peer = registry.touch('node-1');
      expect(peer.lastSeen >= before).toBeTruthy();
      expect(peer.status).toBe('online');
    });

    it('retorna undefined para peer inexistente', () => {
      expect(registry.touch('ghost')).toBe(undefined);
    });
  });

  describe('remove', () => {
    it('remove peer existente', () => {
      registry.upsert('node-1', {});
      expect(registry.remove('node-1')).toBeTruthy();
      expect(registry.size).toBe(0);
    });

    it('emite peer-left', () => {
      return new Promise<void>((resolve) => {
        registry.upsert('node-1', { name: 'X' });
        registry.on('peer-left', (peer: any) => {
          expect(peer.name).toBe('X');
          resolve();
        });
        registry.remove('node-1');
      });
    });

    it('retorna false para peer inexistente', () => {
      expect(!registry.remove('ghost')).toBeTruthy();
    });
  });

  describe('list e filtros', () => {
    beforeEach(() => {
      registry.upsert('n1', { name: 'A', capabilities: ['hub'], channels: ['whatsapp'] });
      registry.upsert('n2', { name: 'B', capabilities: ['relay'], channels: ['telegram'] });
      registry.upsert('n3', { name: 'C', capabilities: ['hub'], channels: ['whatsapp', 'telegram'] });
    });

    it('lista todos os peers', () => {
      expect(registry.list().length).toBe(3);
    });

    it('filtra por status', () => {
      expect(registry.list({ status: 'online' }).length).toBe(3);
      expect(registry.list({ status: 'stale' }).length).toBe(0);
    });

    it('filtra por capability', () => {
      expect(registry.list({ capability: 'hub' }).length).toBe(2);
      expect(registry.list({ capability: 'relay' }).length).toBe(1);
    });

    it('withChannel filtra por canal', () => {
      expect(registry.withChannel('whatsapp').length).toBe(2);
      expect(registry.withChannel('telegram').length).toBe(2);
      expect(registry.withChannel('email').length).toBe(0);
    });

    it('online retorna apenas online', () => {
      expect(registry.online().length).toBe(3);
    });
  });

  describe('sweep', () => {
    it('marca peers antigos como stale', async () => {
      const peer = registry.upsert('n1', { name: 'Old' });
      // Simula peer antigo
      peer.lastSeen = Date.now() - 150; // > staleTtl (100ms)
      registry._sweep();
      expect(registry.get('n1').status).toBe('stale');
    });

    it('remove peers mortos', () => {
      const peer = registry.upsert('n1', { name: 'Dead' });
      peer.lastSeen = Date.now() - 250; // > deadTtl (200ms)
      registry._sweep();
      expect(registry.size).toBe(0);
    });

    it('não afeta peers recentes', () => {
      registry.upsert('n1', { name: 'Fresh' });
      registry._sweep();
      expect(registry.get('n1').status).toBe('online');
    });
  });

  describe('toJSON', () => {
    it('retorna formato correto', () => {
      registry.upsert('n1', { name: 'X', channels: ['whatsapp'] });
      const json = registry.toJSON();
      expect(json.count).toBe(1);
      expect(json.online).toBe(1);
      expect(json.peers.length).toBe(1);
      expect(json.peers[0].name).toBe('X');
    });
  });
});
