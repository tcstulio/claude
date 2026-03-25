// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, NextFunction, RequestHandler } from 'express';

// ─── Function Types ──────────────────────────────────────────────────────────

export type FetchFn = typeof globalThis.fetch;

export type CallMcpToolFn = (
  tool: string,
  args?: Record<string, unknown>,
  req?: Request | null,
) => Promise<McpResult>;

export type ResolveTokenFn = (req: Request) => string;

export type AuthHeadersFn = (req?: Request | null) => Record<string, string>;

// ─── MCP Types ───────────────────────────────────────────────────────────────

export interface McpResult {
  content?: Array<{ text?: string; type?: string }>;
  [key: string]: unknown;
}

// ─── Server Dependencies ─────────────────────────────────────────────────────

export interface ServerDeps {
  // Core
  callMcpTool: CallMcpToolFn;
  proxyFetch: FetchFn;
  resolveToken: ResolveTokenFn;
  authHeaders: AuthHeadersFn;
  requireAuth: RequestHandler;
  gatewayUrl: string;
  apiToken: string;
  port: number | string;

  // Transport
  router: RouterLike;
  queue: QueueLike;
  whatsapp: TransportLike;
  telegram: TelegramLike;
  email: EmailLike;
  webhook: WebhookLike;

  // Mesh & Network
  mesh: MeshLike;
  protocol: ProtocolLike;

  // Economy
  ledger: LedgerLike;
  receiptLib: ReceiptLibLike;

  // Infra
  infraScanner: InfraScannerLike;
  infraAdopter: InfraAdopterLike;
  canary: CanaryLike;
  networkRoutes: NetworkRoutesLike;

  // Org
  orgRegistry: OrgRegistryLike;

  // Capabilities
  localTools: LocalToolsLike;
  platformDetector: PlatformDetectorLike;
  dataSourceRegistry: DataSourceRegistryLike;
  platformInfo: PlatformInfo;
  nodeCapabilities: string[];

  // Services
  serviceRegistry: Map<string, ServiceEntry>;
}

// ─── Lightweight interfaces (avoid importing concrete classes) ───────────────

export interface TransportLike {
  configured: boolean;
  send(destination: string, message: unknown): Promise<unknown>;
  receive(from?: string, options?: Record<string, unknown>): Promise<unknown>;
}

export interface TelegramLike extends TransportLike {
  _chatId?: string;
  startPolling(callback: (msg: { from: string; text: string }) => void): void;
}

export interface EmailLike extends TransportLike {
  listDrafts(): Promise<unknown>;
}

export interface WebhookLike extends TransportLike {
  _defaultEndpoint?: string;
  _endpoints: Map<string, unknown>;
  addEndpoint(name: string, config: Record<string, unknown>): void;
  removeEndpoint(name: string): void;
  listEndpoints(): unknown[];
  emit(event: string, data: unknown): void;
}

export interface RouterLike {
  send(destination: string, message: unknown, options?: Record<string, unknown>): Promise<RouterResult>;
  healthCheckAll(): Promise<unknown>;
  toJSON(): unknown;
  get(name: string): unknown;
  register(transport: TransportLike): void;
  _transports: Map<string, unknown>;
}

export interface RouterResult {
  ok?: boolean;
  queued?: boolean;
  id?: string;
  channel?: string;
  errors?: unknown[];
}

export interface QueueLike {
  toJSON(): unknown;
  start(interval: number): void;
}

export interface MeshLike {
  registry: RegistryLike;
  trust: TrustLike;
  hubRole: HubRoleLike;
  hubRegistry: HubRegistryLike;
  hubCouncil: HubCouncilLike;
  hubAdvisor: HubAdvisorLike;
  crawler: CrawlerLike;
  federation: FederationLike;
  toJSON(): unknown;
  discover(): Promise<unknown[]>;
  pingPeer(nodeId: string): Promise<unknown>;
  sendToPeer(nodeId: string, message: string): Promise<unknown>;
  sendPrompt(nodeId: string, prompt: string, options?: Record<string, unknown>): Promise<PromptResult>;
  requestAdminToken(nodeId: string, options?: Record<string, unknown>): Promise<unknown>;
  heartbeatAll(): Promise<unknown[]>;
  handleMessage(message: string): Record<string, unknown> | null;
  getPublicPeerList(): unknown[];
  queryBySkill(skill: string, options?: { eligibleOnly?: boolean }): unknown[];
  crawlNetwork(options?: Record<string, unknown>): Promise<Record<string, unknown>>;
  querySmartRoute(intent: string): SmartRouteResult;
  setPlatformInfo(info: PlatformInfo, registry: DataSourceRegistryLike): void;
  start(): Promise<void>;
  on(event: string, listener: (...args: unknown[]) => void): void;
}

export interface RegistryLike {
  list(filter?: Record<string, unknown>): Array<PeerEntry>;
  get(nodeId: string): PeerEntry | undefined;
  upsert(nodeId: string, info: Record<string, unknown>): PeerEntry;
  online(): PeerEntry[];
  toJSON(): unknown;
}

export interface PeerEntry {
  nodeId: string;
  name: string;
  capabilities: string[];
  channels: string[];
  endpoint?: string;
  status: string;
  metadata?: Record<string, unknown>;
  platform?: string;
  dataSources?: unknown[];
}

export interface TrustLike {
  toJSON(): unknown;
  rankForDelegation(peers: unknown[], options?: Record<string, unknown>): unknown[];
}

export interface HubRoleLike {
  toJSON(): unknown;
}

export interface HubRegistryLike {
  toJSON(): unknown;
  processHeartbeat(nodeId: string, metrics?: unknown): unknown;
  applySync(hubs: unknown, epoch?: unknown): unknown;
  _epoch?: number;
}

export interface HubCouncilLike {
  toJSON(): unknown;
  propose(type: string, targetNodeId: string, reason: string): unknown;
  vote(proposalId: string, nodeId: string, vote: string, reason?: string): unknown;
  receiveProposal(proposal: unknown): unknown;
  evaluateNetwork(): unknown;
}

export interface HubAdvisorLike {
  toJSON(): unknown;
  analyze(): Promise<unknown>;
}

export interface CrawlerLike {
  cacheInfo(): unknown;
}

export interface FederationLike {
  query(skill: string, options?: Record<string, unknown>): Promise<unknown>;
  stats(): unknown;
}

export interface PromptResult {
  method: string;
  response: string;
  model: string | null;
  raw: unknown;
  receipt?: unknown;
}

export interface SmartRouteResult {
  type: string;
  results: unknown[];
  source: string;
}

export interface ProtocolLike {
  NODE_ID: string;
  NODE_NAME: string;
  createMessage(type: string, payload: unknown, from?: unknown, options?: Record<string, unknown>): unknown;
}

export interface LedgerLike {
  getSummary(): unknown;
  getBalance(): unknown;
  getReceipts(filter?: Record<string, unknown>): unknown[];
  getPeerBalance(nodeId: string): unknown;
}

export interface ReceiptLibLike {
  verifyReceipt(receipt: unknown, keys?: Record<string, unknown>): unknown;
}

export interface InfraScannerLike {
  scanEndpoints(endpoints: string[]): Promise<unknown[]>;
  scanSubnets(options?: Record<string, unknown>): Promise<unknown[]>;
  scanHost(ip: string): Promise<unknown[]>;
  getLastScan(): unknown;
}

export interface InfraAdopterLike {
  adopt(discovered: Record<string, unknown>, credentials?: unknown): unknown;
  list(): unknown[];
  test(nodeId: string): Promise<unknown>;
  remove(nodeId: string): void;
}

export interface CanaryLike {
  start(config: Record<string, unknown>): Promise<unknown>;
  getRun(runId: string): unknown;
  listRuns(filter?: Record<string, unknown>): unknown[];
  approve(runId: string, approved: boolean, reason?: string): unknown;
}

export interface NetworkRoutesLike {
  toJSON(): unknown;
  autoRegister(nodeId: string, info: Record<string, unknown>): unknown;
  setRoutes(nodeId: string, routes: unknown[]): void;
  getRoutes(nodeId: string): unknown[];
  resolve(nodeId: string, options?: Record<string, unknown>): Promise<unknown>;
  testAll(nodeId: string): Promise<unknown>;
}

export interface OrgRegistryLike {
  create(name: string, createdBy: string, policies?: unknown): OrgLike;
  list(filter?: Record<string, unknown>): OrgLike[];
  get(orgId: string): OrgLike | undefined;
  getOrgReputation(orgId: string): unknown;
  getTrustBoost(nodeId: string): unknown;
  getPublicOrgInfo(nodeId: string): unknown;
  remove(orgId: string, removedBy: string): void;
  save(): void;
}

export interface OrgLike {
  id: string;
  toJSON(): unknown;
  invite(nodeId: string, invitedBy: string, role?: string): unknown;
  acceptInvite(nodeId: string): unknown;
  updatePolicies(policies: unknown, changedBy: string): unknown;
  removeMember(nodeId: string, removedBy: string): void;
}

export interface LocalToolsLike {
  list(): unknown[];
  handle(name: string, args: Record<string, unknown>): unknown;
}

export interface PlatformDetectorLike {
  detect(): PlatformInfo;
}

export interface PlatformInfo {
  platform: string;
  tools: string[];
  dataSources: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface DataSourceRegistryLike {
  toJSON(): unknown;
  toAnnounce(): unknown[];
  get(name: string): unknown;
  has(name: string): boolean;
}

export interface ServiceEntry {
  nodeId: string;
  name: string;
  services: Array<ServiceInfo>;
  registeredAt: string;
  lastHeartbeat: string;
  status: string;
}

export interface ServiceInfo {
  name: string;
  url?: string;
  type?: string;
  version?: string;
}

// ─── Capabilities Lib ────────────────────────────────────────────────────────

export interface CapabilitiesLibLike {
  filterByCategory(capabilities: string[], category: string): string[];
  enrich(capabilities: string[]): unknown[];
  accessibleCapabilities(capabilities: string[], scopes: string[]): string[];
  classify(capability: string): string;
  requiredScope(capability: string): string;
  KNOWN_CAPABILITIES: unknown;
  DATA_SCOPES: unknown;
}

// ─── Dashboard ───────────────────────────────────────────────────────────────

export interface DashboardLibLike {
  generateDashboard(deps: Record<string, unknown>): unknown;
  verifyAsThirdParty(receipt: unknown, deps: Record<string, unknown>): unknown;
}

// ─── Express augmentation ────────────────────────────────────────────────────

declare global {
  namespace Express {
    interface Request {
      grantedScopes?: string[];
      peer?: { nodeId: string };
    }
  }
}

export type { Application, Request, Response, NextFunction, RequestHandler };
