// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

// ─── Log Query Types ────────────────────────────────────────────────────────

export interface LogQuery {
  since?: string;
  until?: string;
  events?: string[];
  source?: string;
  component?: string;
  search?: string;
  limit?: number;
  offset?: number;
  // Federation control
  queryId?: string;
  hopsRemaining?: number;
  originNode?: string;
  includeFileLog?: boolean;
  targetNodes?: string[];
}

export interface LogEntry {
  id: number | string;
  timestamp: string;
  event: string;
  source: string | null;
  target: string | null;
  details: Record<string, unknown>;
  nodeId: string;
  nodeName: string;
  logType: 'audit' | 'file';
}

export interface LogQueryResult {
  queryId: string;
  entries: LogEntry[];
  metadata: {
    totalEntries: number;
    nodesQueried: number;
    nodesResponded: number;
    nodesFailed: string[];
    truncated: boolean;
    timing: { totalMs: number; perNode: Record<string, number> };
  };
}
