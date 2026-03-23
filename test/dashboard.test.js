'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { generateDashboard, verifyAsThirdParty } = require('../lib/ledger/dashboard');
const Ledger = require('../lib/ledger/ledger');
const receipt = require('../lib/ledger/receipt');
const TrustGraph = require('../lib/mesh/trust');
const PeerRegistry = require('../lib/mesh/registry');

describe('Economy Dashboard', () => {
  let ledger, trust, registry, tmpDir;

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

      assert.equal(dash.nodeId, 'self');
      assert.ok(dash.timestamp);
      assert.equal(dash.economy.spent, 3);  // 3 tasks pedidas (1 crédito cada)
      assert.equal(dash.economy.earned, 4); // 2 tasks executadas (2 créditos cada: 1 base + 1 por 15s)
      assert.equal(dash.economy.bootstrap, 100);
      assert.equal(dash.economy.credits, 101); // 100 + 4 - 3
    });

    it('top contributors correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      assert.equal(dash.activity.topContributors.length, 1);
      assert.equal(dash.activity.topContributors[0].peerId, 'peer_a');
      assert.equal(dash.activity.topContributors[0].tasksExecuted, 3);
      assert.equal(dash.activity.topContributors[0].trust, 0.8);
    });

    it('top consumers correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      assert.equal(dash.activity.topConsumers.length, 1);
      assert.equal(dash.activity.topConsumers[0].peerId, 'peer_b');
      assert.equal(dash.activity.topConsumers[0].tasksRequested, 2);
    });

    it('top skills correto', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      assert.equal(dash.activity.topSkills.length, 2);
      const chat = dash.activity.topSkills.find(s => s.skill === 'chat');
      const code = dash.activity.topSkills.find(s => s.skill === 'code');
      assert.equal(chat.count, 3);
      assert.equal(chat.spent, 3);
      assert.equal(code.count, 2);
      assert.equal(code.earned, 2);
    });

    it('network peers listados com trust', () => {
      const dash = generateDashboard({ ledger, trust, registry, nodeId: 'self' });

      assert.equal(dash.network.totalPeers, 2);
      const peerA = dash.network.peers.find(p => p.nodeId === 'peer_a');
      assert.equal(peerA.trust, 0.8);
      assert.equal(peerA.receipts, 3);
    });

    it('funciona sem trust/registry (degradação graciosa)', () => {
      const dash = generateDashboard({ ledger, nodeId: 'self' });
      assert.ok(dash.economy);
      assert.equal(dash.network.totalPeers, 0);
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

      assert.ok(result.dispute);
      assert.ok(!result.valid);
      assert.ok(result.recommendation.includes('incompleto'));
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

      assert.ok(result.dispute);
      assert.ok(!result.valid);
    });
  });
});
