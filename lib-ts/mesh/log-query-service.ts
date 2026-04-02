// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LogQuery, LogEntry } from './log-query.js';

const MAX_FILE_LINES = 200;
const LOG_DIR = path.join(os.homedir(), '.tulipa', 'logs');

// Regex to extract [component] from log lines
const COMPONENT_RE = /\[([^\]]+)\]/;
// Regex to extract ISO-like timestamps from log lines
const TIMESTAMP_RE = /(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[\w.:+-]*)/;

interface StorageLike {
  queryLogs(options: {
    since?: string; until?: string; events?: string[];
    source?: string; component?: string; search?: string;
    limit?: number; offset?: number;
  }): Array<{
    id: number; timestamp: string; event: string;
    source: string | null; target: string | null;
    details: Record<string, unknown>; signature: string | null;
  }>;
}

export class LogQueryService {
  private _storage: StorageLike;
  private _nodeId: string;
  private _nodeName: string;

  constructor(options: { storage: StorageLike; nodeId: string; nodeName: string }) {
    this._storage = options.storage;
    this._nodeId = options.nodeId;
    this._nodeName = options.nodeName;
  }

  query(q: LogQuery): LogEntry[] {
    const limit = Math.min(q.limit || 100, 500);
    const entries: LogEntry[] = [];

    // 1. Query SQLite audit_log
    const auditRows = this._storage.queryLogs({
      since: q.since,
      until: q.until,
      events: q.events,
      source: q.source,
      component: q.component,
      search: q.search,
      limit,
      offset: q.offset,
    });

    for (const row of auditRows) {
      entries.push({
        id: row.id,
        timestamp: row.timestamp,
        event: row.event,
        source: row.source,
        target: row.target,
        details: row.details,
        nodeId: this._nodeId,
        nodeName: this._nodeName,
        logType: 'audit',
      });
    }

    // 2. Optionally read file logs
    if (q.includeFileLog) {
      const fileEntries = this._readFileLogs(q, limit - entries.length);
      entries.push(...fileEntries);
    }

    // Sort by timestamp descending
    entries.sort((a, b) => b.timestamp.localeCompare(a.timestamp));

    return entries.slice(0, limit);
  }

  private _readFileLogs(q: LogQuery, maxEntries: number): LogEntry[] {
    if (maxEntries <= 0) return [];

    let logDir = LOG_DIR;
    if (!fs.existsSync(logDir)) {
      // Fallback to ./logs if ~/.tulipa/logs doesn't exist
      logDir = path.resolve('logs');
      if (!fs.existsSync(logDir)) return [];
    }

    const entries: LogEntry[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(logDir).filter(f => f.endsWith('.log'));
    } catch {
      return [];
    }

    for (const file of files) {
      if (entries.length >= maxEntries) break;
      const filePath = path.join(logDir, file);
      const lines = this._tailFile(filePath, MAX_FILE_LINES);
      const serviceName = file.replace('.log', '');

      for (const line of lines) {
        if (entries.length >= maxEntries) break;
        const entry = this._parseLogLine(line, serviceName);
        if (!entry) continue;
        if (!this._matchesFilter(entry, q)) continue;
        entries.push(entry);
      }
    }

    return entries;
  }

  private _tailFile(filePath: string, maxLines: number): string[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      return lines.slice(-maxLines);
    } catch {
      return [];
    }
  }

  private _parseLogLine(line: string, serviceName: string): LogEntry | null {
    const tsMatch = line.match(TIMESTAMP_RE);
    const compMatch = line.match(COMPONENT_RE);
    const timestamp = tsMatch ? tsMatch[1] : new Date().toISOString();

    return {
      id: `file-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      timestamp,
      event: `file.${serviceName}`,
      source: compMatch ? compMatch[1] : serviceName,
      target: null,
      details: { line, service: serviceName, component: compMatch?.[1] || null },
      nodeId: this._nodeId,
      nodeName: this._nodeName,
      logType: 'file',
    };
  }

  private _matchesFilter(entry: LogEntry, q: LogQuery): boolean {
    if (q.since && entry.timestamp < q.since) return false;
    if (q.until && entry.timestamp > q.until) return false;
    if (q.component) {
      const comp = (entry.details.component as string) || '';
      if (!comp.toLowerCase().includes(q.component.toLowerCase())) return false;
    }
    if (q.search) {
      const line = (entry.details.line as string) || '';
      if (!line.toLowerCase().includes(q.search.toLowerCase())) return false;
    }
    return true;
  }
}
