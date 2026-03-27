// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import * as receipt from '../lib-ts/ledger/receipt.js';
import { Ledger } from '../lib-ts/ledger/ledger.js';

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

      expect(rcpt.id.startsWith('rcpt_')).toBeTruthy();
      expect(rcpt.taskId).toBe('task_001');
      expect(rcpt.from).toBe('agent_a');
      expect(rcpt.to).toBe('agent_b');
      expect(rcpt.skill).toBe('chat');
      expect(rcpt.resultHash.length === 64).toBeTruthy(); // SHA-256 hex
      expect(rcpt.resourceUsed.durationMs).toBe(5000);
      expect(rcpt.hash.length === 64).toBeTruthy();
      expect(rcpt.fromSignature).toBe(null);
      expect(rcpt.toSignature).toBe(null);
    });

    it('id derivado do hash', () => {
      const rcpt = receipt.createReceipt({
        taskId: 'task_002', from: 'a', to: 'b', skill: 's', result: 'r',
      });
      expect(rcpt.id).toBe(`rcpt_${rcpt.hash.slice(0, 16)}`);
    });
  });

  describe('signReceipt + verifySignature', () => {
    it('assinatura válida com chave correta', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't1', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });

      const sig = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      expect(sig.length > 0).toBeTruthy();
      expect(receipt.verifySignature(rcpt.hash, sig, keysA.publicKey)).toBeTruthy();
    });

    it('assinatura inválida com chave errada', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't2', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });

      const sig = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      expect(receipt.verifySignature(rcpt.hash, sig, keysB.publicKey)).not.toBeTruthy();
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

      expect(result.valid).toBeTruthy();
      expect(result.dualSigned).toBeTruthy();
      expect(result.errors.length).toBe(0);
    });

    it('receipt com hash adulterado é inválido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't4', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = receipt.signReceipt(rcpt.hash, keysA.privateKey);
      rcpt.skill = 'hacked'; // adultera campo

      const result = receipt.verifyReceipt(rcpt, { fromPublicKey: keysA.publicKey });
      expect(result.valid).not.toBeTruthy();
      expect(result.errors.some(e => e.includes('Hash inválido'))).toBeTruthy();
    });

    it('receipt sem assinatura é inválido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't5', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      const result = receipt.verifyReceipt(rcpt);
      expect(result.valid).not.toBeTruthy();
      expect(result.errors.some(e => e.includes('Nenhuma assinatura'))).toBeTruthy();
    });
  });
});

describe('Ledger', () => {
  let ledger: InstanceType<typeof Ledger>;
  let tmpDir: string;

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
      expect(result.duplicate).not.toBeTruthy();
      expect(result.earned).toBeTruthy();
      expect(result.credits).toBe(2); // 1 base + 1 (15s/10s)
      expect(result.balance.credits).toBe(102); // 100 bootstrap + 2
      expect(result.balance.earned).toBe(2);
    });

    it('adiciona receipt e atualiza saldo (spent)', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't2', from: 'agent_self', to: 'agent_peer',
        skill: 'code', result: 'ok', resourceUsed: { durationMs: 5000 },
      });
      rcpt.fromSignature = 'fake_sig';

      const result = ledger.addReceipt(rcpt);
      expect(result.earned).not.toBeTruthy();
      expect(result.credits).toBe(1); // 1 base + 0 (5s < 10s)
      expect(result.balance.credits).toBe(99); // 100 - 1
      expect(result.balance.spent).toBe(1);
    });

    it('deduplicação por ID', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't3', from: 'agent_self', to: 'agent_peer',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';

      ledger.addReceipt(rcpt);
      const result = ledger.addReceipt(rcpt);
      expect(result.duplicate).toBeTruthy();
    });

    it('emite evento receipt-added', () => {
      return new Promise<void>((resolve) => {
        ledger.on('receipt-added', (data) => {
          expect(data.receipt).toBeTruthy();
          expect(typeof data.credits === 'number').toBeTruthy();
          resolve();
        });

        const rcpt = receipt.createReceipt({
          taskId: 't4', from: 'agent_peer', to: 'agent_self',
          skill: 'chat', result: 'ok',
        });
        rcpt.fromSignature = 'sig';
        ledger.addReceipt(rcpt);
      });
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
      expect(ledger.getReceipts({ peer: 'peer_a' }).length).toBe(2);
      expect(ledger.getReceipts({ peer: 'peer_b' }).length).toBe(1);
    });

    it('filtra por skill', () => {
      ['chat', 'code', 'chat'].forEach((skill, i) => {
        const r = receipt.createReceipt({
          taskId: `t${i}`, from: 'peer', to: 'agent_self', skill, result: `r${i}`,
        });
        r.fromSignature = 'sig';
        ledger.addReceipt(r);
      });
      expect(ledger.getReceipts({ skill: 'chat' }).length).toBe(2);
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
      expect(receipts.length).toBe(1);
      expect(receipts[0].taskId).toBe('t_persist');
      expect(ledger2.getBalance().spent).toBe(1);
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
      expect(summary.nodeId).toBe('agent_self');
      expect(summary.receipts).toBe(1);
      expect(summary.balance.credits > 100).toBeTruthy();
      expect(summary.summary.bySkill.chat).toBeTruthy();
    });
  });
});
