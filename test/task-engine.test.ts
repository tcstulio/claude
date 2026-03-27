// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeAll, afterAll, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Storage from '../lib-ts/storage.js';
import TaskEngine from '../lib-ts/task-engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, '../data/test-tasks.db');

describe('TaskEngine', () => {
  let storage: InstanceType<typeof Storage>;
  let engine: InstanceType<typeof TaskEngine>;

  beforeAll(() => {
    if (fs.existsSync(TEST_DB)) fs.unlinkSync(TEST_DB);
    storage = new Storage(TEST_DB);
    engine = new TaskEngine({ storage, processInterval: 100 });
  });

  afterAll(() => {
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
    expect(task.id).toBeTruthy();
    expect(task.type).toBe('send_report');
    expect(task.status).toBe('pending');
    expect(task.priority).toBe(3);
  });

  it('tarefa aparece no storage', () => {
    const pending = storage.getTasksByStatus('pending');
    expect(pending.length >= 1).toBeTruthy();
  });

  it('registra handler e executa tarefa', async () => {
    let executed = false;

    engine.registerHandler('echo', async (task: any) => {
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
    expect(result.status).toBe('completed');
    expect(result.output).toEqual({ echo: 'hello' });
    expect(executed).toBe(true);
  });

  it('decompõe tarefa em subtarefas', () => {
    const parent = engine.submit('Tarefa complexa', { type: 'complex' });

    const subs = engine.decompose(parent.id, [
      { type: 'echo', description: 'Parte 1', input: { text: 'a' } },
      { type: 'echo', description: 'Parte 2', input: { text: 'b' } },
      { type: 'echo', description: 'Parte 3', input: { text: 'c' } },
    ]);

    expect(subs.length).toBe(3);
    const stored = storage.getSubtasks(parent.id);
    expect(stored.length).toBe(3);
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
    expect(parentTask.status).toBe('completed');
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
    expect(result.status).toBe('failed');
    expect(result.error.includes('Sempre falha')).toBeTruthy();
  });

  it('emite eventos', async () => {
    const events: string[] = [];
    engine.on('task-created', (t: any) => events.push('created:' + t.id));
    engine.on('task-completed', (e: any) => events.push('completed:' + e.taskId));

    const task = engine.submit('Evento test', { type: 'echo', input: { text: 'evt' } });
    await engine.processQueue();
    await new Promise(r => setTimeout(r, 200));

    expect(events.includes('created:' + task.id)).toBeTruthy();
    expect(events.includes('completed:' + task.id)).toBeTruthy();
  });

  it('retorna toJSON com stats', () => {
    const json = engine.toJSON();
    expect(json.handlers.includes('echo')).toBeTruthy();
    expect(json.stats).toBeTruthy();
    expect(json.stats.completed >= 1).toBeTruthy();
  });

  it('respeita maxConcurrent', () => {
    const limitedEngine = new TaskEngine({ storage, maxConcurrent: 2 });
    expect(limitedEngine._maxConcurrent).toBe(2);
  });
});
