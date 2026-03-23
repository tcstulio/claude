'use strict';

const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = process.env.TULIPA_DB_PATH || './data/tulipa.db';

const SCHEMA_STMTS = [
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

// ─── better-sqlite3 adapter (sync, nativo, rápido) ──────────────────
class BetterSqliteAdapter {
  constructor(dbPath) {
    const Database = require('better-sqlite3');
    this._db = new Database(dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
  }
  exec(sql) { this._db.exec(sql); }
  run(sql, ...params) { this._db.prepare(sql).run(...params); }
  get(sql, ...params) { return this._db.prepare(sql).get(...params) || null; }
  all(sql, ...params) { return this._db.prepare(sql).all(...params); }
  close() { this._db.close(); }
}

// ─── sql.js adapter (puro JS, funciona em Termux) ────────────────────
class SqlJsAdapter {
  constructor(db, dbPath) {
    this._db = db;
    this._dbPath = dbPath;
  }
  exec(sql) { this._db.run(sql); }
  run(sql, ...params) {
    this._db.run(sql, params);
    this._save();
  }
  get(sql, ...params) {
    const stmt = this._db.prepare(sql);
    if (params.length) stmt.bind(params);
    if (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      stmt.free();
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      return row;
    }
    stmt.free();
    return null;
  }
  all(sql, ...params) {
    const results = [];
    const stmt = this._db.prepare(sql);
    if (params.length) stmt.bind(params);
    while (stmt.step()) {
      const cols = stmt.getColumnNames();
      const vals = stmt.get();
      const row = {};
      cols.forEach((c, i) => { row[c] = vals[i]; });
      results.push(row);
    }
    stmt.free();
    return results;
  }
  _save() {
    try {
      const data = this._db.export();
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._dbPath, Buffer.from(data));
    } catch (err) {
      console.error(`[storage] Erro ao salvar: ${err.message}`);
    }
  }
  close() { this._save(); this._db.close(); }
}

class Storage {
  /**
   * Construtor síncrono — funciona se better-sqlite3 estiver disponível.
   * Para sql.js, use Storage.create(dbPath) (async).
   */
  constructor(dbPath) {
    this._dbPath = dbPath || DEFAULT_DB_PATH;
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // Tenta better-sqlite3 (sync)
    try {
      this._adapter = new BetterSqliteAdapter(this._dbPath);
      this._engine = 'better-sqlite3';
    } catch (_) {
      // Se não tem better-sqlite3, marca como não-pronto
      this._adapter = null;
      this._engine = 'pending';
    }

    if (this._adapter) this._initSchema();
  }

  /**
   * Factory async — usa sql.js se better-sqlite3 não estiver disponível.
   */
  static async create(dbPath) {
    const storage = new Storage(dbPath);
    if (storage._adapter) return storage; // better-sqlite3 já funcionou

    // Fallback: sql.js
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs();
    const fullPath = dbPath || DEFAULT_DB_PATH;

    let db;
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

  _initSchema() {
    for (const stmt of SCHEMA_STMTS) {
      this._adapter.exec(stmt);
    }
  }

  // ─── Messages (Queue) ──────────────────────────────────────────────

  insertMessage(item) {
    this._adapter.run(
      `INSERT OR REPLACE INTO messages (id, destination, channel, message, attempts, last_attempt, next_retry, created_at, expires_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      item.id, item.destination, item.channel, JSON.stringify(item.message),
      item.attempts || 0, item.lastAttempt, item.nextRetry, item.createdAt, item.expiresAt
    );
  }

  getPendingMessages() {
    return this._adapter.all(
      `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC`
    ).map(row => this._rowToMessage(row));
  }

  markDelivered(id) {
    this._adapter.run(`UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?`,
      new Date().toISOString(), id);
  }

  markFailed(id, reason) {
    this._adapter.run(`UPDATE messages SET status = 'failed', failed_reason = ? WHERE id = ?`,
      reason, id);
  }

  markExpired(id) {
    this._adapter.run(`UPDATE messages SET status = 'expired', failed_reason = 'expired' WHERE id = ?`, id);
  }

  updateMessageRetry(id, attempts, nextRetry) {
    this._adapter.run(`UPDATE messages SET attempts = ?, last_attempt = ?, next_retry = ? WHERE id = ?`,
      attempts, new Date().toISOString(), nextRetry, id);
  }

  getMessageStats() {
    return this._adapter.get(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='expired' THEN 1 END) as expired
      FROM messages
    `) || { pending: 0, delivered: 0, failed: 0, expired: 0 };
  }

  getRecentMessages(status, limit = 20) {
    return this._adapter.all(
      `SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?`, status, limit
    ).map(row => this._rowToMessage(row));
  }

  searchMessages(query, limit = 50) {
    return this._adapter.all(
      `SELECT * FROM messages WHERE destination LIKE ? OR message LIKE ? ORDER BY created_at DESC LIMIT ?`,
      `%${query}%`, `%${query}%`, limit
    ).map(row => this._rowToMessage(row));
  }

  _rowToMessage(row) {
    return {
      id: row.id, destination: row.destination, channel: row.channel,
      message: JSON.parse(row.message), attempts: row.attempts,
      lastAttempt: row.last_attempt, nextRetry: row.next_retry,
      createdAt: row.created_at, expiresAt: row.expires_at,
      deliveredAt: row.delivered_at, failedReason: row.failed_reason, status: row.status,
    };
  }

  // ─── Tasks ─────────────────────────────────────────────────────────

  insertTask(task) {
    this._adapter.run(
      `INSERT OR REPLACE INTO tasks (id, parent_id, type, description, input, output, status, assigned_to, created_at, priority, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      task.id, task.parentId || null, task.type, task.description,
      JSON.stringify(task.input || {}), null, task.status || 'pending',
      task.assignedTo || null, task.createdAt || new Date().toISOString(),
      task.priority || 5, task.maxRetries || 3
    );
  }

  getTask(id) {
    const row = this._adapter.get('SELECT * FROM tasks WHERE id = ?', id);
    return row ? this._rowToTask(row) : null;
  }

  getTasksByStatus(status) {
    return this._adapter.all('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC', status)
      .map(row => this._rowToTask(row));
  }

  getSubtasks(parentId) {
    return this._adapter.all('SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority ASC', parentId)
      .map(row => this._rowToTask(row));
  }

  updateTaskStatus(id, status, extra = {}) {
    const sets = ['status = ?'];
    const vals = [status];
    if (status === 'running') { sets.push('started_at = ?'); vals.push(new Date().toISOString()); }
    if (status === 'completed') { sets.push('completed_at = ?'); vals.push(new Date().toISOString()); }
    if (extra.output) { sets.push('output = ?'); vals.push(JSON.stringify(extra.output)); }
    if (extra.error) { sets.push('error = ?'); vals.push(extra.error); }
    if (extra.assignedTo) { sets.push('assigned_to = ?'); vals.push(extra.assignedTo); }
    vals.push(id);
    this._adapter.run(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`, ...vals);
  }

  getTaskStats() {
    return this._adapter.get(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='running' THEN 1 END) as running,
        COUNT(CASE WHEN status='completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled
      FROM tasks
    `) || { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  }

  _rowToTask(row) {
    return {
      id: row.id, parentId: row.parent_id, type: row.type, description: row.description,
      input: row.input ? JSON.parse(row.input) : {}, output: row.output ? JSON.parse(row.output) : null,
      status: row.status, assignedTo: row.assigned_to, createdAt: row.created_at,
      startedAt: row.started_at, completedAt: row.completed_at, priority: row.priority,
      retries: row.retries, maxRetries: row.max_retries, error: row.error,
    };
  }

  // ─── Peers ─────────────────────────────────────────────────────────

  upsertPeer(peer) {
    const existing = this._adapter.get('SELECT first_seen FROM peers WHERE node_id = ?', peer.nodeId);
    const firstSeen = existing?.first_seen || new Date().toISOString();
    this._adapter.run(
      `INSERT OR REPLACE INTO peers (node_id, name, capabilities, channels, endpoint, public_key, first_seen, last_seen, status, latency, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      peer.nodeId, peer.name, JSON.stringify(peer.capabilities || []),
      JSON.stringify(peer.channels || []), peer.endpoint || null, peer.publicKey || null,
      firstSeen, new Date().toISOString(), peer.status || 'online',
      peer.latency || null, JSON.stringify(peer.metadata || {})
    );
  }

  getPeer(nodeId) {
    const row = this._adapter.get('SELECT * FROM peers WHERE node_id = ?', nodeId);
    return row ? this._rowToPeer(row) : null;
  }

  getAllPeers() {
    return this._adapter.all('SELECT * FROM peers ORDER BY last_seen DESC').map(row => this._rowToPeer(row));
  }

  removePeer(nodeId) { this._adapter.run('DELETE FROM peers WHERE node_id = ?', nodeId); }

  _rowToPeer(row) {
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

  // ─── Audit Log ─────────────────────────────────────────────────────

  log(event, source, target, details, signature) {
    if (!this._adapter) return; // guard contra inicialização pendente
    this._adapter.run(
      `INSERT INTO audit_log (timestamp, event, source, target, details, signature) VALUES (?, ?, ?, ?, ?, ?)`,
      new Date().toISOString(), event, source || null, target || null,
      JSON.stringify(details || {}), signature || null
    );
  }

  getAuditLog(options = {}) {
    let sql = 'SELECT * FROM audit_log';
    const conditions = [];
    const vals = [];
    if (options.event) { conditions.push('event = ?'); vals.push(options.event); }
    if (options.source) { conditions.push('source = ?'); vals.push(options.source); }
    if (options.since) { conditions.push('timestamp >= ?'); vals.push(options.since); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY timestamp DESC LIMIT ?';
    vals.push(options.limit || 100);
    return this._adapter.all(sql, ...vals).map(row => ({
      id: row.id, timestamp: row.timestamp, event: row.event,
      source: row.source, target: row.target,
      details: JSON.parse(row.details || '{}'), signature: row.signature,
    }));
  }

  // ─── Utils ─────────────────────────────────────────────────────────

  close() { this._adapter.close(); }

  get stats() {
    return {
      messages: this.getMessageStats(),
      tasks: this.getTaskStats(),
      peers: this.getAllPeers().length,
      auditEntries: (this._adapter.get('SELECT COUNT(*) as c FROM audit_log') || { c: 0 }).c,
    };
  }
}

module.exports = Storage;
