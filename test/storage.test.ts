// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Storage from '../lib-ts/storage.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '../data/test-storage.db');

describe('Storage (SQLite)', () => {
  let storage: InstanceType<typeof Storage>;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
  });

  afterAll(() => {
    storage.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    // Remove WAL/SHM files
    for (const ext of ['-wal', '-shm']) {
      const f = TEST_DB + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  // ─── Messages ──────────────────────────────────────────────────────

  describe('Messages', () => {
    it('insere e busca mensagem pendente', () => {
      storage.insertMessage({
        id: 'msg-001',
        destination: '5511999999999',
        channel: 'whatsapp',
        message: { text: 'Olá mundo' },
        attempts: 0,
        nextRetry: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });

      const pending = storage.getPendingMessages();
      expect(pending.length >= 1).toBeTruthy();
      const msg = pending.find((m: any) => m.id === 'msg-001');
      expect(msg).toBeTruthy();
      expect(msg.destination).toBe('5511999999999');
      expect(msg.message).toEqual({ text: 'Olá mundo' });
    });

    it('marca como entregue', () => {
      storage.markDelivered('msg-001');
      const pending = storage.getPendingMessages();
      expect(pending.find((m: any) => m.id === 'msg-001')).not.toBeTruthy();

      const delivered = storage.getRecentMessages('delivered');
      expect(delivered.find((m: any) => m.id === 'msg-001')).toBeTruthy();
    });

    it('marca como falha', () => {
      storage.insertMessage({
        id: 'msg-002',
        destination: 'test',
        channel: null,
        message: { text: 'Falha' },
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      });
      storage.markFailed('msg-002', 'timeout');
      const failed = storage.getRecentMessages('failed');
      const msg = failed.find((m: any) => m.id === 'msg-002');
      expect(msg).toBeTruthy();
      expect(msg.failedReason).toBe('timeout');
    });

    it('busca mensagens por texto', () => {
      const results = storage.searchMessages('5511999');
      expect(results.length >= 1).toBeTruthy();
    });

    it('retorna estatísticas de mensagens', () => {
      const stats = storage.getMessageStats();
      expect(stats.delivered >= 1).toBeTruthy();
      expect(stats.failed >= 1).toBeTruthy();
    });
  });

  // ─── Tasks ─────────────────────────────────────────────────────────

  describe('Tasks', () => {
    it('insere e busca tarefa', () => {
      storage.insertTask({
        id: 'task-001',
        type: 'analyze',
        description: 'Analisar dados',
        input: { data: [1, 2, 3] },
        priority: 3,
      });

      const task = storage.getTask('task-001');
      expect(task).toBeTruthy();
      expect(task.type).toBe('analyze');
      expect(task.priority).toBe(3);
      expect(task.input).toEqual({ data: [1, 2, 3] });
    });

    it('lista por status', () => {
      const pending = storage.getTasksByStatus('pending');
      expect(pending.length >= 1).toBeTruthy();
    });

    it('atualiza status para running', () => {
      storage.updateTaskStatus('task-001', 'running');
      const task = storage.getTask('task-001');
      expect(task.status).toBe('running');
      expect(task.startedAt).toBeTruthy();
    });

    it('atualiza status para completed com output', () => {
      storage.updateTaskStatus('task-001', 'completed', { output: { result: 'ok' } });
      const task = storage.getTask('task-001');
      expect(task.status).toBe('completed');
      expect(task.output).toEqual({ result: 'ok' });
      expect(task.completedAt).toBeTruthy();
    });

    it('subtarefas por parent_id', () => {
      storage.insertTask({
        id: 'task-sub-001',
        parentId: 'task-001',
        type: 'sub',
        description: 'Subtarefa 1',
      });
      storage.insertTask({
        id: 'task-sub-002',
        parentId: 'task-001',
        type: 'sub',
        description: 'Subtarefa 2',
      });

      const subs = storage.getSubtasks('task-001');
      expect(subs.length).toBe(2);
    });

    it('retorna estatísticas de tarefas', () => {
      const stats = storage.getTaskStats();
      expect(stats.completed >= 1).toBeTruthy();
      expect(stats.pending >= 0).toBeTruthy();
    });
  });

  // ─── Peers ─────────────────────────────────────────────────────────

  describe('Peers', () => {
    it('insere e busca peer', () => {
      storage.upsertPeer({
        nodeId: 'node-abc123',
        name: 'Peer Test',
        capabilities: ['hub', 'relay'],
        channels: ['whatsapp'],
        endpoint: 'https://example.com',
      });

      const peer = storage.getPeer('node-abc123');
      expect(peer).toBeTruthy();
      expect(peer.name).toBe('Peer Test');
      expect(peer.capabilities).toEqual(['hub', 'relay']);
    });

    it('atualiza peer existente', () => {
      storage.upsertPeer({
        nodeId: 'node-abc123',
        name: 'Peer Test Updated',
        latency: 42,
      });

      const peer = storage.getPeer('node-abc123');
      expect(peer.name).toBe('Peer Test Updated');
      expect(peer.latency).toBe(42);
    });

    it('lista todos os peers', () => {
      const all = storage.getAllPeers();
      expect(all.length >= 1).toBeTruthy();
    });

    it('remove peer', () => {
      storage.removePeer('node-abc123');
      expect(storage.getPeer('node-abc123')).toBe(null);
    });
  });

  // ─── Audit Log ─────────────────────────────────────────────────────

  describe('Audit Log', () => {
    it('insere e busca log', () => {
      storage.log('test.event', 'source-1', 'target-1', { foo: 'bar' });
      storage.log('test.event', 'source-2', null, { baz: 42 });
      storage.log('other.event', 'source-1', null, {});

      const logs = storage.getAuditLog({ event: 'test.event' });
      expect(logs.length >= 2).toBeTruthy();
      expect(logs[0].event).toBe('test.event');
    });

    it('filtra por source', () => {
      const logs = storage.getAuditLog({ source: 'source-1' });
      expect(logs.length >= 1).toBeTruthy();
    });

    it('retorna stats gerais', () => {
      const stats = storage.stats;
      expect(stats.messages).toBeTruthy();
      expect(stats.tasks).toBeTruthy();
      expect(stats.auditEntries >= 3).toBeTruthy();
    });
  });
});
