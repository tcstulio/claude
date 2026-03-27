// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS1470 — import.meta is valid at runtime (package.json type=module)
const require = createRequire(import.meta.url);

const DEFAULT_DB_PATH: string = process.env.TULIPA_DB_PATH || './data/tulipa.db';

const SCHEMA_STMTS: string[] = [
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, destination TEXT, channel TEXT, message TEXT NOT NULL,
    attempts INTEGER DEFAULT 0, last_attempt TEXT, next_retry TEXT,
    created_at TEXT NOT NULL, expires_at TEXT, delivered_at TEXT,
    failed_reason TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','expired'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_destination ON messages(destination)`,
  `CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, parent_id TEXT, type TEXT NOT NULL, description TEXT NOT NULL,
    input TEXT, output TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
    assigned_to TEXT, created_at TEXT NOT NULL, started_at TEXT, completed_at TEXT,
    priority INTEGER DEFAULT 5, retries INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3, error TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)`,
  `CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id)`,
  `CREATE TABLE IF NOT EXISTS peers (
    node_id TEXT PRIMARY KEY, name TEXT, capabilities TEXT, channels TEXT,
    endpoint TEXT, public_key TEXT, first_seen TEXT, last_seen TEXT,
    status TEXT DEFAULT 'online', latency INTEGER, metadata TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL, event TEXT NOT NULL,
    source TEXT, target TEXT, details TEXT, signature TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event)`,
];

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MessageRow {
  id: string;
  destination: string;
  channel: string | null;
  message: string;
  attempts: number;
  last_attempt: string | null;
  next_retry: string | null;
  created_at: string;
  expires_at: string | null;
  delivered_at: string | null;
  failed_reason: string | null;
  status: string;
}

export interface MessageItem {
  id: string;
  destination: string;
  channel: string | null;
  message: unknown;
  attempts: number;
  lastAttempt: string | null;
  nextRetry: string | null;
  createdAt: string;
  expiresAt: string | null;
  deliveredAt: string | null;
  failedReason: string | null;
  status: string;
}

export interface TaskRow {
  id: string;
  parent_id: string | null;
  type: string;
  description: string;
  input: string | null;
  output: string | null;
  status: string;
  assigned_to: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  priority: number;
  retries: number;
  max_retries: number;
  error: string | null;
}

export interface TaskItem {
  id: string;
  parentId: string | null;
  type: string;
  description: string;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  status: string;
  assignedTo: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  error: string | null;
}

export interface PeerRow {
  node_id: string;
  name: string | null;
  capabilities: string;
  channels: string;
  endpoint: string | null;
  public_key: string | null;
  first_seen: string;
  last_seen: string;
  status: string;
  latency: number | null;
  metadata: string;
}

export interface PeerItem {
  nodeId: string;
  name: string | null;
  capabilities: string[];
  channels: string[];
  endpoint: string | null;
  publicKey: string | null;
  firstSeen: string;
  lastSeen: string;
  status: string;
  latency: number | null;
  metadata: Record<string, unknown>;
}

export interface AuditEntry {
  id: number;
  timestamp: string;
  event: string;
  source: string | null;
  target: string | null;
  details: Record<string, unknown>;
  signature: string | null;
}

export interface AuditLogOptions {
  event?: string;
  source?: string;
  since?: string;
  limit?: number;
}

export interface MessageStats {
  pending: number;
  delivered: number;
  failed: number;
  expired: number;
}

export interface TaskStats {
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export interface TaskInsert {
  id: string;
  parentId?: string | null;
  type: string;
  description: string;
  input?: Record<string, unknown>;
  status?: string;
  assignedTo?: string | null;
  createdAt?: string;
  priority?: number;
  maxRetries?: number;
}

export interface TaskUpdateExtra {
  output?: Record<string, unknown>;
  error?: string;
  assignedTo?: string;
}

export interface PeerInsert {
  nodeId: string;
  name?: string | null;
  capabilities?: string[];
  channels?: string[];
  endpoint?: string | null;
  publicKey?: string | null;
  status?: string;
  latency?: number | null;
  metadata?: Record<string, unknown>;
}

export interface MessageInsert {
  id: string;
  destination: string;
  channel: string | null;
  message: unknown;
  attempts?: number;
  lastAttempt?: string | null;
  nextRetry?: string;
  createdAt: string;
  expiresAt: string;
}

// ─── Database Adapter Interface ──────────────────────────────────────────────

interface DbAdapter {
  exec(sql: string): void;
  run(sql: string, ...params: unknown[]): void;
  get(sql: string, ...params: unknown[]): Record<string, unknown> | null;
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

// ─── BetterSqliteAdapter ────────────────────────────────────────────────────

class BetterSqliteAdapter implements DbAdapter {
  private _db: {
    pragma(s: string): void;
    exec(sql: string): void;
    prepare(sql: string): {
      run(...params: unknown[]): void;
      get(...params: unknown[]): Record<string, unknown> | undefined;
      all(...params: unknown[]): Record<string, unknown>[];
    };
    close(): void;
  };

  constructor(dbPath: string) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
  }

  exec(sql: string): void { this._db.exec(sql); }

  run(sql: string, ...params: unknown[]): void { this._db.prepare(sql).run(...params); }

  get(sql: string, ...params: unknown[]): Record<string, unknown> | null {
    return this._db.prepare(sql).get(...params) as Record<string, unknown> || null;
  }

  all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    return this._db.prepare(sql).all(...params) as Record<string, unknown>[];
  }

  close(): void { this._db.close(); }
}

// ─── SqlJsAdapter ───────────────────────────────────────────────────────────

interface SqlJsStatement {
  bind(params: unknown[]): void;
  step(): boolean;
  getColumnNames(): string[];
  get(): unknown[];
  free(): void;
}

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): SqlJsStatement;
  export(): Uint8Array;
  close(): void;
}

class SqlJsAdapter implements DbAdapter {
  private _db: SqlJsDatabase;
  private _dbPath: string;

  constructor(db: SqlJsDatabase, dbPath: string) {
    this._db = db;
    this._dbPath = dbPath;
  }

  exec(sql: string): void { this._db.run(sql); }

  run(sql: string, ...params: unknown[]): void {
    this._db.run(sql, params);
    this._save();
  }

  get(sql: string, ...params: unknown[]): Record<string, unknown> | null {
    const stmt = this._db.prepare(sql);
    if (params.length) stmt.bind(params);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return row;
    }
    stmt.free();
    return null;
  }

  all(sql: string, ...params: unknown[]): Record<string, unknown>[] {
    const results: Record<string, unknown>[] = [];
    const stmt = this._db.prepare(sql);
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row: Record<string, unknown> = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      results.push(row);
    }
    stmt.free();
    return results;
  }

  private _save(): void {
    try {
      const data = this._db.export();
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._dbPath, Buffer.from(data));
    } catch (err) {
      const error = err as Error;
      console.error(`[storage] Erro ao salvar: ${error.message}`);
    }
  }

  close(): void { this._save(); this._db.close(); }
}

// ─── Storage ────────────────────────────────────────────────────────────────

export class Storage {
  private _dbPath: string;
  private _adapter: DbAdapter | null;
  private _engine: string;

  constructor(dbPath?: string) {
    this._dbPath = dbPath || DEFAULT_DB_PATH;
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    try {
      this._adapter = new BetterSqliteAdapter(this._dbPath);
      this._engine = 'better-sqlite3';
    } catch (_) {
      this._adapter = null;
      this._engine = 'pending';
    }
    if (this._adapter) this._initSchema();
  }

  static async create(dbPath?: string): Promise<Storage> {
    const storage = new Storage(dbPath);
    if (storage._adapter) return storage;
    // @ts-ignore TS7016 — sql.js lacks type declarations
    const initSqlJs = (await import('sql.js')).default;
    const SQL = await initSqlJs();
    const fullPath = dbPath || DEFAULT_DB_PATH;
    let db: SqlJsDatabase;
    try {
      if (fs.existsSync(fullPath)) {
        const data = fs.readFileSync(fullPath);
        db = new SQL.Database(data);
      } else {
        db = new SQL.Database();
      }
    } catch (_) {
      db = new SQL.Database();
    }
    storage._adapter = new SqlJsAdapter(db, fullPath);
    storage._engine = 'sql.js';
    storage._initSchema();
    console.log('[storage] Usando sql.js (puro JavaScript)');
    return storage;
  }

  private _initSchema(): void {
    for (const stmt of SCHEMA_STMTS) {
      this._adapter!.exec(stmt);
    }
  }

  insertMessage(item: MessageInsert): void {
    this._adapter!.run(
      `INSERT OR REPLACE INTO messages (id, destination, channel, message, attempts, last_attempt, next_retry, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      item.id, item.destination, item.channel, JSON.stringify(item.message),
      item.attempts || 0, item.lastAttempt, item.nextRetry, item.createdAt, item.expiresAt
    );
  }

  getPendingMessages(): MessageItem[] {
    return this._adapter!.all(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC`
    ).map(row => this._rowToMessage(row as unknown as MessageRow));
  }

  markDelivered(id: string): void {
    this._adapter!.run(`UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?`,
      new Date().toISOString(), id);
  }

  markFailed(id: string, reason: string): void {
    this._adapter!.run(`UPDATE messages SET status = 'failed', failed_reason = ? WHERE id = ?`,
      reason, id);
  }

  markExpired(id: string): void {
    this._adapter!.run(`UPDATE messages SET status = 'expired', failed_reason = 'expired' WHERE id = ?`, id);
  }

  updateMessageRetry(id: string, attempts: number, nextRetry: string): void {
    this._adapter!.run(`UPDATE messages SET attempts = ?, last_attempt = ?, next_retry = ? WHERE id = ?`,
      attempts, new Date().toISOString(), nextRetry, id);
  }

  getMessageStats(): MessageStats {
    return this._adapter!.get(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='expired' THEN 1 END) as expired
      FROM messages
    `) as unknown as MessageStats || { pending: 0, delivered: 0, failed: 0, expired: 0 };
  }

  getRecentMessages(status: string, limit: number = 20): MessageItem[] {
    return this._adapter!.all(
      `SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit
    ).map(row => this._rowToMessage(row as unknown as MessageRow));
  }

  searchMessages(query: string, limit: number = 50): MessageItem[] {
    return this._adapter!.all(
      `SELECT * FROM messages WHERE destination LIKE ? OR message LIKE ? ORDER BY created_at DESC LIMIT ?`,
      `%${query}%`, `%${query}%`, limit
    ).map(row => this._rowToMessage(row as unknown as MessageRow));
  }

  private _rowToMessage(row: MessageRow): MessageItem {
    return {
      id: row.id, destination: row.destination, channel: row.channel,
      message: JSON.parse(row.message), attempts: row.attempts,
      lastAttempt: row.last_attempt, nextRetry: row.next_retry,
      createdAt: row.created_at, expiresAt: row.expires_at,
      deliveredAt: row.delivered_at, failedReason: row.failed_reason, status: row.status,
    };
  }

  insertTask(task: TaskInsert): void {
    this._adapter!.run(
      `INSERT OR REPLACE INTO tasks (id, parent_id, type, description, input, output, status, assigned_to, created_at, priority, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.parentId || null, task.type, task.description,
      JSON.stringify(task.input || {}), null, task.status || 'pending',
      task.assignedTo || null, task.createdAt || new Date().toISOString(),
      task.priority || 5, task.maxRetries || 3
    );
  }

  getTask(id: string): TaskItem | null {
    const row = this._adapter!.get('SELECT * FROM tasks WHERE id = ?', id);
    return row ? this._rowToTask(row as unknown as TaskRow) : null;
  }

  getTasksByStatus(status: string): TaskItem[] {
    return this._adapter!.all('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC', status)
      .map(row => this._rowToTask(row as unknown as TaskRow));
  }

  getSubtasks(parentId: string): TaskItem[] {
    return this._adapter!.all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority ASC', parentId)
      .map(row => this._rowToTask(row as unknown as TaskRow));
  }

  updateTaskStatus(id: string, status: string, extra: TaskUpdateExtra = {}): void {
    const sets: string[] = ['status = ?'];
    const vals: unknown[] = [status];
    if (status === 'running') { sets.push('started_at = ?'); vals.push(new Date().toISOString()); }
    if (status === 'completed') { sets.push('completed_at = ?'); vals.push(new Date().toISOString()); }
    if (extra.output) { sets.push('output = ?'); vals.push(JSON.stringify(extra.output)); }
    if (extra.error) { sets.push('error = ?'); vals.push(extra.error); }
    if (extra.assignedTo) { sets.push('assigned_to = ?'); vals.push(extra.assignedTo); }
    vals.push(id);
    this._adapter!.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  }

  getTaskStats(): TaskStats {
    return this._adapter!.get(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='running' THEN 1 END) as running,
        COUNT(CASE WHEN status='completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled
      FROM tasks
    `) as unknown as TaskStats || { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  }

  private _rowToTask(row: TaskRow): TaskItem {
    return {
      id: row.id, parentId: row.parent_id, type: row.type, description: row.description,
      input: row.input ? JSON.parse(row.input) : {}, output: row.output ? JSON.parse(row.output) : null,
      status: row.status, assignedTo: row.assigned_to, createdAt: row.created_at,
      startedAt: row.started_at, completedAt: row.completed_at, priority: row.priority,
      retries: row.retries, maxRetries: row.max_retries, error: row.error,
    };
  }

  upsertPeer(peer: PeerInsert): void {
    const existing = this._adapter!.get('SELECT first_seen FROM peers WHERE node_id = ?', peer.nodeId) as { first_seen?: string } | null;
    const firstSeen = existing?.first_seen || new Date().toISOString();
    this._adapter!.run(
      `INSERT OR REPLACE INTO peers (node_id, name, capabilities, channels, endpoint, public_key, first_seen, last_seen, status, latency, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      peer.nodeId, peer.name, JSON.stringify(peer.capabilities || []),
      JSON.stringify(peer.channels || []), peer.endpoint || null, peer.publicKey || null,
      firstSeen, new Date().toISOString(), peer.status || 'online',
      peer.latency || null, JSON.stringify(peer.metadata || {})
    );
  }

  getPeer(nodeId: string): PeerItem | null {
    const row = this._adapter!.get('SELECT * FROM peers WHERE node_id = ?', nodeId);
    return row ? this._rowToPeer(row as unknown as PeerRow) : null;
  }

  getAllPeers(): PeerItem[] {
    return this._adapter!.all('SELECT * FROM peers ORDER BY last_seen DESC').map(row => this._rowToPeer(row as unknown as PeerRow));
  }

  removePeer(nodeId: string): void { this._adapter!.run('DELETE FROM peers WHERE node_id = ?', nodeId); }

  private _rowToPeer(row: PeerRow): PeerItem {
    return {
      nodeId: row.node_id, name: row.name,
      capabilities: JSON.parse(row.capabilities || '[]'),
      channels: JSON.parse(row.channels || '[]'),
      endpoint: row.endpoint, publicKey: row.public_key,
      firstSeen: row.first_seen, lastSeen: row.last_seen,
      status: row.status, latency: row.latency,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  log(event: string, source?: string | null, target?: string | null, details?: Record<string, unknown> | null, signature?: string | null): void {
    if (!this._adapter) return;
    this._adapter.run(
      `INSERT INTO audit_log (timestamp, event, source, target, details, signature) VALUES (?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(), event, source || null, target || null,
      JSON.stringify(details || {}), signature || null
    );
  }

  getAuditLog(options: AuditLogOptions = {}): AuditEntry[] {
    let sql = 'SELECT * FROM audit_log';
    const conditions: string[] = [];
    const vals: unknown[] = [];
    if (options.event) { conditions.push('event = ?'); vals.push(options.event); }
    if (options.source) { conditions.push('source = ?'); vals.push(options.source); }
    if (options.since) { conditions.push('timestamp >= ?'); vals.push(options.since); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    vals.push(options.limit || 100);
    return this._adapter!.all(sql, ...vals).map(row => {
      const r = row as Record<string, unknown>;
      return {
        id: r.id as number,
        timestamp: r.timestamp as string,
        event: r.event as string,
        source: r.source as string | null,
        target: r.target as string | null,
        details: JSON.parse((r.details as string) || '{}'),
        signature: r.signature as string | null,
      };
    });
  }

  close(): void { this._adapter!.close(); }

  get stats(): { messages: MessageStats; tasks: TaskStats; peers: number; auditEntries: number } {
    return {
      messages: this.getMessageStats(),
      tasks: this.getTaskStats(),
      peers: this.getAllPeers().length,
      auditEntries: ((this._adapter!.get('SELECT COUNT(*) as c FROM audit_log') as { c: number } | null) || { c: 0 }).c,
    };
  }
}

export default Storage;
