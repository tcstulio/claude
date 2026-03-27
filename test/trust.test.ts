// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { TrustGraph } from '../lib-ts/mesh/trust.js';

describe('TrustGraph', () => {
  let trust: any;

  beforeEach(() => {
    trust = new TrustGraph({
      nodeId: 'self',
      defaultTrust: 0.5,
      transitiveDecay: 0.7,
      delegationThreshold: 0.3,
      maxHops: 3,
    });
  });

  describe('setDirectTrust / getDirectTrust', () => {
    it('define e retorna trust direto', () => {
      trust.setDirectTrust('peer_a', 0.8, 'manual');
      expect(trust.getDirectTrust('peer_a')).toBe(0.8);
    });

    it('clamp entre 0 e 1', () => {
      trust.setDirectTrust('peer_b', 1.5);
      expect(trust.getDirectTrust('peer_b')).toBe(1.0);

      trust.setDirectTrust('peer_c', -0.5);
      expect(trust.getDirectTrust('peer_c')).toBe(0.0);
    });

    it('retorna null para peer desconhecido', () => {
      expect(trust.getDirectTrust('unknown')).toBe(null);
    });
  });

  describe('computeTrust', () => {
    it('peer com reputation 50 e endorsed = ~0.6', () => {
      const score = trust.computeTrust({
        nodeId: 'peer_a',
        metadata: { reputation: 50, endorsed: true },
      });
      // base=0.6*0.3 + rep=0.5*0.3 + interaction=0.5*0.4 = 0.18+0.15+0.2 = 0.53
      expect(score > 0.5).toBeTruthy();
      expect(score < 0.7).toBeTruthy();
    });

    it('peer owner = trust alto', () => {
      const score = trust.computeTrust({
        nodeId: 'owner',
        metadata: { reputation: 100, relation: 'owner' },
      });
      // base=1.0*0.3 + rep=1.0*0.3 + interaction=0.5*0.4 = 0.3+0.3+0.2 = 0.8
      expect(score >= 0.8).toBeTruthy();
    });

    it('peer com muitas interações positivas = trust alto', () => {
      const score = trust.computeTrust(
        { nodeId: 'p', metadata: { reputation: 70 } },
        { receiptsCount: 30, successRate: 0.95 },
      );
      // interaction = 0.95*0.7 + min(1,30/20)*0.3 = 0.665+0.3 = 0.965 * 0.4 = ~0.39
      expect(score > 0.55).toBeTruthy();
    });
  });

  describe('getTransitiveTrust (BFS)', () => {
    it('trust direto é retornado imediatamente', () => {
      trust.setDirectTrust('peer_a', 0.8);
      const result = trust.getTransitiveTrust('peer_a', () => new Map());
      expect(result.score).toBe(0.8);
      expect(result.hops).toBe(0);
    });

    it('trust transitivo 1 hop', () => {
      trust.setDirectTrust('peer_a', 0.8);

      // peer_a confia em peer_b com 0.9
      const getNeighbors = (nodeId: string) => {
        if (nodeId === 'peer_a') return new Map([['peer_b', 0.9]]);
        return new Map();
      };

      const result = trust.getTransitiveTrust('peer_b', getNeighbors);
      // 0.8 * 0.9 * 0.7 = 0.504
      expect(Math.abs(result.score - 0.504) < 0.01).toBeTruthy();
      expect(result.path).toEqual(['self', 'peer_a', 'peer_b']);
      expect(result.hops).toBe(2);
    });

    it('trust transitivo 2 hops', () => {
      trust.setDirectTrust('peer_a', 0.9);

      const getNeighbors = (nodeId: string) => {
        if (nodeId === 'peer_a') return new Map([['peer_b', 0.8]]);
        if (nodeId === 'peer_b') return new Map([['peer_c', 0.7]]);
        return new Map();
      };

      const result = trust.getTransitiveTrust('peer_c', getNeighbors);
      // 0.9 * 0.8 * 0.7(decay) * 0.7 * 0.7(decay) = 0.9*0.8*0.7*0.7*0.7 = 0.24696
      expect(result.score > 0.2).toBeTruthy();
      expect(result.score < 0.4).toBeTruthy();
      expect(result.path.length).toBe(4); // self -> a -> b -> c
    });

    it('peer inalcançável retorna 0', () => {
      trust.setDirectTrust('peer_a', 0.8);

      const result = trust.getTransitiveTrust('peer_z', () => new Map());
      expect(result.score).toBe(0);
    });

    it('cache funciona', () => {
      trust.setDirectTrust('peer_a', 0.8);
      const getNeighbors = (nodeId: string) => {
        if (nodeId === 'peer_a') return new Map([['peer_b', 0.9]]);
        return new Map();
      };

      const r1 = trust.getTransitiveTrust('peer_b', getNeighbors);
      const r2 = trust.getTransitiveTrust('peer_b', getNeighbors);
      expect(r1.score).toBe(r2.score);
    });
  });

  describe('rankForDelegation', () => {
    it('ordena por score decrescente', () => {
      trust.setDirectTrust('peer_a', 0.9);
      trust.setDirectTrust('peer_b', 0.4);
      trust.setDirectTrust('peer_c', 0.7);

      const peers = [
        { nodeId: 'peer_a', name: 'A', capabilities: ['chat'] },
        { nodeId: 'peer_b', name: 'B', capabilities: ['chat'] },
        { nodeId: 'peer_c', name: 'C', capabilities: ['chat'] },
      ];

      const ranking = trust.rankForDelegation(peers, { skill: 'chat' });
      expect(ranking[0].peer.nodeId).toBe('peer_a');
      expect(ranking[1].peer.nodeId).toBe('peer_c');
      expect(ranking[2].peer.nodeId).toBe('peer_b');
    });

    it('filtra por eligible (threshold 0.3)', () => {
      trust.setDirectTrust('peer_a', 0.8);
      trust.setDirectTrust('peer_b', 0.1); // abaixo do threshold

      const peers = [
        { nodeId: 'peer_a', name: 'A', capabilities: ['chat'] },
        { nodeId: 'peer_b', name: 'B', capabilities: ['chat'] },
      ];

      const ranking = trust.rankForDelegation(peers, { skill: 'chat' });
      const eligible = ranking.filter((r: any) => r.eligible);
      expect(eligible.length).toBe(1);
      expect(eligible[0].peer.nodeId).toBe('peer_a');
    });

    it('peer sem skill recebe score penalizado', () => {
      trust.setDirectTrust('peer_a', 0.9);
      trust.setDirectTrust('peer_b', 0.9);

      const peers = [
        { nodeId: 'peer_a', name: 'A', capabilities: ['chat'] },
        { nodeId: 'peer_b', name: 'B', capabilities: ['code'] },
      ];

      const ranking = trust.rankForDelegation(peers, { skill: 'chat' });
      expect(ranking[0].peer.nodeId === 'peer_a').toBeTruthy();
      expect(!ranking[1].eligible).toBeTruthy(); // sem skill chat = inelegível
    });
  });

  describe('canDelegate', () => {
    it('true se trust >= threshold', () => {
      trust.setDirectTrust('peer_a', 0.5);
      expect(trust.canDelegate('peer_a')).toBeTruthy();
    });

    it('false se trust < threshold', () => {
      trust.setDirectTrust('peer_b', 0.2);
      expect(!trust.canDelegate('peer_b')).toBeTruthy();
    });

    it('false para peer desconhecido', () => {
      expect(!trust.canDelegate('unknown')).toBeTruthy();
    });
  });

  describe('getAllDirectTrust', () => {
    it('retorna todos os trusts', () => {
      trust.setDirectTrust('a', 0.8, 'manual');
      trust.setDirectTrust('b', 0.5, 'computed');

      const all = trust.getAllDirectTrust();
      expect(all.a.score).toBe(0.8);
      expect(all.b.score).toBe(0.5);
      expect(all.a.reason).toBe('manual');
    });
  });

  describe('toJSON', () => {
    it('serializa corretamente', () => {
      trust.setDirectTrust('peer_a', 0.8);
      const json = trust.toJSON();
      expect(json.nodeId).toBe('self');
      expect(json.config).toBeTruthy();
      expect(json.config.delegationThreshold).toBe(0.3);
      expect(json.directTrust.peer_a).toBeTruthy();
    });
  });
});
