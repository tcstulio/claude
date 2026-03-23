'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const MessageQueue = require('../lib/queue');

const TEST_PERSIST = path.join(__dirname, '../data/test-queue.json');

describe('MessageQueue', () => {
  let queue;
  let sent;

  beforeEach(() => {
    // Limpa arquivo de persistência do teste
    try { fs.unlinkSync(TEST_PERSIST); } catch {}

    sent = [];
    queue = new MessageQueue({
      sendFn: async (item) => {
        sent.push(item);
      },
      persistPath: TEST_PERSIST,
    });
  });

  describe('enqueue', () => {
    it('adiciona item à fila', () => {
      const item = queue.enqueue('Hello', '5511999', 'whatsapp');
      assert.ok(item.id);
      assert.equal(item.destination, '5511999');
      assert.equal(item.message, 'Hello');
      assert.equal(item.channel, 'whatsapp');
      assert.equal(item.attempts, 0);
    });

    it('incrementa contador de pending', () => {
      queue.enqueue('msg1', 'dest1');
      queue.enqueue('msg2', 'dest2');
      assert.equal(queue.pending, 2);
    });
  });

  describe('process', () => {
    it('processa itens pendentes', async () => {
      queue.enqueue('msg1', 'dest1');
      queue.enqueue('msg2', 'dest2');
      await queue.process();
      assert.equal(sent.length, 2);
    });

    it('remove itens entregues', async () => {
      queue.enqueue('msg1', 'dest1');
      await queue.process();
      assert.equal(queue.pending, 0);
      assert.equal(queue.delivered, 1);
    });

    it('mantém item na fila quando sendFn falha', async () => {
      const failQueue = new MessageQueue({
        sendFn: async () => { throw new Error('falha'); },
        persistPath: TEST_PERSIST,
      });
      failQueue.enqueue('msg1', 'dest1');
      await failQueue.process();
      // Item ainda está pending (com retry)
      assert.equal(failQueue.pending, 1);
    });
  });

  describe('TTL', () => {
    it('expira itens com TTL expirado', async () => {
      queue.enqueue('msg1', 'dest1');
      // Força expiração setando expiresAt no passado
      queue._pending[0].expiresAt = new Date(Date.now() - 1000).toISOString();
      await queue.process();
      assert.equal(queue.pending, 0);
      assert.equal(queue.failed, 1);
    });
  });

  describe('toJSON', () => {
    it('retorna estatísticas', () => {
      const json = queue.toJSON();
      assert.ok(json.stats);
      assert.equal(typeof json.stats.pending, 'number');
      assert.equal(typeof json.stats.delivered, 'number');
      assert.equal(typeof json.stats.failed, 'number');
    });
  });

  // Cleanup
  it('cleanup', () => {
    try { fs.unlinkSync(TEST_PERSIST); } catch {}
    assert.ok(true);
  });
});
