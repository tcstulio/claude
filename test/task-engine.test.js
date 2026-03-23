'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const Storage = require('../lib/storage');
const TaskEngine = require('../lib/task-engine');

const TEST_DB = path.join(__dirname, '../data/test-tasks.db');

describe('TaskEngine', () => {
  let storage;
  let engine;

  before(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
    engine = new TaskEngine({ storage, processInterval: 100 });
  });

  after(() => {
    engine.stop();
    storage.close();
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    for (const ext of ['-wal', '-shm']) {
      const f = TEST_DB + ext;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  it('submete uma tarefa', () => {
    const task = engine.submit('Enviar relatório', {
      type: 'send_report',
      input: { reportId: 'r-001' },
      priority: 3,
    });
    assert.ok(task.id);
    assert.equal(task.type, 'send_report');
    assert.equal(task.status, 'pending');
    assert.equal(task.priority, 3);
  });

  it('tarefa aparece no storage', () => {
    const pending = storage.getTasksByStatus('pending');
    assert.ok(pending.length >= 1);
  });

  it('registra handler e executa tarefa', async () => {
    let executed = false;

    engine.registerHandler('echo', async (task) => {
      executed = true;
      return { echo: task.input.text };
    });

    const task = engine.submit('Echo test', {
      type: 'echo',
      input: { text: 'hello' },
    });

    await engine.processQueue();

    // Aguarda execução assíncrona
    await new Promise(r => setTimeout(r, 200));

    const result = storage.getTask(task.id);
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.output, { echo: 'hello' });
    assert.equal(executed, true);
  });

  it('decompõe tarefa em subtarefas', () => {
    const parent = engine.submit('Tarefa complexa', { type: 'complex' });

    const subs = engine.decompose(parent.id, [
      { type: 'echo', description: 'Parte 1', input: { text: 'a' } },
      { type: 'echo', description: 'Parte 2', input: { text: 'b' } },
      { type: 'echo', description: 'Parte 3', input: { text: 'c' } },
    ]);

    assert.equal(subs.length, 3);
    const stored = storage.getSubtasks(parent.id);
    assert.equal(stored.length, 3);
  });

  it('executa subtarefas e completa parent', async () => {
    const parent = engine.submit('Parent auto', { type: 'aggregate' });

    engine.decompose(parent.id, [
      { type: 'echo', description: 'Sub A', input: { text: 'A' } },
      { type: 'echo', description: 'Sub B', input: { text: 'B' } },
    ]);

    // Processa até completar
    await engine.processQueue();
    await new Promise(r => setTimeout(r, 300));
    await engine.processQueue();
    await new Promise(r => setTimeout(r, 300));

    const parentTask = storage.getTask(parent.id);
    assert.equal(parentTask.status, 'completed');
  });

  it('marca tarefa como failed após erro', async () => {
    engine.registerHandler('fail_always', async () => {
      throw new Error('Sempre falha');
    });

    const task = engine.submit('Vai falhar', {
      type: 'fail_always',
      maxRetries: 1,
    });

    await engine.processQueue();
    await new Promise(r => setTimeout(r, 200));

    const result = storage.getTask(task.id);
    assert.equal(result.status, 'failed');
    assert.ok(result.error.includes('Sempre falha'));
  });

  it('emite eventos', async () => {
    const events = [];
    engine.on('task-created', (t) => events.push('created:' + t.id));
    engine.on('task-completed', (e) => events.push('completed:' + e.taskId));

    const task = engine.submit('Evento test', { type: 'echo', input: { text: 'evt' } });
    await engine.processQueue();
    await new Promise(r => setTimeout(r, 200));

    assert.ok(events.includes('created:' + task.id));
    assert.ok(events.includes('completed:' + task.id));
  });

  it('retorna toJSON com stats', () => {
    const json = engine.toJSON();
    assert.ok(json.handlers.includes('echo'));
    assert.ok(json.stats);
    assert.ok(json.stats.completed >= 1);
  });

  it('respeita maxConcurrent', () => {
    const limitedEngine = new TaskEngine({ storage, maxConcurrent: 2 });
    assert.equal(limitedEngine._maxConcurrent, 2);
  });
});
