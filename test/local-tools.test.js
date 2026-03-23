'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const createLocalTools = require('../lib/local-tools');
const Ledger = require('../lib/ledger/ledger');
const receipt = require('../lib/ledger/receipt');

describe('Local MCP Tools', () => {
  let localTools;
  let ledger;
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-tools-test-'));
    ledger = new Ledger({ nodeId: 'agent_self', dataDir: tmpDir });
    localTools = createLocalTools({ ledger });
  });

  describe('list()', () => {
    it('retorna get_ledger e verify_receipt', () => {
      const tools = localTools.list();
      const names = tools.map(t => t.name);
      assert.ok(names.includes('get_ledger'));
      assert.ok(names.includes('verify_receipt'));
      assert.ok(tools.every(t => t.description && t.inputSchema));
    });
  });

  describe('get_ledger', () => {
    it('retorna summary por padrão', () => {
      const result = localTools.handle('get_ledger', {});
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.nodeId, 'agent_self');
      assert.ok(data.balance);
      assert.equal(data.balance.bootstrap, 100);
    });

    it('retorna balance', () => {
      const result = localTools.handle('get_ledger', { view: 'balance' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.credits, 100);
    });

    it('retorna receipts com filtro', () => {
      // Adicionar receipt
      const rcpt = receipt.createReceipt({
        taskId: 't1', from: 'peer_a', to: 'agent_self',
        skill: 'chat', result: 'ok',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      const result = localTools.handle('get_ledger', { view: 'receipts', peer: 'peer_a' });
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.length, 1);
      assert.equal(data[0].taskId, 't1');
    });

    it('summary com peer detail', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't2', from: 'peer_b', to: 'agent_self',
        skill: 'code', result: 'done',
      });
      rcpt.fromSignature = 'sig';
      ledger.addReceipt(rcpt);

      const result = localTools.handle('get_ledger', { peer: 'peer_b' });
      const data = JSON.parse(result.content[0].text);
      assert.ok(data.peerDetail);
      assert.equal(data.peerDetail.peerId, 'peer_b');
    });
  });

  describe('verify_receipt', () => {
    it('verifica receipt válido', () => {
      const rcpt = receipt.createReceipt({
        taskId: 't3', from: 'a', to: 'b', skill: 'chat', result: 'ok',
      });
      // Sem assinatura — deve reportar erro
      const result = localTools.handle('verify_receipt', { receipt: rcpt });
      const data = JSON.parse(result.content[0].text);
      assert.ok(!data.valid);
      assert.ok(data.errors.some(e => e.includes('Nenhuma assinatura')));
    });
  });

  describe('handle()', () => {
    it('retorna null para tool inexistente', () => {
      assert.equal(localTools.handle('nonexistent', {}), null);
    });
  });
});
