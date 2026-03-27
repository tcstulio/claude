// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import createLocalTools from '../lib-ts/local-tools.js';
import { Ledger } from '../lib-ts/ledger/ledger.js';
import { createReceipt } from '../lib-ts/ledger/receipt.js';

describe('Local MCP Tools', () => {
  let localTools: ReturnType<typeof createLocalTools>;
  let ledger: InstanceType<typeof Ledger>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tools-test-'));
    ledger = new Ledger({ nodeId: 'agent_self', dataDir: tmpDir });
    localTools = createLocalTools({ ledger });
  });

  describe('list()', () => {
    it('retorna get_ledger e verify_receipt', () => {
      const tools = localTools.list();
      const names = tools.map(t => t.name);
      expect(names.includes('get_ledger')).toBeTruthy();
      expect(names.includes('verify_receipt')).toBeTruthy();
      expect(tools.every(t => t.description && t.inputSchema)).toBeTruthy();
    });
  });

  describe('get_ledger', () => {
    it('retorna summary por padrão', () => {
      const result = localTools.handle('get_ledger', {});
      const data = JSON.parse(result.content[0].text);
      expect(data.nodeId).toBe('agent_self');
      expect(data.balance).toBeTruthy();
      expect(data.balance.bootstrap).toBe(100);
    });

    it('retorna balance', () => {
      const result = localTools.handle('get_ledger', { view: 'balance' });
      const data = JSON.parse(result.content[0].text);
      expect(data.credits).toBe(100);
    });

    it('retorna receipts com filtro', () => {
      // Adicionar receipt
      const rcpt = createReceipt({
        taskId: 't1', from: 'peer_a', to: 'agent_self',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      const result = localTools.handle('get_ledger', { view: 'receipts', peer: 'peer_a' });
      const data = JSON.parse(result.content[0].text);
      expect(data.length).toBe(1);
      expect(data[0].taskId).toBe('t1');
    });

    it('summary com peer detail', () => {
      const rcpt = createReceipt({
        taskId: 't2', from: 'peer_b', to: 'agent_self',
        skill: 'code', result: 'done',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      const result = localTools.handle('get_ledger', { peer: 'peer_b' });
      const data = JSON.parse(result.content[0].text);
      expect(data.peerDetail).toBeTruthy();
      expect(data.peerDetail.peerId).toBe('peer_b');
    });
  });

  describe('verify_receipt', () => {
    it('verifica receipt válido', () => {
      const rcpt = createReceipt({
        taskId: 't3', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      // Sem assinatura — deve reportar erro
      const result = localTools.handle('verify_receipt', { receipt: rcpt });
      const data = JSON.parse(result.content[0].text);
      expect(!data.valid).toBeTruthy();
      expect(data.errors.some((e: string) => e.includes('Nenhuma assinatura'))).toBeTruthy();
    });
  });

  describe('handle()', () => {
    it('retorna null para tool inexistente', () => {
      expect(localTools.handle('nonexistent', {})).toBe(null);
    });
  });
});
