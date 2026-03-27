'use strict';

const crypto = require('crypto');
const { EventEmitter } = require('events');

/**
 * TaskEngine — decompõe, delega e executa tarefas na rede Tulipa.
 *
 * Fluxo:
 *   1. Recebe tarefa complexa via submit()
 *   2. Decompõe em subtarefas (se decomposer configurado)
 *   3. Atribui a peers disponíveis (se mesh configurado)
 *   4. Executa localmente ou delega remotamente
 *   5. Agrega resultados quando todas as subtarefas completam
 */
class TaskEngine extends EventEmitter {
  constructor(options = {}) {
    super();
    this._storage = options.storage; // Storage instance
    this._mesh = options.mesh || null; // MeshManager para delegação
    this._callMcpTool = options.callMcpTool || null;
    this._handlers = new Map(); // type -> handler function
    this._running = false;
    this._processInterval = options.processInterval || 5000;
    this._timer = null;
    this._maxConcurrent = options.maxConcurrent || 5;
    this._runningCount = 0;
  }

  /**
   * Registra um handler para um tipo de tarefa.
   * @param {string} type - tipo da tarefa (ex: 'send_message', 'analyze', 'transform')
   * @param {function} handler - async (task) => result
   */
  registerHandler(type, handler) {
    this._handlers.set(type, handler);
    return this;
  }

  /**
   * Submete uma nova tarefa.
   */
  submit(description, options = {}) {
    const task = {
      id: crypto.randomUUID(),
      type: options.type || 'generic',
      description,
      input: options.input || {},
      priority: options.priority || 5,
      maxRetries: options.maxRetries || 3,
      assignedTo: options.assignedTo || null,
      createdAt: new Date().toISOString(),
      status: 'pending',
    };

    if (this._storage) {
      this._storage.insertTask(task);
      this._storage.log('task.created', null, null, { taskId: task.id, type: task.type, description });
    }

    this.emit('task-created', task);
    return task;
  }

  /**
   * Decompõe uma tarefa em subtarefas.
   */
  decompose(parentId, subtasks) {
    const created = [];
    for (const sub of subtasks) {
      const task = {
        id: crypto.randomUUID(),
        parentId,
        type: sub.type || 'generic',
        description: sub.description,
        input: sub.input || {},
        priority: sub.priority || 5,
        maxRetries: sub.maxRetries || 3,
        assignedTo: sub.assignedTo || null,
        createdAt: new Date().toISOString(),
        status: 'pending',
      };

      if (this._storage) {
        this._storage.insertTask(task);
      }
      created.push(task);
      this.emit('subtask-created', { parentId, task });
    }

    if (this._storage) {
      this._storage.log('task.decomposed', null, null, { parentId, subtasks: created.length });
    }

    return created;
  }

  /**
   * Delega tarefa para um peer da mesh.
   */
  async delegate(taskId, nodeId) {
    if (!this._mesh || !this._callMcpTool) {
      throw new Error('Mesh não configurado para delegação');
    }

    const task = this._storage?.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} não encontrada`);

    // Atualiza status
    if (this._storage) {
      this._storage.updateTaskStatus(taskId, 'running', { assignedTo: nodeId });
    }

    try {
      const result = await this._callMcpTool('send_prompt', {
        target_agent: nodeId,
        prompt: JSON.stringify({
          type: 'TASK',
          taskId: task.id,
          taskType: task.type,
          description: task.description,
          input: task.input,
        }),
      });

      if (this._storage) {
        this._storage.updateTaskStatus(taskId, 'completed', { output: result });
        this._storage.log('task.delegated.completed', nodeId, null, { taskId });
      }

      this.emit('task-completed', { taskId, nodeId, result });
      this._checkParentCompletion(task.parentId);
      return result;
    } catch (err) {
      if (this._storage) {
        this._storage.updateTaskStatus(taskId, 'failed', { error: err.message });
        this._storage.log('task.delegated.failed', nodeId, null, { taskId, error: err.message });
      }
      this.emit('task-failed', { taskId, nodeId, error: err.message });
      throw err;
    }
  }

  /**
   * Processa tarefas pendentes localmente.
   */
  async processQueue() {
    if (!this._storage) return;

    const pending = this._storage.getTasksByStatus('pending');

    for (const task of pending) {
      if (this._runningCount >= this._maxConcurrent) break;

      // Se tem assignedTo e é um peer, delega
      if (task.assignedTo && this._mesh?.registry.has(task.assignedTo)) {
        this._runningCount++;
        this.delegate(task.id, task.assignedTo)
          .catch(() => {})
          .finally(() => { this._runningCount--; });
        continue;
      }

      // Executa localmente se tem handler
      const handler = this._handlers.get(task.type);
      if (!handler) continue;

      this._runningCount++;
      this._executeLocal(task, handler)
        .catch(() => {}) // erro já tratado dentro de _executeLocal
        .finally(() => { this._runningCount--; });
    }
  }

  async _executeLocal(task, handler) {
    if (this._storage) {
      this._storage.updateTaskStatus(task.id, 'running');
    }
    this.emit('task-started', task);

    try {
      const result = await handler(task);
      if (this._storage) {
        this._storage.updateTaskStatus(task.id, 'completed', { output: result });
        this._storage.log('task.completed', null, null, { taskId: task.id });
      }
      this.emit('task-completed', { taskId: task.id, result });
      this._checkParentCompletion(task.parentId);
      return result;
    } catch (err) {
      const retries = (task.retries || 0) + 1;
      if (retries < task.maxRetries) {
        if (this._storage) {
          this._storage.updateTaskStatus(task.id, 'pending', { error: err.message });
        }
        this.emit('task-retry', { taskId: task.id, retries, error: err.message });
      } else {
        if (this._storage) {
          this._storage.updateTaskStatus(task.id, 'failed', { error: err.message });
          this._storage.log('task.failed', null, null, { taskId: task.id, error: err.message });
        }
        this.emit('task-failed', { taskId: task.id, error: err.message });
      }
    }
  }

  /**
   * Verifica se todas as subtarefas de um parent completaram.
   */
  _checkParentCompletion(parentId) {
    if (!parentId || !this._storage) return;

    const subtasks = this._storage.getSubtasks(parentId);
    if (subtasks.length === 0) return;

    const allDone = subtasks.every(t => t.status === 'completed' || t.status === 'failed');
    if (!allDone) return;

    const allOk = subtasks.every(t => t.status === 'completed');
    const outputs = subtasks.filter(t => t.output).map(t => t.output);

    if (allOk) {
      this._storage.updateTaskStatus(parentId, 'completed', { output: { subtasks: outputs } });
      this._storage.log('task.parent.completed', null, null, { parentId, subtasks: subtasks.length });
      this.emit('parent-completed', { parentId, outputs });
    } else {
      const errors = subtasks.filter(t => t.status === 'failed').map(t => t.error);
      this._storage.updateTaskStatus(parentId, 'failed', { error: errors.join('; ') });
      this.emit('parent-failed', { parentId, errors });
    }
  }

  /**
   * Auto-delega para peers com base em capabilities.
   */
  autoAssign(taskId) {
    if (!this._mesh || !this._storage) return null;

    const task = this._storage.getTask(taskId);
    if (!task) return null;

    // Busca peers online com a capability do tipo de tarefa
    const peers = this._mesh.registry.list({ capability: task.type });
    if (peers.length === 0) {
      // Fallback: qualquer peer online
      const online = this._mesh.registry.online();
      if (online.length === 0) return null;
      // Escolhe o com menor latência
      const best = online.sort((a, b) => (a.latency || 9999) - (b.latency || 9999))[0];
      return best.nodeId;
    }

    // Peer com menor latência que tem a capability
    const best = peers.sort((a, b) => (a.latency || 9999) - (b.latency || 9999))[0];
    return best.nodeId;
  }

  start() {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this.processQueue(), this._processInterval);
    console.log(`[task-engine] Ativo — processando a cada ${this._processInterval / 1000}s`);
  }

  stop() {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON() {
    const stats = this._storage?.getTaskStats() || {};
    return {
      running: this._running,
      handlers: [...this._handlers.keys()],
      runningCount: this._runningCount,
      maxConcurrent: this._maxConcurrent,
      stats,
    };
  }
}

module.exports = TaskEngine;
