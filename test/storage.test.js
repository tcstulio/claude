'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Storage = require('../lib/storage');

const TEST_DB = path.join(__dirname, '../data/test-storage.db');

describe('Storage (SQLite)', () => {
  let storage;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
  });

  after(() => {
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
      assert.ok(pending.length >= 1);
      const msg = pending.find(m => m.id === 'msg-001');
      assert.ok(msg);
      assert.equal(msg.destination, '5511999999999');
      assert.deepEqual(msg.message, { text: 'Olá mundo' });
    });

    it('marca como entregue', () => {
      storage.markDelivered('msg-001');
      const pending = storage.getPendingMessages();
      assert.ok(!pending.find(m => m.id === 'msg-001'));

      const delivered = storage.getRecentMessages('delivered');
      assert.ok(delivered.find(m => m.id === 'msg-001'));
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
      const msg = failed.find(m => m.id === 'msg-002');
      assert.ok(msg);
      assert.equal(msg.failedReason, 'timeout');
    });

    it('busca mensagens por texto', () => {
      const results = storage.searchMessages('5511999');
      assert.ok(results.length >= 1);
    });

    it('retorna estatísticas de mensagens', () => {
      const stats = storage.getMessageStats();
      assert.ok(stats.delivered >= 1);
      assert.ok(stats.failed >= 1);
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
      assert.ok(task);
      assert.equal(task.type, 'analyze');
      assert.equal(task.priority, 3);
      assert.deepEqual(task.input, { data: [1, 2, 3] });
    });

    it('lista por status', () => {
      const pending = storage.getTasksByStatus('pending');
      assert.ok(pending.length >= 1);
    });

    it('atualiza status para running', () => {
      storage.updateTaskStatus('task-001', 'running');
      const task = storage.getTask('task-001');
      assert.equal(task.status, 'running');
      assert.ok(task.startedAt);
    });

    it('atualiza status para completed com output', () => {
      storage.updateTaskStatus('task-001', 'completed', { output: { result: 'ok' } });
      const task = storage.getTask('task-001');
      assert.equal(task.status, 'completed');
      assert.deepEqual(task.output, { result: 'ok' });
      assert.ok(task.completedAt);
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
      assert.equal(subs.length, 2);
    });

    it('retorna estatísticas de tarefas', () => {
      const stats = storage.getTaskStats();
      assert.ok(stats.completed >= 1);
      assert.ok(stats.pending >= 0);
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
      assert.ok(peer);
      assert.equal(peer.name, 'Peer Test');
      assert.deepEqual(peer.capabilities, ['hub', 'relay']);
    });

    it('atualiza peer existente', () => {
      storage.upsertPeer({
        nodeId: 'node-abc123',
        name: 'Peer Test Updated',
        latency: 42,
      });

      const peer = storage.getPeer('node-abc123');
      assert.equal(peer.name, 'Peer Test Updated');
      assert.equal(peer.latency, 42);
    });

    it('lista todos os peers', () => {
      const all = storage.getAllPeers();
      assert.ok(all.length >= 1);
    });

    it('remove peer', () => {
      storage.removePeer('node-abc123');
      assert.equal(storage.getPeer('node-abc123'), null);
    });
  });

  // ─── Audit Log ─────────────────────────────────────────────────────

  describe('Audit Log', () => {
    it('insere e busca log', () => {
      storage.log('test.event', 'source-1', 'target-1', { foo: 'bar' });
      storage.log('test.event', 'source-2', null, { baz: 42 });
      storage.log('other.event', 'source-1', null, {});

      const logs = storage.getAuditLog({ event: 'test.event' });
      assert.ok(logs.length >= 2);
      assert.equal(logs[0].event, 'test.event');
    });

    it('filtra por source', () => {
      const logs = storage.getAuditLog({ source: 'source-1' });
      assert.ok(logs.length >= 1);
    });

    it('retorna stats gerais', () => {
      const stats = storage.stats;
      assert.ok(stats.messages);
      assert.ok(stats.tasks);
      assert.ok(stats.auditEntries >= 3);
    });
  });
});
