'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = process.env.TULIPA_DB_PATH || './data/tulipa.db';

class Storage {
  constructor(dbPath) {
    this._dbPath = dbPath || DEFAULT_DB_PATH;
    const dir = path.dirname(this._dbPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    this._db = new Database(this._dbPath);
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
    this._init();
  }

  _init() {
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        destination TEXT,
        channel TEXT,
        message TEXT NOT NULL,
        attempts INTEGER DEFAULT 0,
        last_attempt TEXT,
        next_retry TEXT,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        delivered_at TEXT,
        failed_reason TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','delivered','failed','expired'))
      );

      CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status);
      CREATE INDEX IF NOT EXISTS idx_messages_destination ON messages(destination);

      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        parent_id TEXT,
        type TEXT NOT NULL,
        description TEXT NOT NULL,
        input TEXT,
        output TEXT,
        status TEXT DEFAULT 'pending' CHECK(status IN ('pending','running','completed','failed','cancelled')),
        assigned_to TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        priority INTEGER DEFAULT 5,
        retries INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 3,
        error TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

      CREATE TABLE IF NOT EXISTS peers (
        node_id TEXT PRIMARY KEY,
        name TEXT,
        capabilities TEXT,
        channels TEXT,
        endpoint TEXT,
        public_key TEXT,
        first_seen TEXT,
        last_seen TEXT,
        status TEXT DEFAULT 'online',
        latency INTEGER,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        event TEXT NOT NULL,
        source TEXT,
        target TEXT,
        details TEXT,
        signature TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_log(event);
    `);
  }

  // ─── Messages (Queue) ──────────────────────────────────────────────

  insertMessage(item) {
    const stmt = this._db.prepare(`
      INSERT OR REPLACE INTO messages (id, destination, channel, message, attempts, last_attempt, next_retry, created_at, expires_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
    `);
    stmt.run(item.id, item.destination, item.channel, JSON.stringify(item.message),
      item.attempts || 0, item.lastAttempt, item.nextRetry, item.createdAt, item.expiresAt);
  }

  getPendingMessages() {
    return this._db.prepare(`
      SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC
    `).all().map(row => this._rowToMessage(row));
  }

  markDelivered(id) {
    this._db.prepare(`
      UPDATE messages SET status = 'delivered', delivered_at = ? WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  markFailed(id, reason) {
    this._db.prepare(`
      UPDATE messages SET status = 'failed', failed_reason = ? WHERE id = ?
    `).run(reason, id);
  }

  markExpired(id) {
    this._db.prepare(`
      UPDATE messages SET status = 'expired', failed_reason = 'expired' WHERE id = ?
    `).run(id);
  }

  updateMessageRetry(id, attempts, nextRetry) {
    this._db.prepare(`
      UPDATE messages SET attempts = ?, last_attempt = ?, next_retry = ? WHERE id = ?
    `).run(attempts, new Date().toISOString(), nextRetry, id);
  }

  getMessageStats() {
    const row = this._db.prepare(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='delivered' THEN 1 END) as delivered,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='expired' THEN 1 END) as expired
      FROM messages
    `).get();
    return row;
  }

  getRecentMessages(status, limit = 20) {
    return this._db.prepare(`
      SELECT * FROM messages WHERE status = ? ORDER BY created_at DESC LIMIT ?
    `).all(status, limit).map(row => this._rowToMessage(row));
  }

  searchMessages(query, limit = 50) {
    return this._db.prepare(`
      SELECT * FROM messages WHERE destination LIKE ? OR message LIKE ? ORDER BY created_at DESC LIMIT ?
    `).all(`%${query}%`, `%${query}%`, limit).map(row => this._rowToMessage(row));
  }

  _rowToMessage(row) {
    return {
      id: row.id,
      destination: row.destination,
      channel: row.channel,
      message: JSON.parse(row.message),
      attempts: row.attempts,
      lastAttempt: row.last_attempt,
      nextRetry: row.next_retry,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      deliveredAt: row.delivered_at,
      failedReason: row.failed_reason,
      status: row.status,
    };
  }

  // ─── Tasks ─────────────────────────────────────────────────────────

  insertTask(task) {
    const stmt = this._db.prepare(`
      INSERT OR REPLACE INTO tasks (id, parent_id, type, description, input, output, status, assigned_to, created_at, priority, max_retries)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(task.id, task.parentId || null, task.type, task.description,
      JSON.stringify(task.input || {}), null, task.status || 'pending',
      task.assignedTo || null, task.createdAt || new Date().toISOString(),
      task.priority || 5, task.maxRetries || 3);
  }

  getTask(id) {
    const row = this._db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
    return row ? this._rowToTask(row) : null;
  }

  getTasksByStatus(status) {
    return this._db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC')
      .all(status).map(row => this._rowToTask(row));
  }

  getSubtasks(parentId) {
    return this._db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority ASC')
      .all(parentId).map(row => this._rowToTask(row));
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
    this._db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  getTaskStats() {
    return this._db.prepare(`
      SELECT
        COUNT(CASE WHEN status='pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status='running' THEN 1 END) as running,
        COUNT(CASE WHEN status='completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status='failed' THEN 1 END) as failed,
        COUNT(CASE WHEN status='cancelled' THEN 1 END) as cancelled
      FROM tasks
    `).get();
  }

  _rowToTask(row) {
    return {
      id: row.id,
      parentId: row.parent_id,
      type: row.type,
      description: row.description,
      input: row.input ? JSON.parse(row.input) : {},
      output: row.output ? JSON.parse(row.output) : null,
      status: row.status,
      assignedTo: row.assigned_to,
      createdAt: row.created_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      priority: row.priority,
      retries: row.retries,
      maxRetries: row.max_retries,
      error: row.error,
    };
  }

  // ─── Peers ─────────────────────────────────────────────────────────

  upsertPeer(peer) {
    this._db.prepare(`
      INSERT OR REPLACE INTO peers (node_id, name, capabilities, channels, endpoint, public_key, first_seen, last_seen, status, latency, metadata)
      VALUES (?, ?, ?, ?, ?, ?, COALESCE((SELECT first_seen FROM peers WHERE node_id = ?), ?), ?, ?, ?, ?)
    `).run(peer.nodeId, peer.name, JSON.stringify(peer.capabilities || []),
      JSON.stringify(peer.channels || []), peer.endpoint || null, peer.publicKey || null,
      peer.nodeId, new Date().toISOString(), new Date().toISOString(),
      peer.status || 'online', peer.latency || null, JSON.stringify(peer.metadata || {}));
  }

  getPeer(nodeId) {
    const row = this._db.prepare('SELECT * FROM peers WHERE node_id = ?').get(nodeId);
    return row ? this._rowToPeer(row) : null;
  }

  getAllPeers() {
    return this._db.prepare('SELECT * FROM peers ORDER BY last_seen DESC').all()
      .map(row => this._rowToPeer(row));
  }

  removePeer(nodeId) {
    this._db.prepare('DELETE FROM peers WHERE node_id = ?').run(nodeId);
  }

  _rowToPeer(row) {
    return {
      nodeId: row.node_id,
      name: row.name,
      capabilities: JSON.parse(row.capabilities || '[]'),
      channels: JSON.parse(row.channels || '[]'),
      endpoint: row.endpoint,
      publicKey: row.public_key,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      status: row.status,
      latency: row.latency,
      metadata: JSON.parse(row.metadata || '{}'),
    };
  }

  // ─── Audit Log ─────────────────────────────────────────────────────

  log(event, source, target, details, signature) {
    this._db.prepare(`
      INSERT INTO audit_log (timestamp, event, source, target, details, signature)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(new Date().toISOString(), event, source || null, target || null,
      JSON.stringify(details || {}), signature || null);
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

    return this._db.prepare(sql).all(...vals).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      event: row.event,
      source: row.source,
      target: row.target,
      details: JSON.parse(row.details || '{}'),
      signature: row.signature,
    }));
  }

  // ─── Utils ─────────────────────────────────────────────────────────

  close() {
    this._db.close();
  }

  get stats() {
    return {
      messages: this.getMessageStats(),
      tasks: this.getTaskStats(),
      peers: this.getAllPeers().length,
      auditEntries: this._db.prepare('SELECT COUNT(*) as c FROM audit_log').get().c,
    };
  }
}

module.exports = Storage;
