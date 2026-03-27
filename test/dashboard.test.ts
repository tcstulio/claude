// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { generateDashboard, verifyAsThirdParty } from '../lib-ts/ledger/dashboard.js';
import { Ledger } from '../lib-ts/ledger/ledger.js';
import * as receipt from '../lib-ts/ledger/receipt.js';
import { TrustGraph } from '../lib-ts/mesh/trust.js';
import { PeerRegistry } from '../lib-ts/mesh/peer-registry.js';

describe('Economy Dashboard', () => {
  let ledger: InstanceType<typeof Ledger>;
  let trust: InstanceType<typeof TrustGraph>;
  let registry: InstanceType<typeof PeerRegistry>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-test-'));
    ledger = new Ledger({ nodeId: 'self', dataDir: tmpDir });
    trust = new TrustGraph({ nodeId: 'self' });
    registry = new PeerRegistry();

    // Setup peers
    registry.upsert('peer_a', { name: 'Agente A', capabilities: ['chat', 'code'] });
    registry.upsert('peer_b', { name: 'Agente B', capabilities: ['chat'] });
    trust.setDirectTrust('peer_a', 0.8);
    trust.setDirectTrust('peer_b', 0.5);

    // Add receipts: self pediu 3 tasks para peer_a, peer_b pediu 2 de self
    for (let i = 0; i < 3; i++) {
      const r = receipt.createReceipt({
        taskId: `out_${i}`, from: 'self', to: 'peer_a',
        skill: 'chat', result: `result_${i}`,
        resourceUsed: { durationMs: 5000 },
      });
      r.fromSignature = 'sig';
      ledger.addReceipt(r);
    }

    for (let i = 0; i < 2; i++) {
      const r = receipt.createReceipt({
        taskId: `in_${i}`, from: 'peer_b', to: 'self',
        skill: 'code', result: `result_${i}`,
        resourceUsed: { durationMs: 15000 },
      });
      r.fromSignature = 'sig';
      ledger.addReceipt(r);
    }
  });

  describe('generateDashboard', () => {
    it('retorna economia correta', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      expect(dash.nodeId).toBe('self');
      expect(dash.timestamp).toBeTruthy();
      expect(dash.economy.spent).toBe(3);  // 3 tasks pedidas (1 crédito cada)
      expect(dash.economy.earned).toBe(4); // 2 tasks executadas (2 créditos cada: 1 base + 1 por 15s)
      expect(dash.economy.bootstrap).toBe(100);
      expect(dash.economy.credits).toBe(101); // 100 + 4 - 3
    });

    it('top contributors correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      expect(dash.activity.topContributors.length).toBe(1);
      expect(dash.activity.topContributors[0].peerId).toBe('peer_a');
      expect(dash.activity.topContributors[0].tasksExecuted).toBe(3);
      expect(dash.activity.topContributors[0].trust).toBe(0.8);
    });

    it('top consumers correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      expect(dash.activity.topConsumers.length).toBe(1);
      expect(dash.activity.topConsumers[0].peerId).toBe('peer_b');
      expect(dash.activity.topConsumers[0].tasksRequested).toBe(2);
    });

    it('top skills correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      expect(dash.activity.topSkills.length).toBe(2);
      const chat = dash.activity.topSkills.find((s: any) => s.skill === 'chat');
      const code = dash.activity.topSkills.find((s: any) => s.skill === 'code');
      expect(chat.count).toBe(3);
      expect(chat.spent).toBe(3);
      expect(code.count).toBe(2);
      expect(code.earned).toBe(2);
    });

    it('network peers listados com trust', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      expect(dash.network.totalPeers).toBe(2);
      const peerA = dash.network.peers.find((p: any) => p.nodeId === 'peer_a');
      expect(peerA.trust).toBe(0.8);
      expect(peerA.receipts).toBe(3);
    });

    it('funciona sem trust/registry (degradação graciosa)', () => {
      const dash = generateDashboard({ ledger, nodeId: 'self' });
      expect(dash.economy).toBeTruthy();
      expect(dash.network.totalPeers).toBe(0);
    });
  });

  describe('verifyAsThirdParty', () => {
    it('receipt sem assinatura = disputa', () => {
      const r = receipt.createReceipt({
        taskId: 't1', from: 'peer_a', to: 'peer_b',
        skill: 'chat', result: 'ok',
      });

      const result = verifyAsThirdParty(r, {
        registry,
        receiptLib: receipt,
      });

      expect(result.dispute).toBeTruthy();
      expect(result.valid).not.toBeTruthy();
      expect(result.recommendation).toMatch(/incompleto/);
    });

    it('receipt com hash adulterado = disputa', () => {
      const r = receipt.createReceipt({
        taskId: 't2', from: 'peer_a', to: 'peer_b',
        skill: 'chat', result: 'ok',
      });
      r.fromSignature = 'fake_sig';
      r.skill = 'hacked'; // adultera

      const result = verifyAsThirdParty(r, {
        registry,
        receiptLib: receipt,
      });

      expect(result.dispute).toBeTruthy();
      expect(result.valid).not.toBeTruthy();
    });
  });
});
