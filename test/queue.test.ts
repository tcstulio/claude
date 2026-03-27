// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import MessageQueue from '../lib-ts/queue.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_PERSIST = path.join(__dirname, '../data/test-queue.json');

describe('MessageQueue', () => {
  let queue: InstanceType<typeof MessageQueue>;
  let sent: any[];

  beforeEach(() => {
    // Limpa arquivo de persistência do teste
    try { fs.unlinkSync(TEST_PERSIST); } catch {}

    sent = [];
    queue = new MessageQueue({
      sendFn: async (item: any) => {
        sent.push(item);
      },
      persistPath: TEST_PERSIST,
    });
  });

  describe('enqueue', () => {
    it('adiciona item à fila', () => {
      const item = queue.enqueue('Hello', '5511999', 'whatsapp');
      expect(item.id).toBeTruthy();
      expect(item.destination).toBe('5511999');
      expect(item.message).toBe('Hello');
      expect(item.channel).toBe('whatsapp');
      expect(item.attempts).toBe(0);
    });

    it('incrementa contador de pending', () => {
      queue.enqueue('msg1', 'dest1');
      queue.enqueue('msg2', 'dest2');
      expect(queue.pending).toBe(2);
    });
  });

  describe('process', () => {
    it('processa itens pendentes', async () => {
      queue.enqueue('msg1', 'dest1');
      queue.enqueue('msg2', 'dest2');
      await queue.process();
      expect(sent.length).toBe(2);
    });

    it('remove itens entregues', async () => {
      queue.enqueue('msg1', 'dest1');
      await queue.process();
      expect(queue.pending).toBe(0);
      expect(queue.delivered).toBe(1);
    });

    it('mantém item na fila quando sendFn falha', async () => {
      const failQueue = new MessageQueue({
        sendFn: async () => { throw new Error('falha'); },
        persistPath: TEST_PERSIST,
      });
      failQueue.enqueue('msg1', 'dest1');
      await failQueue.process();
      // Item ainda está pending (com retry)
      expect(failQueue.pending).toBe(1);
    });
  });

  describe('TTL', () => {
    it('expira itens com TTL expirado', async () => {
      queue.enqueue('msg1', 'dest1');
      // Força expiração setando expiresAt no passado
      (queue as any)._pending[0].expiresAt = new Date(Date.now() - 1000).toISOString();
      await queue.process();
      expect(queue.pending).toBe(0);
      expect(queue.failed).toBe(1);
    });
  });

  describe('toJSON', () => {
    it('retorna estatísticas', () => {
      const json = queue.toJSON();
      expect(json.stats).toBeTruthy();
      expect(typeof json.stats.pending).toBe('number');
      expect(typeof json.stats.delivered).toBe('number');
      expect(typeof json.stats.failed).toBe('number');
    });
  });

  // Cleanup
  it('cleanup', () => {
    try { fs.unlinkSync(TEST_PERSIST); } catch {}
    expect(true).toBeTruthy();
  });
});
