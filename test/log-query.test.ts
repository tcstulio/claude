// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { describe, it, beforeEach, expect } from 'vitest';
import { LogQueryService } from '../lib-ts/mesh/log-query-service.js';
import { FederatedLogQuery } from '../lib-ts/mesh/federated-log-query.js';
import type { LogQuery, LogEntry } from '../lib-ts/mesh/log-query.js';

// ─── Mock Storage ──────────────────────────────────────────────────────────

function createMockStorage(rows: any[] = []) {
  return {
    queryLogs(options: any) {
      let result = [...rows];
      if (options.since) result = result.filter((r: any) => r.timestamp >= options.since);
      if (options.until) result = result.filter((r: any) => r.timestamp <= options.until);
      if (options.events?.length) result = result.filter((r: any) => options.events.includes(r.event));
      if (options.source) result = result.filter((r: any) => r.source === options.source);
      if (options.search) result = result.filter((r: any) =>
        JSON.stringify(r.details).includes(options.search));
      const limit = options.limit || 100;
      const offset = options.offset || 0;
      return result.slice(offset, offset + limit);
    },
  };
}

function sampleRows() {
  return [
    { id: 1, timestamp: '2026-04-01T10:00:00.000Z', event: 'task.created', source: 'node-a', target: null, details: { taskId: 't1' }, signature: null },
    { id: 2, timestamp: '2026-04-01T11:00:00.000Z', event: 'task.completed', source: 'node-a', target: null, details: { taskId: 't1' }, signature: null },
    { id: 3, timestamp: '2026-04-01T12:00:00.000Z', event: 'deploy.started', source: 'node-b', target: null, details: { service: 'gateway' }, signature: null },
    { id: 4, timestamp: '2026-04-02T08:00:00.000Z', event: 'task.created', source: 'node-a', target: null, details: { taskId: 't2' }, signature: null },
  ];
}

// ─── Mock Registry ─────────────────────────────────────────────────────────

function createMockRegistry(peers: any[] = []) {
  return {
    online: () => peers.filter(p => p.status === 'online'),
  };
}

// ─── Mock Fetch ────────────────────────────────────────────────────────────

function createMockFetch(responses: Record<string, any> = {}) {
  return async (url: string, _options: any = {}) => {
    for (const [pattern, handler] of Object.entries(responses)) {
      if (url.includes(pattern)) {
        const result = typeof handler === 'function' ? handler(url, _options) : handler;
        return { ok: true, status: 200, json: async () => result };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}

// ─── LogQueryService Tests ──────────────────────────────────────────────────

describe('LogQueryService', () => {
  let service: LogQueryService;

  beforeEach(() => {
    service = new LogQueryService({
      storage: createMockStorage(sampleRows()) as any,
      nodeId: 'test-node',
      nodeName: 'Test Node',
    });
  });

  it('retorna logs sem filtros', () => {
    const result = service.query({});
    expect(result.length).toBe(4);
    expect(result[0].nodeId).toBe('test-node');
    expect(result[0].nodeName).toBe('Test Node');
    expect(result[0].logType).toBe('audit');
  });

  it('filtra por since', () => {
    const result = service.query({ since: '2026-04-02T00:00:00.000Z' });
    expect(result.length).toBe(1);
    expect(result[0].event).toBe('task.created');
    expect(result[0].id).toBe(4);
  });

  it('filtra por until', () => {
    const result = service.query({ until: '2026-04-01T10:30:00.000Z' });
    expect(result.length).toBe(1);
    expect(result[0].event).toBe('task.created');
  });

  it('filtra por events', () => {
    const result = service.query({ events: ['task.created'] });
    expect(result.length).toBe(2);
    result.forEach((e: LogEntry) => expect(e.event).toBe('task.created'));
  });

  it('filtra por source', () => {
    const result = service.query({ source: 'node-b' });
    expect(result.length).toBe(1);
    expect(result[0].event).toBe('deploy.started');
  });

  it('filtra por search', () => {
    const result = service.query({ search: 'gateway' });
    expect(result.length).toBe(1);
    expect(result[0].details.service).toBe('gateway');
  });

  it('respeita limit', () => {
    const result = service.query({ limit: 2 });
    expect(result.length).toBe(2);
  });

  it('ordena por timestamp DESC', () => {
    const result = service.query({});
    for (let i = 1; i < result.length; i++) {
      expect(result[i - 1].timestamp >= result[i].timestamp).toBe(true);
    }
  });

  it('limit máximo é 500', () => {
    const manyRows = Array.from({ length: 600 }, (_, i) => ({
      id: i, timestamp: `2026-04-01T${String(i % 24).padStart(2, '0')}:00:00.000Z`,
      event: 'test', source: null, target: null, details: {}, signature: null,
    }));
    const svc = new LogQueryService({
      storage: createMockStorage(manyRows) as any,
      nodeId: 'n', nodeName: 'N',
    });
    const result = svc.query({ limit: 1000 });
    expect(result.length).toBeLessThanOrEqual(500);
  });
});

// ─── FederatedLogQuery Tests ────────────────────────────────────────────────

describe('FederatedLogQuery', () => {
  let localService: LogQueryService;

  beforeEach(() => {
    localService = new LogQueryService({
      storage: createMockStorage(sampleRows()) as any,
      nodeId: 'hub-node',
      nodeName: 'Hub',
    });
  });

  it('retorna resultados locais sem peers', async () => {
    const registry = createMockRegistry([]);
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry,
      maxHops: 0,
    });

    const result = await fed.query({});
    expect(result.entries.length).toBe(4);
    expect(result.metadata.nodesQueried).toBe(1);
    expect(result.metadata.nodesResponded).toBe(1);
    expect(result.queryId).toBeTruthy();
  });

  it('gera queryId automaticamente', async () => {
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry([]),
      maxHops: 0,
    });

    const result = await fed.query({});
    expect(result.queryId).toMatch(/^lq_/);
  });

  it('respeita queryId fornecido', async () => {
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry([]),
      maxHops: 0,
    });

    const result = await fed.query({ queryId: 'lq_custom_123' });
    expect(result.queryId).toBe('lq_custom_123');
  });

  it('dedup por queryId', async () => {
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry([]),
      maxHops: 0,
    });

    const r1 = await fed.query({ queryId: 'lq_dup_test' });
    const r2 = await fed.query({ queryId: 'lq_dup_test' });
    expect(r1.entries.length).toBe(4);
    expect(r2.entries.length).toBe(0); // duplicado
  });

  it('propaga para peers remotos', async () => {
    const remotePeers = [
      { nodeId: 'peer-1', name: 'Peer 1', endpoint: 'http://peer1:3000', status: 'online' },
      { nodeId: 'peer-2', name: 'Peer 2', endpoint: 'http://peer2:3000', status: 'online' },
    ];

    const remoteEntries: LogEntry[] = [
      {
        id: 10, timestamp: '2026-04-01T15:00:00.000Z', event: 'task.remote',
        source: null, target: null, details: {}, nodeId: 'peer-1', nodeName: 'Peer 1', logType: 'audit',
      },
    ];

    const mockFetch = createMockFetch({
      '/api/logs/query': { entries: remoteEntries },
    });

    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry(remotePeers),
      fetch: mockFetch as any,
      maxHops: 1,
    });

    const result = await fed.query({});
    expect(result.entries.length).toBe(5); // 4 local + 1 remote (deduped from 2 peers returning same)
    expect(result.metadata.nodesQueried).toBe(3); // 1 local + 2 peers
  });

  it('registra nodesFailed quando peer não responde', async () => {
    const peers = [
      { nodeId: 'bad-peer', name: 'Bad', endpoint: 'http://unreachable:3000', status: 'online' },
    ];

    const failFetch = async () => { throw new Error('connection refused'); };

    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry(peers),
      fetch: failFetch as any,
      maxHops: 1,
    });

    const result = await fed.query({});
    expect(result.metadata.nodesFailed).toContain('bad-peer');
    expect(result.entries.length).toBe(4); // only local
  });

  it('filtra por targetNodes', async () => {
    const peers = [
      { nodeId: 'peer-1', name: 'P1', endpoint: 'http://p1:3000', status: 'online' },
      { nodeId: 'peer-2', name: 'P2', endpoint: 'http://p2:3000', status: 'online' },
    ];

    const calls: string[] = [];
    const mockFetch = async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ entries: [] }) };
    };

    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry(peers),
      fetch: mockFetch as any,
      maxHops: 1,
    });

    await fed.query({ targetNodes: ['peer-1'] });
    expect(calls.length).toBe(1);
    expect(calls[0]).toContain('p1:3000');
  });

  it('rate limit bloqueia após exceder', async () => {
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry([]),
      maxHops: 0,
      rateLimit: { maxQueries: 2, windowMs: 60000 },
    });

    const r1 = await fed.query({ queryId: 'q1' });
    const r2 = await fed.query({ queryId: 'q2' });
    const r3 = await fed.query({ queryId: 'q3' });

    expect(r1.entries.length).toBe(4);
    expect(r2.entries.length).toBe(4);
    expect(r3.entries.length).toBe(0); // rate limited
  });

  it('merge deduplica entries por nodeId+logType+id', async () => {
    const duplicateEntries: LogEntry[] = [
      {
        id: 1, timestamp: '2026-04-01T10:00:00.000Z', event: 'task.created',
        source: 'node-a', target: null, details: { taskId: 't1' },
        nodeId: 'hub-node', nodeName: 'Hub', logType: 'audit',
      },
    ];

    const mockFetch = createMockFetch({
      '/api/logs/query': { entries: duplicateEntries },
    });

    const peers = [
      { nodeId: 'peer-1', name: 'P1', endpoint: 'http://p1:3000', status: 'online' },
    ];

    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry(peers),
      fetch: mockFetch as any,
      maxHops: 1,
    });

    const result = await fed.query({});
    // Should be 4 (local unique) — the duplicate from remote is deduped
    expect(result.entries.length).toBe(4);
  });

  it('inclui timing por nó no metadata', async () => {
    const fed = new FederatedLogQuery({
      localService,
      nodeId: 'hub-node',
      registry: createMockRegistry([]),
      maxHops: 0,
    });

    const result = await fed.query({});
    expect(result.metadata.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.metadata.timing.perNode['hub-node']).toBeGreaterThanOrEqual(0);
  });
});
