// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';
import { PeerRegistry } from './peer-registry.js';
import * as protocol from '../protocol.js';
import * as receipt from '../ledger/receipt.js';
import { TrustGraph } from './trust.js';
import { NetworkCrawler } from './crawler.js';
import { FederatedSearch } from './federation.js';
import { HubRole } from './hub-role.js';
import { HubRegistry } from './hub-registry.js';
import { HubCouncil } from './hub-council.js';
import { HubAdvisor } from './hub-advisor.js';

// ─── Types ───────────────────────────────────────────────────────────────────

type FetchFn = typeof globalThis.fetch;
type CallMcpToolFn = (name: string, args: Record<string, unknown>) => Promise<McpResult>;

interface McpResult {
  content?: Array<{ text?: string }> | string;
  peers?: unknown[];
  agents?: unknown[];
  [key: string]: unknown;
}

interface RouterLike {
  send(destination: string, message: unknown): Promise<unknown>;
  broadcast(message: unknown): Promise<unknown>;
  available(): Array<{ name: string }>;
}

interface LedgerLike {
  addReceipt(rcpt: unknown): { balance: number };
  getReceipts(query: { peer: string }): unknown[];
}

interface DataSourceRegistryLike {
  toAnnounce(): unknown[];
}

interface PlatformInfo {
  platform?: string;
  tools?: string[];
  [key: string]: unknown;
}

interface PeerInfo {
  nodeId: string;
  name: string;
  capabilities?: string[];
  channels?: string[];
  endpoint?: string | null;
  metadata?: Record<string, unknown>;
  dataSources?: unknown[];
  platform?: string | null;
  status?: string;
}

export interface MeshManagerOptions {
  router?: RouterLike | null;
  callMcpTool?: CallMcpToolFn | null;
  fetch?: FetchFn | null;
  registryOptions?: Record<string, unknown>;
  discoveryInterval?: number;
  heartbeatInterval?: number;
  ledger?: LedgerLike | null;
  privateKey?: string | null;
  delegationThreshold?: number;
  crawlerMaxHops?: number;
  crawlerCacheTtl?: number;
  queryTimeout?: number;
  federationMaxHops?: number;
  federationRateLimit?: number;
  hubRole?: string;
}

interface PromptOptions {
  systemPrompt?: string;
  model?: string;
  timeoutMs?: number;
  skill?: string;
}

interface PromptResult {
  method: string;
  response: string;
  model: string | null;
  raw: unknown;
  receipt?: unknown;
}

interface HeartbeatResult {
  nodeId: string;
  ok: boolean;
  latency?: number;
  error?: string;
}

interface SmartRouteResult {
  type: string;
  results: unknown[];
  source: string;
}

// ─── MeshManager ─────────────────────────────────────────────────────────────

export class MeshManager extends EventEmitter {
  private _router: RouterLike | null;
  private _callMcpTool: CallMcpToolFn | null;
  private _fetch: FetchFn | null;
  readonly registry: PeerRegistry;
  private _discoveryInterval: number;
  private _heartbeatInterval: number;
  private _discoveryTimer: ReturnType<typeof setInterval> | null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null;
  private _running: boolean;
  private _ledger: LedgerLike | null;
  private _privateKey: string | null;
  private _platformInfo: PlatformInfo | null;
  private _dataSourceRegistry: DataSourceRegistryLike | null;

  readonly trust: TrustGraph;
  readonly crawler: NetworkCrawler;
  readonly federation: FederatedSearch;
  readonly hubRole: HubRole;
  readonly hubRegistry: HubRegistry;
  readonly hubCouncil: HubCouncil;
  readonly hubAdvisor: HubAdvisor;

  constructor(options: MeshManagerOptions = {}) {
    super();
    this._router = options.router || null;
    this._callMcpTool = options.callMcpTool || null;
    this._fetch = options.fetch || null;
    this.registry = new PeerRegistry(options.registryOptions || {});
    this._discoveryInterval = options.discoveryInterval || 2 * 60 * 1000;
    this._heartbeatInterval = options.heartbeatInterval || 60 * 1000;
    this._discoveryTimer = null;
    this._heartbeatTimer = null;
    this._running = false;
    this._ledger = options.ledger || null;
    this._privateKey = options.privateKey || null;
    this._platformInfo = null;
    this._dataSourceRegistry = null;

    // Trust & Crawler
    this.trust = new TrustGraph({
      nodeId: this.nodeId,
      delegationThreshold: options.delegationThreshold,
    });
    this.crawler = new NetworkCrawler({
      fetch: this._fetch || globalThis.fetch,
      maxHops: options.crawlerMaxHops,
      cacheTtl: options.crawlerCacheTtl,
    });
    this.federation = new FederatedSearch({
      mesh: this,
      fetch: this._fetch || globalThis.fetch,
      queryTimeout: options.queryTimeout,
      maxHops: options.federationMaxHops,
      rateLimit: options.federationRateLimit,
    });

    // ─── Hub Council Layer ──────────────────────────────────────────
    this.hubRole = new HubRole({
      initialRole: options.hubRole || process.env.HUB_ROLE || 'auto',
      metricsInterval: parseInt(process.env.HUB_METRICS_INTERVAL || '15000', 10),
    });

    this.hubRegistry = new HubRegistry({
      heartbeatTimeout: parseInt(process.env.HUB_HEARTBEAT_TIMEOUT || '90000', 10),
      deadTimeout: parseInt(process.env.HUB_DEAD_TIMEOUT || '150000', 10),
      maxHubs: parseInt(process.env.HUB_MAX_COUNT || '10', 10),
    });

    this.hubCouncil = new HubCouncil({
      hubRegistry: this.hubRegistry,
      hubRole: this.hubRole,
      nodeId: this.nodeId,
      quorumRatio: parseFloat(process.env.HUB_QUORUM_RATIO || '0.51'),
      proposalTtl: parseInt(process.env.HUB_PROPOSAL_TTL || '30000', 10),
      minHubs: parseInt(process.env.HUB_MIN_COUNT || '1', 10),
      maxHubs: parseInt(process.env.HUB_MAX_COUNT || '10', 10),
    });

    this.hubAdvisor = new HubAdvisor({
      hubRegistry: this.hubRegistry,
      mesh: this,
      trust: this.trust,
      callMcpTool: this._callMcpTool,
      analysisInterval: parseInt(process.env.HUB_ADVISOR_INTERVAL || '300000', 10),
    });

    // Se este nó é hub, registra no hub registry
    if (this.hubRole.isHub) {
      this.hubRegistry.upsert(this.nodeId, {
        name: this.nodeName,
        state: 'active',
        epoch: this.hubRole.epoch,
        promotedBy: 'bootstrap',
      });
    }

    // Hub events → mesh events
    this.hubRole.on('transition', (data: unknown) => this.emit('hub-transition', data));
    this.hubRegistry.on('hub-added', (hub: unknown) => this.emit('hub-added', hub));
    this.hubRegistry.on('hub-removed', (hub: unknown) => this.emit('hub-removed', hub));
    this.hubRegistry.on('hub-dead', (hub: unknown) => {
      this.emit('hub-dead', hub);
      this.hubCouncil.evaluateNetwork();
    });
    this.hubCouncil.on('proposal-approved', (proposal: Record<string, unknown>) => {
      this.emit('hub-proposal-approved', proposal);
      this._executeHubDecision(proposal);
    });

    // Propaga eventos do registry
    for (const evt of ['peer-joined', 'peer-left', 'peer-stale', 'peer-updated']) {
      this.registry.on(evt, (peer: unknown) => this.emit(evt, peer));
    }
  }

  get nodeId(): string {
    return protocol.NODE_ID;
  }

  get nodeName(): string {
    return protocol.NODE_NAME;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this._running) return;
    this._running = true;
    console.log(`[mesh] Iniciando mesh como ${this.nodeName} (${this.nodeId})`);

    this.registry.startSweep();

    // Discovery inicial
    await this.discover().catch(err =>
      console.error(`[mesh] Erro no discovery inicial: ${(err as Error).message}`)
    );

    // Discovery periódico
    this._discoveryTimer = setInterval(() => {
      this.discover().catch(err =>
        console.error(`[mesh] Erro no discovery: ${(err as Error).message}`)
      );
    }, this._discoveryInterval);

    // Heartbeat periódico
    this._heartbeatTimer = setInterval(() => {
      this.heartbeatAll().catch(err =>
        console.error(`[mesh] Erro no heartbeat: ${(err as Error).message}`)
      );
    }, this._heartbeatInterval);

    // Hub layer startup
    this.hubRole.startMetrics();
    this.hubRegistry.startChecks(
      parseInt(process.env.HUB_HEARTBEAT_INTERVAL || '30000', 10),
    );
    this.hubCouncil.startCleanup();
    if (this.hubRole.isHub) {
      this.hubAdvisor.start();
    }
    console.log(`[mesh] Hub role: ${this.hubRole.state} (epoch ${this.hubRole.epoch})`);

    this.emit('started');
  }

  stop(): void {
    if (!this._running) return;
    this._running = false;
    clearInterval(this._discoveryTimer!);
    clearInterval(this._heartbeatTimer!);
    this.registry.stopSweep();
    this.hubRole.stopMetrics();
    this.hubRegistry.stopChecks();
    this.hubCouncil.stopCleanup();
    this.hubAdvisor.stop();
    this._discoveryTimer = null;
    this._heartbeatTimer = null;
    console.log('[mesh] Mesh parado');
    this.emit('stopped');
  }

  // ─── Discovery ───────────────────────────────────────────────────────────

  async discover(): Promise<PeerInfo[]> {
    if (!this._callMcpTool) return [];

    try {
      const result = await this._callMcpTool('list_peers', {});
      const peers = this._parsePeersResult(result);

      for (const p of peers) {
        if (p.nodeId === this.nodeId) continue;
        this.registry.upsert(p.nodeId, p);
      }

      // Descobre endpoints via mDNS do gateway (best-effort, async)
      this._discoverPeerEndpoints().catch(() => {});

      // Broadcast DISCOVER para que peers respondam com ANNOUNCE
      if (this._router) {
        const channels = this._getOwnChannels();
        const announceMsg = protocol.announce(this.hubRole.capabilities, channels, {
          channel: 'mesh',
          dataSources: this._dataSourceRegistry ? this._dataSourceRegistry.toAnnounce() : [],
          platform: this._platformInfo?.platform || null,
        });

        try {
          await this._router.broadcast(protocol.serialize(announceMsg));
        } catch {
          // Broadcast é best-effort
        }
      }

      this.emit('discovery-complete', { found: peers.length });
      return peers;
    } catch (err) {
      this.emit('discovery-error', err);
      throw err;
    }
  }

  private async _discoverPeerEndpoints(): Promise<void> {
    if (!this._callMcpTool) return;
    const fetchFn = this._fetch || globalThis.fetch;

    try {
      const result = await this._callMcpTool('get_logs', { service: 'gateway', lines: 50 });
      const text = typeof result?.content?.[0]?.text === 'string'
        ? result.content[0].text : '';
      let output: { lines?: string[] };
      try { output = JSON.parse(text); } catch { return; }
      const lines = output.lines || [];

      for (const line of lines) {
        const match = line.match(/discovered agent:\s+(.+?)\s+at\s+(https?:\/\/[\d.:]+)/i);
        if (!match) continue;
        const [, , url] = match;

        try {
          const res = await fetchFn(`${url}/.well-known/agent.json`, {
            signal: AbortSignal.timeout(5000),
          });
          if (!res.ok) continue;
          const agentJson = await res.json() as { identity?: { id?: string }; skills?: Array<{ id: string }> };
          const peerId = agentJson.identity?.id;
          if (!peerId || peerId === this.nodeId) continue;

          const peer = this.registry.get(peerId);
          if (peer && !peer.endpoint) {
            const skills = (agentJson.skills || []).map(s => s.id);
            this.registry.upsert(peerId, { endpoint: url, capabilities: skills });
            console.log(`[mesh] Endpoint mDNS para ${peer.name}: ${url}`);
          }
        } catch { /* best-effort per peer */ }
      }
    } catch { /* best-effort */ }
  }

  // ─── Admin Token ─────────────────────────────────────────────────────────

  async requestAdminToken(nodeId: string, options: { adminToken?: string } = {}): Promise<Record<string, unknown>> {
    const peer = this.registry.get(nodeId);
    if (!peer) throw new Error(`Peer ${nodeId} não encontrado`);

    const adminToken = options.adminToken || peer.metadata?.adminToken as string | undefined;
    const peerToken = adminToken || peer.metadata?.remoteToken as string | undefined || peer.metadata?.token as string | undefined;

    if (!peer.endpoint) {
      throw new Error(`Peer ${peer.name} não tem endpoint conhecido`);
    }

    const fetchFn = this._fetch || globalThis.fetch;
    const mcpBody = {
      jsonrpc: '2.0',
      method: 'tools/call',
      id: Date.now(),
      params: {
        name: 'create_token',
        arguments: {
          name: `mesh-admin-${this.nodeName}`,
          scopes: ['read', 'write', 'admin'],
        },
      },
    };

    // 1. Direto via HTTP ao endpoint MCP do peer
    try {
      const res = await fetchFn(`${peer.endpoint}/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(peerToken ? { 'Authorization': `Bearer ${peerToken}` } : {}),
        },
        body: JSON.stringify(mcpBody),
        signal: AbortSignal.timeout(15000),
      });

      if (res.ok) {
        const result = await res.json() as { result?: { content?: Array<{ text?: string }> } };
        const text = result?.result?.content?.[0]?.text || '';
        let parsed: Record<string, unknown> | null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }

        if (parsed?.token) {
          this.registry.upsert(nodeId, {
            metadata: {
              ...peer.metadata,
              adminToken: parsed.token,
              adminTokenId: parsed.id || parsed.tokenId,
            },
          });
          console.log(`[mesh] Admin token obtido para ${peer.name}`);
          this.emit('admin-token-received', { nodeId, tokenId: parsed.id });
          return parsed;
        }
        if (parsed?.error) {
          throw new Error(`create_token: ${parsed.error}`);
        }
      }
    } catch (err) {
      console.log(`[mesh] requestAdminToken HTTP falhou: ${(err as Error).message}`);
    }

    // 2. Via run_command no gateway (relay para peer na LAN)
    if (this._callMcpTool && peer.endpoint) {
      try {
        const mcpJson = JSON.stringify(mcpBody).replace(/"/g, '\\"');
        const authHeader = peerToken ? `-H "Authorization: Bearer ${peerToken}"` : '';
        const cmd = `curl -s --connect-timeout 5 --max-time 15 -X POST ${peer.endpoint}/mcp -H "Content-Type: application/json" ${authHeader} -d "${mcpJson}" 2>&1`;

        const result = await this._callMcpTool('run_command', { command: cmd });
        const text = typeof result?.content?.[0]?.text === 'string'
          ? result.content[0].text : '';
        let output: { output?: string };
        try { output = JSON.parse(text); } catch { output = { output: text }; }

        const responseText = output.output || '';
        let mcpResult: { result?: { content?: Array<{ text?: string }> } } | null;
        try { mcpResult = JSON.parse(responseText); } catch { mcpResult = null; }

        const innerText = mcpResult?.result?.content?.[0]?.text || '';
        let tokenData: Record<string, unknown> | null;
        try { tokenData = JSON.parse(innerText); } catch { tokenData = null; }

        if (tokenData?.token) {
          this.registry.upsert(nodeId, {
            metadata: {
              ...peer.metadata,
              adminToken: tokenData.token,
              adminTokenId: tokenData.id || tokenData.tokenId,
            },
          });
          console.log(`[mesh] Admin token obtido via relay para ${peer.name}`);
          this.emit('admin-token-received', { nodeId, tokenId: tokenData.id });
          return tokenData;
        }
      } catch (err) {
        console.log(`[mesh] requestAdminToken relay falhou: ${(err as Error).message}`);
      }
    }

    throw new Error(`Não foi possível obter admin token de ${peer.name}: sem permissão ou peer inacessível`);
  }

  // ─── Heartbeat ───────────────────────────────────────────────────────────

  async heartbeatAll(): Promise<HeartbeatResult[]> {
    const peers = this.registry.online();
    const results: HeartbeatResult[] = [];

    for (const peer of peers) {
      try {
        const start = Date.now();
        await this.pingPeer(peer.nodeId);
        const latency = Date.now() - start;
        this.registry.upsert(peer.nodeId, { latency });
        results.push({ nodeId: peer.nodeId, ok: true, latency });
      } catch (err) {
        results.push({ nodeId: peer.nodeId, ok: false, error: (err as Error).message });
      }
    }

    this.emit('heartbeat-complete', results);
    return results;
  }

  // ─── Messaging ───────────────────────────────────────────────────────────

  private async _sendToPeerRaw(nodeId: string, content: string): Promise<{ method: string; result: unknown }> {
    const peer = this.registry.get(nodeId);
    const fetchFn = this._fetch || globalThis.fetch;

    // 1. Endpoint HTTP direto
    if (peer?.endpoint) {
      const token = peer.metadata?.remoteToken as string | undefined || peer.metadata?.token as string | undefined;
      try {
        const res = await fetchFn(`${peer.endpoint}/api/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({ text: content }),
          signal: AbortSignal.timeout(15000),
        });
        if (res.ok) {
          const result = await res.json();
          return { method: 'http', result };
        }
        const errText = await res.text().catch(() => '');
        console.log(`[mesh] HTTP ${peer.name} retornou ${res.status}: ${errText.slice(0, 100)}`);
      } catch (err) {
        console.log(`[mesh] HTTP para ${peer.name} falhou: ${(err as Error).message}, tentando relay...`);
      }
    }

    // 2. POST /api/mesh/incoming
    if (peer?.endpoint) {
      try {
        const res = await fetchFn(`${peer.endpoint}/api/mesh/incoming`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from: this.nodeId, message: content }),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) return { method: 'mesh-http', result: await res.json() };
      } catch { /* fallthrough */ }
    }

    // 3. Relay via router
    if (this._router) {
      const result = await this._router.send(nodeId, content);
      return { method: 'relay', result };
    }

    throw new Error(`Sem rota para peer ${nodeId} (sem endpoint HTTP nem router)`);
  }

  async pingPeer(nodeId: string): Promise<{ method: string; result: unknown }> {
    const pingMsg = protocol.ping({ nodeId });
    const result = await this._sendToPeerRaw(nodeId, protocol.serialize(pingMsg));
    this.registry.touch(nodeId);
    return result;
  }

  async sendToPeer(nodeId: string, text: string): Promise<{ method: string; result: unknown }> {
    const peer = this.registry.get(nodeId);
    const message = protocol.msg(text, { nodeId, name: peer?.name || nodeId });
    const result = await this._sendToPeerRaw(nodeId, protocol.serialize(message));
    this.emit('message-sent', { to: nodeId, messageId: message.id });
    return result;
  }

  async sendPrompt(nodeId: string, prompt: string, options: PromptOptions = {}): Promise<PromptResult> {
    const peer = this.registry.get(nodeId);
    if (!peer) throw new Error(`Peer ${nodeId} não encontrado no registry`);

    const { systemPrompt, model, timeoutMs = 30000, skill = 'chat' } = options;
    const startTime = Date.now();
    const fetchFn = this._fetch || globalThis.fetch;
    const token = peer.metadata?.remoteToken as string | undefined || peer.metadata?.token as string | undefined;

    const body: Record<string, unknown> = { text: prompt };
    if (systemPrompt) body.system_prompt = systemPrompt;
    if (model) body.model = model;

    // 1. HTTP direto ao endpoint do peer
    if (peer.endpoint) {
      try {
        const res = await fetchFn(`${peer.endpoint}/api/message`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const result = await res.json() as { response?: string; model?: string };
          this.registry.touch(nodeId);
          const promptResult: PromptResult = { method: 'http', response: result.response || '', model: result.model || null, raw: result };
          promptResult.receipt = this._generateReceipt(nodeId, promptResult, { skill, startTime });
          this.emit('prompt-response', { nodeId, method: 'http', response: result });
          return promptResult;
        }
      } catch (err) {
        console.log(`[mesh] Prompt HTTP direto para ${peer.name} falhou: ${(err as Error).message}`);
      }
    }

    // 2. Via run_command no gateway (curl para peer na LAN)
    if (this._callMcpTool && peer.endpoint) {
      try {
        const bodyJson = JSON.stringify(body).replace(/"/g, '\\"');
        const authHeader = token ? `-H "Authorization: Bearer ${token}"` : '';
        const maxTime = Math.ceil(timeoutMs / 1000);
        const cmd = `curl -s --connect-timeout 5 --max-time ${maxTime} -X POST ${peer.endpoint}/api/message -H "Content-Type: application/json" ${authHeader} -d "${bodyJson}" 2>&1`;

        const result = await this._callMcpTool('run_command', { command: cmd });
        const text = typeof result?.content?.[0]?.text === 'string'
          ? result.content[0].text : '';
        let output: { output?: string };
        try { output = JSON.parse(text); } catch { output = { output: text }; }

        const responseText = output.output || '';
        let parsed: Record<string, unknown> | null;
        try { parsed = JSON.parse(responseText); } catch { parsed = null; }

        if (parsed?.response) {
          this.registry.touch(nodeId);
          const promptResult: PromptResult = { method: 'gateway-relay', response: parsed.response as string, model: parsed.model as string | null, raw: parsed };
          promptResult.receipt = this._generateReceipt(nodeId, promptResult, { skill, startTime });
          this.emit('prompt-response', { nodeId, method: 'gateway-relay', response: parsed });
          return promptResult;
        }
        if (responseText) {
          const promptResult: PromptResult = { method: 'gateway-relay', response: responseText, model: null, raw: output };
          promptResult.receipt = this._generateReceipt(nodeId, promptResult, { skill, startTime });
          return promptResult;
        }
      } catch (err) {
        console.log(`[mesh] Prompt via gateway relay para ${peer.name} falhou: ${(err as Error).message}`);
      }
    }

    // 3. Via send_prompt MCP
    if (this._callMcpTool) {
      try {
        const args: Record<string, unknown> = { text: prompt };
        if (model) args.model = model;
        if (systemPrompt) args.system_prompt = systemPrompt;
        const result = await this._callMcpTool('send_prompt', args);
        const text = typeof result?.content?.[0]?.text === 'string'
          ? result.content[0].text : '';
        let parsed: Record<string, unknown> | null;
        try { parsed = JSON.parse(text); } catch { parsed = null; }

        if (parsed?.response || parsed?.text) {
          const promptResult: PromptResult = { method: 'local-prompt', response: (parsed.response || parsed.text) as string, model: parsed.model as string | null, raw: parsed };
          promptResult.receipt = this._generateReceipt(nodeId, promptResult, { skill, startTime });
          return promptResult;
        }
        if (parsed?.error) {
          throw new Error(`send_prompt: ${parsed.error}`);
        }
      } catch (err) {
        console.log(`[mesh] send_prompt local falhou: ${(err as Error).message}`);
      }
    }

    throw new Error(`Não foi possível enviar prompt para ${peer.name || nodeId}: sem rota disponível`);
  }

  // ─── Receipt ──────────────────────────────────────────────────────────────

  private _generateReceipt(nodeId: string, result: PromptResult, options: { skill?: string; startTime?: number; prompt?: string } = {}): unknown {
    if (!this._ledger) return null;

    const { skill = 'chat', startTime = Date.now() } = options;
    const durationMs = Date.now() - startTime;
    const taskId = `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

    const rcpt = receipt.createReceipt({
      taskId,
      from: this.nodeId,
      to: nodeId,
      skill,
      result: result.response || result.raw || '',
      resourceUsed: { durationMs },
    });

    if (this._privateKey) {
      rcpt.fromSignature = receipt.signReceipt(rcpt.hash, this._privateKey);
    }

    const entry = this._ledger.addReceipt(rcpt);
    this.emit('receipt-created', { receipt: rcpt, balance: entry.balance });

    return rcpt;
  }

  // ─── Message Handling ────────────────────────────────────────────────────

  handleMessage(raw: string): Record<string, unknown> | null {
    const message = protocol.parse(raw);
    if (!message) return null;

    if (message.from?.nodeId && message.from.nodeId !== this.nodeId) {
      this.registry.touch(message.from.nodeId);
    }

    switch (message.type) {
      case 'PING':
        this._handlePing(message);
        break;
      case 'PONG':
        this.emit('pong', message);
        break;
      case 'DISCOVER':
        this._handleDiscover(message);
        break;
      case 'ANNOUNCE':
        this._handleAnnounce(message);
        break;
      case 'MSG':
        this.emit('peer-message', message);
        break;
      case 'CMD':
        this.emit('peer-command', message);
        break;
      default:
        this.emit('peer-event', message);
    }

    return message;
  }

  private _handlePing(message: Record<string, unknown>): void {
    const from = message.from as { nodeId?: string } | undefined;
    if (!from?.nodeId) return;

    const pongMsg = protocol.pong(message.id as string, from);
    this._sendToPeerRaw(from.nodeId, protocol.serialize(pongMsg))
      .catch(() => {});
  }

  private _handleDiscover(message: Record<string, unknown>): void {
    const from = message.from as { nodeId?: string; name?: string } | undefined;
    if (!from?.nodeId) return;

    const payload = message.payload as { capabilities?: string[] } | undefined;
    this.registry.upsert(from.nodeId, {
      name: from.name,
      capabilities: payload?.capabilities || [],
    });

    const channels = this._getOwnChannels();
    const announceMsg = protocol.announce(this.hubRole.capabilities, channels, {
      replyTo: message.id,
      dataSources: this._dataSourceRegistry ? this._dataSourceRegistry.toAnnounce() : [],
      platform: this._platformInfo?.platform || null,
    });

    this._sendToPeerRaw(from.nodeId, protocol.serialize(announceMsg))
      .catch(() => {});
  }

  private _handleAnnounce(message: Record<string, unknown>): void {
    const from = message.from as { nodeId?: string; name?: string } | undefined;
    if (!from?.nodeId) return;

    const payload = message.payload as {
      capabilities?: string[];
      channels?: string[];
      dataSources?: unknown[];
      platform?: string | null;
    } | undefined;

    this.registry.upsert(from.nodeId, {
      name: from.name,
      capabilities: payload?.capabilities || [],
      channels: payload?.channels || [],
      dataSources: payload?.dataSources || [],
      platform: payload?.platform || null,
    });
  }

  private _getOwnChannels(): string[] {
    if (!this._router) return [];
    return this._router.available().map(t => t.name);
  }

  // ─── Trust & Queries ─────────────────────────────────────────────────────

  updateAllTrust(): void {
    for (const peer of this.registry.list()) {
      let interactions: Record<string, unknown> = {};
      if (this._ledger) {
        const receipts = this._ledger.getReceipts({ peer: peer.nodeId });
        interactions = {
          receiptsCount: receipts.length,
          successRate: 1.0,
        };
      }
      this.trust.updateTrust(peer, interactions);
    }
  }

  queryBySkill(skill: string, options: { eligibleOnly?: boolean } = {}): unknown[] {
    const { eligibleOnly = true } = options;
    const peers = this.registry.list({ capability: skill });

    const ranking = this.trust.rankForDelegation(peers, {
      skill,
      ledger: this._ledger,
    });

    return eligibleOnly ? ranking.filter((r: { eligible: boolean }) => r.eligible) : ranking;
  }

  async crawlNetwork(options: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const seeds = this.registry.list().map(p => ({
      nodeId: p.nodeId,
      name: p.name,
      endpoint: p.endpoint,
    }));

    const result = await this.crawler.crawl(seeds, options);

    if (result.peers) {
      for (const [nodeId, peerInfo] of result.peers as Map<string, Record<string, unknown>>) {
        if (!this.registry.has(nodeId) && nodeId !== this.nodeId) {
          this.registry.upsert(nodeId, {
            name: peerInfo.name as string,
            capabilities: (peerInfo.capabilities || peerInfo.infra || []) as string[],
            endpoint: peerInfo.endpoint as string,
            metadata: {
              discoveredVia: peerInfo.discoveredVia,
              discoveredAt: peerInfo.discoveredAt,
              transitive: true,
            },
          });
        }
      }
      this.updateAllTrust();
    }

    return result;
  }

  getPublicPeerList(): Array<Record<string, unknown>> {
    // Dynamic import avoided — capabilities used inline
    return this.registry.list().map(p => ({
      nodeId: p.nodeId,
      name: p.name,
      endpoint: p.endpoint,
      infra: (p.capabilities || []).filter((c: string) => c.startsWith('infra:')),
      status: p.status,
      trust: this.trust.getDirectTrust(p.nodeId),
    }));
  }

  // ─── Hub Council Execution ───────────────────────────────────────────────

  private _executeHubDecision(proposal: Record<string, unknown>): void {
    if (proposal.type === 'promote') {
      const targetId = proposal.targetNodeId as string;

      if (targetId === this.nodeId) {
        this.hubRole.promote(proposal.epoch as number, proposal.proposedBy as string);
        this.hubRegistry.upsert(this.nodeId, {
          name: this.nodeName,
          state: 'active',
          epoch: this.hubRole.epoch,
          promotedBy: proposal.proposedBy,
        });
        this.hubAdvisor.start();
        console.log(`[hub] Este nó foi PROMOVIDO a hub (epoch ${this.hubRole.epoch})`);
      } else {
        this.hubRegistry.upsert(targetId, {
          name: proposal.targetNodeId,
          state: 'active',
          epoch: proposal.epoch,
          promotedBy: proposal.proposedBy,
        });
        console.log(`[hub] ${targetId} promovido a hub`);
      }
    }

    if (proposal.type === 'demote') {
      const targetId = proposal.targetNodeId as string;

      if (targetId === this.nodeId) {
        this.hubRole.demote(proposal.reason as string, proposal.proposedBy as string);
        this.hubRegistry.remove(this.nodeId);
        this.hubAdvisor.stop();
        console.log(`[hub] Este nó foi DEMOVIDO de hub`);
      } else {
        this.hubRegistry.remove(targetId);
        console.log(`[hub] ${targetId} demovido de hub`);
      }
    }
  }

  getHubEndpoints(): Array<{ nodeId: string; name: string; endpoint: string }> {
    return this.hubRegistry.getActive().map((h: Record<string, unknown>) => ({
      nodeId: h.nodeId as string,
      name: h.name as string,
      endpoint: h.endpoint as string,
    })).filter(h => h.endpoint);
  }

  // ─── Platform & Data Sources ─────────────────────────────────────────────

  setPlatformInfo(platformInfo: PlatformInfo | null, dataSourceRegistry: DataSourceRegistryLike | null): void {
    this._platformInfo = platformInfo || null;
    this._dataSourceRegistry = dataSourceRegistry || null;

    if (platformInfo?.tools) {
      this.hubRole.setPlatformCapabilities(platformInfo.tools);
    }
  }

  queryByDataSource(sourceName: string, options: { eligibleOnly?: boolean } = {}): unknown[] {
    const { eligibleOnly = true } = options;
    const peers = this.registry.list({ dataSource: sourceName });

    const ranking = this.trust.rankForDelegation(peers, {
      skill: sourceName,
      ledger: this._ledger,
    });

    return eligibleOnly ? ranking.filter((r: { eligible: boolean }) => r.eligible) : ranking;
  }

  queryByPlatform(platform: string): unknown[] {
    return this.registry.list({ platform }).filter((p: { status: string }) => p.status === 'online');
  }

  querySmartRoute(intent: string): SmartRouteResult {
    // 1. Tenta como tool/capability
    const bySkill = this.queryBySkill(intent, { eligibleOnly: false });
    if (bySkill.length > 0) {
      return { type: 'tool', results: bySkill, source: 'capability' };
    }

    // 2. Tenta como data source
    const byData = this.queryByDataSource(intent, { eligibleOnly: false });
    if (byData.length > 0) {
      return { type: 'data', results: byData, source: 'data-source' };
    }

    // 3. Tenta como nome de plataforma
    const platforms = ['windows', 'linux', 'android', 'macos'];
    if (platforms.includes(intent)) {
      const byPlatform = this.queryByPlatform(intent);
      if (byPlatform.length > 0) {
        return { type: 'platform', results: byPlatform, source: 'platform' };
      }
    }

    return { type: 'none', results: [], source: 'not-found' };
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────

  private _parsePeersResult(result: unknown): PeerInfo[] {
    let raw: Array<Record<string, unknown>> = [];

    if (Array.isArray(result)) {
      raw = result;
    } else if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        raw = Array.isArray(parsed) ? parsed : parsed.peers || parsed.agents || [];
      } catch { return []; }
    } else if (result && typeof result === 'object') {
      const r = result as Record<string, unknown>;
      if (r.peers || r.agents) {
        raw = (r.peers || r.agents) as Array<Record<string, unknown>> || [];
      } else if (r.content) {
        try {
          const text = typeof r.content === 'string'
            ? r.content
            : (r.content as Array<{ text?: string }>)[0]?.text || '';
          const parsed = JSON.parse(text);
          raw = Array.isArray(parsed) ? parsed : parsed.peers || parsed.agents || [];
        } catch { return []; }
      }
    }

    return raw.map(p => ({
      nodeId: (p.nodeId || p.identityId || p.agentId || p.agent_id || p.id || null) as string,
      name: (p.name || p.agentName || p.agent_name || 'unknown') as string,
      capabilities: (p.capabilities || p.caps || []) as string[],
      channels: (p.channels || p.transports || []) as string[],
      endpoint: (p.endpoint || p.url || null) as string | null,
      metadata: {
        ...(p.metadata as Record<string, unknown> || {}),
        ...(p.token ? { token: p.token } : {}),
        ...(p.remoteToken ? { remoteToken: p.remoteToken } : {}),
        ...(p.publicKey ? { publicKey: p.publicKey } : {}),
        ...(p.reputation != null ? { reputation: p.reputation } : {}),
        ...(p.relation ? { relation: p.relation } : {}),
        ...(p.endorsed != null ? { endorsed: p.endorsed } : {}),
        ...(p.lastSeen ? { gatewayLastSeen: p.lastSeen } : {}),
      },
    })).filter(p => p.nodeId);
  }

  toJSON(): Record<string, unknown> {
    return {
      nodeId: this.nodeId,
      nodeName: this.nodeName,
      running: this._running,
      platform: this._platformInfo || null,
      registry: this.registry.toJSON(),
      trust: this.trust.toJSON(),
      crawler: this.crawler.cacheInfo(),
      hub: {
        role: this.hubRole.toJSON(),
        registry: this.hubRegistry.toJSON(),
        council: this.hubCouncil.toJSON(),
        advisor: this.hubAdvisor.toJSON(),
      },
    };
  }
}

export default MeshManager;
