// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

interface TaskStorage {
  insertTask(task: Task): void;
  getTask(taskId: string): Task | null;
  getTasksByStatus(status: TaskStatus): Task[];
  getSubtasks(parentId: string): Task[];
  updateTaskStatus(taskId: string, status: TaskStatus, extra?: Partial<Task>): void;
  getTaskStats(): TaskStats;
  log(event: string, nodeId: string | null, extra: unknown, data: Record<string, unknown>): void;
}

interface MeshRegistry {
  has(nodeId: string): boolean;
  list(filter?: { capability?: string }): PeerInfo[];
  online(): PeerInfo[];
}

interface Mesh {
  registry: MeshRegistry;
}

interface PeerInfo {
  nodeId: string;
  latency?: number;
}

type TaskStatus = 'pending' | 'running' | 'completed' | 'failed';

interface Task {
  id: string;
  parentId?: string;
  type: string;
  description: string;
  input: Record<string, unknown>;
  priority: number;
  maxRetries: number;
  retries?: number;
  assignedTo: string | null;
  createdAt: string;
  status: TaskStatus;
  output?: unknown;
  error?: string;
}

interface TaskStats {
  [key: string]: unknown;
}

type TaskHandler = (task: Task) => Promise<unknown>;

type CallMcpToolFn = (toolName: string, args: Record<string, unknown>) => Promise<unknown>;

interface TaskEngineOptions {
  storage?: TaskStorage;
  mesh?: Mesh | null;
  callMcpTool?: CallMcpToolFn | null;
  processInterval?: number;
  maxConcurrent?: number;
}

interface SubmitOptions {
  type?: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  assignedTo?: string | null;
}

interface SubtaskDefinition {
  type?: string;
  description: string;
  input?: Record<string, unknown>;
  priority?: number;
  maxRetries?: number;
  assignedTo?: string | null;
}

interface TaskEngineJSON {
  running: boolean;
  handlers: string[];
  runningCount: number;
  maxConcurrent: number;
  stats: TaskStats;
}

class TaskEngine extends EventEmitter {
  private _storage: TaskStorage | undefined;
  private _mesh: Mesh | null;
  private _callMcpTool: CallMcpToolFn | null;
  private _handlers: Map<string, TaskHandler>;
  private _running: boolean;
  private _processInterval: number;
  private _timer: ReturnType<typeof setInterval> | null;
  private _maxConcurrent: number;
  private _runningCount: number;

  constructor(options: TaskEngineOptions = {}) {
    super();
    this._storage = options.storage;
    this._mesh = options.mesh ?? null;
    this._callMcpTool = options.callMcpTool ?? null;
    this._handlers = new Map();
    this._running = false;
    this._processInterval = options.processInterval || 5000;
    this._timer = null;
    this._maxConcurrent = options.maxConcurrent || 5;
    this._runningCount = 0;
  }

  registerHandler(type: string, handler: TaskHandler): this {
    this._handlers.set(type, handler);
    return this;
  }

  submit(description: string, options: SubmitOptions = {}): Task {
    const task: Task = {
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

  decompose(parentId: string, subtasks: SubtaskDefinition[]): Task[] {
    const created: Task[] = [];
    for (const sub of subtasks) {
      const task: Task = {
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
      if (this._storage) this._storage.insertTask(task);
      created.push(task);
      this.emit('subtask-created', { parentId, task });
    }
    if (this._storage) this._storage.log('task.decomposed', null, null, { parentId, subtasks: created.length });
    return created;
  }

  async delegate(taskId: string, nodeId: string): Promise<unknown> {
    if (!this._mesh || !this._callMcpTool) throw new Error('Mesh não configurado para delegação');
    const task = this._storage?.getTask(taskId);
    if (!task) throw new Error(`Task ${taskId} não encontrada`);
    if (this._storage) this._storage.updateTaskStatus(taskId, 'running', { assignedTo: nodeId });
    try {
      const result = await this._callMcpTool('send_prompt', {
        target_agent: nodeId,
        prompt: JSON.stringify({ type: 'TASK', taskId: task.id, taskType: task.type, description: task.description, input: task.input }),
      });
      if (this._storage) {
        this._storage.updateTaskStatus(taskId, 'completed', { output: result });
        this._storage.log('task.delegated.completed', nodeId, null, { taskId });
      }
      this.emit('task-completed', { taskId, nodeId, result });
      this._checkParentCompletion(task.parentId);
      return result;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (this._storage) {
        this._storage.updateTaskStatus(taskId, 'failed', { error });
        this._storage.log('task.delegated.failed', nodeId, null, { taskId, error });
      }
      this.emit('task-failed', { taskId, nodeId, error });
      throw err;
    }
  }

  async processQueue(): Promise<void> {
    if (!this._storage) return;
    const pending = this._storage.getTasksByStatus('pending');
    for (const task of pending) {
      if (this._runningCount >= this._maxConcurrent) break;
      if (task.assignedTo && this._mesh?.registry.has(task.assignedTo)) {
        this._runningCount++;
        this.delegate(task.id, task.assignedTo).catch(() => {}).finally(() => { this._runningCount--; });
        continue;
      }
      const handler = this._handlers.get(task.type);
      if (!handler) continue;
      this._runningCount++;
      this._executeLocal(task, handler).catch(() => {}).finally(() => { this._runningCount--; });
    }
  }

  private async _executeLocal(task: Task, handler: TaskHandler): Promise<unknown> {
    if (this._storage) this._storage.updateTaskStatus(task.id, 'running');
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
      const errorMessage = err instanceof Error ? err.message : String(err);
      const retries = (task.retries || 0) + 1;
      if (retries < task.maxRetries) {
        if (this._storage) this._storage.updateTaskStatus(task.id, 'pending', { error: errorMessage });
        this.emit('task-retry', { taskId: task.id, retries, error: errorMessage });
      } else {
        if (this._storage) {
          this._storage.updateTaskStatus(task.id, 'failed', { error: errorMessage });
          this._storage.log('task.failed', null, null, { taskId: task.id, error: errorMessage });
        }
        this.emit('task-failed', { taskId: task.id, error: errorMessage });
      }
      return undefined;
    }
  }

  private _checkParentCompletion(parentId?: string): void {
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

  autoAssign(taskId: string): string | null {
    if (!this._mesh || !this._storage) return null;
    const task = this._storage.getTask(taskId);
    if (!task) return null;
    const peers = this._mesh.registry.list({ capability: task.type });
    if (peers.length === 0) {
      const online = this._mesh.registry.online();
      if (online.length === 0) return null;
      const best = online.sort((a, b) => (a.latency || 9999) - (b.latency || 9999))[0];
      return best.nodeId;
    }
    const best = peers.sort((a, b) => (a.latency || 9999) - (b.latency || 9999))[0];
    return best.nodeId;
  }

  start(): void {
    if (this._running) return;
    this._running = true;
    this._timer = setInterval(() => this.processQueue(), this._processInterval);
    console.log(`[task-engine] Ativo — processando a cada ${this._processInterval / 1000}s`);
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON(): TaskEngineJSON {
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

export default TaskEngine;
export type { Task, TaskStatus, TaskStorage, TaskEngineOptions, TaskHandler, SubtaskDefinition };
