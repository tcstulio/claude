'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Storage = require('../lib/storage');
const MessageQueueSQLite = require('../lib/queue-sqlite');

const TEST_DB = path.join(__dirname, '../data/test-queue-sqlite.db');

describe('MessageQueueSQLite', () => {
  let storage;
  let queue;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
    queue = new MessageQueueSQLite({
      storage,
      sendFn: async (item) => {
        if (item.message.fail) throw new Error('Send failed');
      },
    });
  });

  after(() => {
    queue.stop();
    storage.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    for (const ext of ['-wal', '-shm']) {
      const f = TEST_DB + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('enfileira mensagem', () => {
    const item = queue.enqueue({ text: 'Olá SQLite' }, '5511999999999', 'whatsapp');
    assert.ok(item.id);
    assert.equal(item.destination, '5511999999999');
  });

  it('processa e entrega mensagem', async () => {
    const item = queue.enqueue({ text: 'Entregável' }, 'dest-1', null);

    let delivered = false;
    queue.on('delivered', (i) => { if (i.id === item.id) delivered = true; });

    await queue.process();
    assert.equal(delivered, true);
  });

  it('marca como falha após max retries', async () => {
    const failDb = path.join(__dirname, '../data/test-queue-fail.db');
    if (fs.existsSync(failDb)) fs.unlinkSync(failDb);
    const failStorage = new Storage(failDb);
    const q = new MessageQueueSQLite({
      storage: failStorage,
      maxRetries: 1,
      sendFn: async () => { throw new Error('Nope'); },
    });

    const item = q.enqueue({ text: 'Vai falhar', fail: true }, 'dest-fail', null);

    let failed = false;
    q.on('failed', (i) => { if (i.id === item.id) failed = true; });

    await q.process();
    assert.equal(failed, true);

    failStorage.close();
    if (fs.existsSync(failDb)) fs.unlinkSync(failDb);
    for (const ext of ['-wal', '-shm']) {
      const f = failDb + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('retorna stats via pending/delivered/failed', () => {
    assert.ok(typeof queue.pending === 'number');
    assert.ok(typeof queue.delivered === 'number');
    assert.ok(typeof queue.failed === 'number');
  });

  it('toJSON retorna estrutura completa', () => {
    const json = queue.toJSON();
    assert.ok(json.stats);
    assert.ok(Array.isArray(json.pending));
    assert.ok(Array.isArray(json.delivered));
    assert.ok(Array.isArray(json.failed));
  });

  it('busca mensagens', () => {
    queue.enqueue({ text: 'Buscável' }, 'busca-destino', 'email');
    const results = queue.search('busca-destino');
    assert.ok(results.length >= 1);
  });
});
