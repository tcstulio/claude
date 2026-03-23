'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const receipt = require('../lib/ledger/receipt');
const Ledger = require('../lib/ledger/ledger');

// Gerar keypair Ed25519 para testes
function generateTestKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return {
    publicKey: publicKey.toString('base64'),
    privateKey: privateKey.toString('base64'),
  };
}

describe('TaskReceipt', () => {
  const keysA = generateTestKeyPair();
  const keysB = generateTestKeyPair();

  describe('createReceipt', () => {
    it('cria receipt com campos corretos', () => {
      const rcpt = receipt.createReceipt({
        taskId: 'task_001',
        from: 'agent_a',
        to: 'agent_b',
        skill: 'chat',
        result: 'Hello world',
        resourceUsed: { durationMs: 5000 },
      });

      assert.ok(rcpt.id.startsWith('rcpt_'));
      assert.equal(rcpt.taskId, 'task_001');
      assert.equal(rcpt.from, 'agent_a');
      assert.equal(rcpt.to, 'agent_b');
      assert.equal(rcpt.skill, 'chat');
      assert.ok(rcpt.resultHash.length === 64); // SHA-256 hex
      assert.equal(rcpt.resourceUsed.durationMs, 5000);
      assert.ok(rcpt.hash.length === 64);
      assert.equal(rcpt.fromSignature, null);
      assert.equal(rcpt.toSignature, null);
    });

    it('id derivado do hash', () => {
      const rcpt = receipt.createReceipt({
        taskId: 'task_002', from: 'a', to: 'b', skill: 's', result: 'r',
      });
      assert.equal(rcpt.id, `rcpt_${rcpt.hash.slice(0, 16)}`);
    });
  });

  describe('signReceipt + verifySignature', () => {
    it('assinatura válida com chave correta', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't1', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });

      const sig = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      assert.ok(sig.length > 0);
      assert.ok(receipt.verifySignature(rcpt.hash, sig, keysA.publicKey));
    });

    it('assinatura inválida com chave errada', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't2', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });

      const sig = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      assert.ok(!receipt.verifySignature(rcpt.hash, sig, keysB.publicKey));
    });
  });

  describe('verifyReceipt', () => {
    it('receipt com dual-sign é válido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't3', from: 'agent_a', to: 'agent_b', skill: 'chat', result: 'ok',
      });

      rcpt.fromSignature = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      rcpt.toSignature = receipt.signReceipt(rcpt.hash, keysB.privateKey);

      const result = receipt.verifyReceipt(rcpt, {
        fromPublicKey: keysA.publicKey,
        toPublicKey: keysB.publicKey,
      });

      assert.ok(result.valid);
      assert.ok(result.dualSigned);
      assert.equal(result.errors.length, 0);
    });

    it('receipt com hash adulterado é inválido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't4', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      rcpt.skill = 'hacked'; // adultera campo

      const result = receipt.verifyReceipt(rcpt, { fromPublicKey: keysA.publicKey });
      assert.ok(!result.valid);
      assert.ok(result.errors.some(e => e.includes('Hash inválido')));
    });

    it('receipt sem assinatura é inválido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't5', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      const result = receipt.verifyReceipt(rcpt);
      assert.ok(!result.valid);
      assert.ok(result.errors.some(e => e.includes('Nenhuma assinatura')));
    });
  });
});

describe('Ledger', () => {
  let ledger;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-test-'));
    ledger = new Ledger({
      nodeId: 'agent_self',
      dataDir: tmpDir,
      bootstrapCredits: 100,
    });
  });

  describe('addReceipt', () => {
    it('adiciona receipt e atualiza saldo (earned)', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't1', from: 'agent_peer', to: 'agent_self',
        skill: 'chat', result: 'ok', resourceUsed: { durationMs: 15000 },
      });
      rcpt.fromSignature = 'fake_sig';

      const result = ledger.addReceipt(rcpt);
      assert.ok(!result.duplicate);
      assert.ok(result.earned);
      assert.equal(result.credits, 2); // 1 base + 1 (15s/10s)
      assert.equal(result.balance.credits, 102); // 100 bootstrap + 2
      assert.equal(result.balance.earned, 2);
    });

    it('adiciona receipt e atualiza saldo (spent)', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't2', from: 'agent_self', to: 'agent_peer',
        skill: 'code', result: 'ok', resourceUsed: { durationMs: 5000 },
      });
      rcpt.fromSignature = 'fake_sig';

      const result = ledger.addReceipt(rcpt);
      assert.ok(!result.earned);
      assert.equal(result.credits, 1); // 1 base + 0 (5s < 10s)
      assert.equal(result.balance.credits, 99); // 100 - 1
      assert.equal(result.balance.spent, 1);
    });

    it('deduplicação por ID', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't3', from: 'agent_self', to: 'agent_peer',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';

      ledger.addReceipt(rcpt);
      const result = ledger.addReceipt(rcpt);
      assert.ok(result.duplicate);
    });

    it('emite evento receipt-added', (_, done) => {
      ledger.on('receipt-added', (data) => {
        assert.ok(data.receipt);
        assert.ok(typeof data.credits === 'number');
        done();
      });

      const rcpt = receipt.createReceipt({
        taskId: 't4', from: 'agent_peer', to: 'agent_self',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);
    });
  });

  describe('getReceipts', () => {
    it('filtra por peer', () => {
      for (let i = 0; i < 3; i++) {
        const r = receipt.createReceipt({
          taskId: `t${i}`, from: i < 2 ? 'peer_a' : 'peer_b', to: 'agent_self',
          skill: 'chat', result: `r${i}`,
        });
        r.fromSignature = 'sig';
        ledger.addReceipt(r);
      }
      assert.equal(ledger.getReceipts({ peer: 'peer_a' }).length, 2);
      assert.equal(ledger.getReceipts({ peer: 'peer_b' }).length, 1);
    });

    it('filtra por skill', () => {
      ['chat', 'code', 'chat'].forEach((skill, i) => {
        const r = receipt.createReceipt({
          taskId: `t${i}`, from: 'peer', to: 'agent_self', skill, result: `r${i}`,
        });
        r.fromSignature = 'sig';
        ledger.addReceipt(r);
      });
      assert.equal(ledger.getReceipts({ skill: 'chat' }).length, 2);
    });
  });

  describe('persistência', () => {
    it('salva e carrega do disco', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't_persist', from: 'agent_self', to: 'peer',
        skill: 'chat', result: 'persist test',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      // Cria novo ledger do mesmo dir
      const ledger2 = new Ledger({ nodeId: 'agent_self', dataDir: tmpDir });
      const receipts = ledger2.getReceipts();
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].taskId, 't_persist');
      assert.equal(ledger2.getBalance().spent, 1);
    });
  });

  describe('getSummary', () => {
    it('retorna resumo completo', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't_sum', from: 'peer', to: 'agent_self',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      const summary = ledger.getSummary();
      assert.equal(summary.nodeId, 'agent_self');
      assert.equal(summary.receipts, 1);
      assert.ok(summary.balance.credits > 100);
      assert.ok(summary.summary.bySkill.chat);
    });
  });
});
