// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Storage from '../lib-ts/storage.js';
import MessageQueueSQLite from '../lib-ts/queue-sqlite.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '../data/test-queue-sqlite.db');

describe('MessageQueueSQLite', () => {
  let storage: InstanceType<typeof Storage>;
  let queue: InstanceType<typeof MessageQueueSQLite>;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
    queue = new MessageQueueSQLite({
      storage,
      sendFn: async (item: any) => {
        if (item.message.fail) throw new Error('Send failed');
      },
    });
  });

  afterAll(() => {
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
    expect(item.id).toBeTruthy();
    expect(item.destination).toBe('5511999999999');
  });

  it('processa e entrega mensagem', async () => {
    const item = queue.enqueue({ text: 'Entregável' }, 'dest-1', null);

    let delivered = false;
    queue.on('delivered', (i: any) => { if (i.id === item.id) delivered = true; });

    await queue.process();
    expect(delivered).toBe(true);
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
    q.on('failed', (i: any) => { if (i.id === item.id) failed = true; });

    await q.process();
    expect(failed).toBe(true);

    failStorage.close();
    if (fs.existsSync(failDb)) fs.unlinkSync(failDb);
    for (const ext of ['-wal', '-shm']) {
      const f = failDb + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('retorna stats via pending/delivered/failed', () => {
    expect(typeof queue.pending === 'number').toBeTruthy();
    expect(typeof queue.delivered === 'number').toBeTruthy();
    expect(typeof queue.failed === 'number').toBeTruthy();
  });

  it('toJSON retorna estrutura completa', () => {
    const json = queue.toJSON();
    expect(json.stats).toBeTruthy();
    expect(Array.isArray(json.pending)).toBeTruthy();
    expect(Array.isArray(json.delivered)).toBeTruthy();
    expect(Array.isArray(json.failed)).toBeTruthy();
  });

  it('busca mensagens', () => {
    queue.enqueue({ text: 'Buscável' }, 'busca-destino', 'email');
    const results = queue.search('busca-destino');
    expect(results.length >= 1).toBeTruthy();
  });
});
