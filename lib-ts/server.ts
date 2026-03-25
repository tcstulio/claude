// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// server.ts — Bootstrap mínimo. Inicializa deps e monta handlers modulares.

import express from 'express';
import { ProxyAgent, fetch as undiciFetch } from 'undici';
import type { Request, Response, NextFunction } from 'express';

// ─── Lib imports ─────────────────────────────────────────────────────────────
import WhatsAppTransport from './transport/whatsapp.js';
import TelegramTransport from './transport/telegram.js';
import EmailTransport from './transport/email.js';
import WebhookTransport from './transport/webhook.js';
import MessageQueue from './queue.js';
import Router from './router.js';
import MeshManager from './mesh/mesh-manager.js';
import * as protocol from './protocol.js';
import { Ledger } from './ledger/ledger.js';
import * as receiptLib from './ledger/receipt.js';
import { generateDashboard, verifyAsThirdParty } from './ledger/dashboard.js';
import createLocalTools from './local-tools.js';
import * as capabilitiesLib from './capabilities.js';
import * as platformDetector from './platform-detector.js';
import DataSourceRegistry from './data-sources.js';
import { requireScope, resolveScopes } from './middleware/scope-guard.js';
import { tokenFederation, introspectHandler } from './middleware/token-federation.js';
import { InfraScanner } from './infra/infra-scanner.js';
import { InfraAdopter } from './infra/infra-adopt.js';
import { CanaryRunner } from './infra/canary.js';
import { NetworkRoutes } from './infra/network-routes.js';
import { OrgRegistry } from './org/org-registry.js';

// ─── Handler imports ─────────────────────────────────────────────────────────
import { MonitorService } from './handlers/monitor.js';
import { registerCoreRoutes } from './handlers/core-routes.js';
import { registerTransportRoutes } from './handlers/transport-routes.js';
import { registerMeshRoutes } from './handlers/mesh-routes.js';
import { registerHubRoutes } from './handlers/hub-routes.js';
import { registerCapabilitiesRoutes } from './handlers/capabilities-routes.js';
import { registerInfraRoutes } from './handlers/infra-routes.js';
import { registerOrgEconomyRoutes } from './handlers/org-economy-routes.js';
import { registerServicesDeployRoutes } from './handlers/services-deploy-routes.js';

import type { ServerDeps, ServiceEntry, CallMcpToolFn } from './types.js';

// ─── Config ──────────────────────────────────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://agent.coolgroove.com.br';
const PORT = process.env.PORT || 3000;
const API_TOKEN = process.env.TULIPA_TOKEN || '';

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

function proxyFetch(url: string | URL, options: Record<string, unknown> = {}): Promise<globalThis.Response> {
  return undiciFetch(url as string, { ...options, dispatcher } as Parameters<typeof undiciFetch>[1]) as unknown as Promise<globalThis.Response>;
}

function resolveToken(req?: Request | null): string {
  if (API_TOKEN) return API_TOKEN;
  const auth = req?.get?.('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

function authHeaders(req?: Request | null): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  const token = resolveToken(req);
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

function getRequestToken(req: Request): string {
  const auth = req?.get?.('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

// ─── MCP Tool Helper ─────────────────────────────────────────────────────────

let _mcpCallId = 0;
const MCP_MAX_RETRIES = 3;
const MCP_RETRY_DELAYS = [2000, 4000, 8000];

const callMcpTool: CallMcpToolFn = async (tool, args = {}, req = null) => {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MCP_MAX_RETRIES; attempt++) {
    try {
      const res = await proxyFetch(`${GATEWAY_URL}/mcp`, {
        method: 'POST',
        headers: authHeaders(req),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: ++_mcpCallId,
          params: { name: tool, arguments: args },
        }),
        signal: AbortSignal.timeout(20000),
      });

      if (!res.ok) {
        const text = await res.text();
        const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
        const detail = isHtml
          ? `Gateway retornou ${res.status} (servidor MCP offline)`
          : `Gateway retornou ${res.status}: ${text}`;
        const err = new Error(detail) as Error & { statusCode: number };
        err.statusCode = res.status;
        throw err;
      }

      const json = await res.json() as Record<string, unknown>;

      if (json.jsonrpc === '2.0') {
        if (json.error) {
          const e = json.error as { code: number; message: string };
          throw new Error(`MCP error ${e.code}: ${e.message}`);
        }
        return json.result as Record<string, unknown>;
      }

      return json;

    } catch (err) {
      lastError = err as Error;
      const e = err as Error & { statusCode?: number; code?: string };
      const retryable = e.statusCode === 502 || e.statusCode === 503 || e.code === 'UND_ERR_CONNECT_TIMEOUT' || e.name === 'TimeoutError';

      if (retryable && attempt < MCP_MAX_RETRIES) {
        const delay = MCP_RETRY_DELAYS[attempt] || 8000;
        console.log(`[mcp] ${tool} falhou (${e.message}), retry ${attempt + 1}/${MCP_MAX_RETRIES} em ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
};

// ─── Express App ─────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static('public'));

// ─── Auth Middleware ──────────────────────────────────────────────────────────

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const token = getRequestToken(req);
  if (!token) {
    res.status(401).json({ error: 'Authorization required — envie header Authorization: Bearer <token>' });
    return;
  }
  if (API_TOKEN && token === API_TOKEN) { next(); return; }
  if ((req as any).grantedScopes && (req as any).grantedScopes.length > 0) { next(); return; }
  if (!API_TOKEN) { next(); return; }
  res.status(403).json({ error: 'Token inválido' });
}

// ─── Transport Layer ─────────────────────────────────────────────────────────

const queue = new MessageQueue({
  sendFn: (async (item: { destination: string; message: unknown; channel?: string }) => {
    await router.send(item.destination, item.message, { preferChannel: item.channel });
  }) as any,
});

const whatsapp = new WhatsAppTransport({
  callMcpTool,
  groups: process.env.WHATSAPP_GROUPS ? process.env.WHATSAPP_GROUPS.split(',') : [],
  priority: 1,
});

const telegram = new TelegramTransport({
  fetch: proxyFetch as any,
  priority: 2,
});

const email = new EmailTransport({
  callGmailTool: async (tool: string, args: Record<string, unknown>) => callMcpTool(tool, args),
  priority: 3,
});

const webhook = new WebhookTransport({
  fetch: proxyFetch as any,
  priority: 4,
});

const router = new Router({ queue } as any);
router.register(whatsapp as any);
if (telegram.configured) router.register(telegram as any);
if (email.configured) router.register(email as any);
if (webhook.configured) router.register(webhook as any);

// ─── Ledger ──────────────────────────────────────────────────────────────────

const ledger = new Ledger({
  nodeId: protocol.NODE_ID,
  dataDir: process.env.LEDGER_DIR || './data/ledger',
});

// ─── Mesh ────────────────────────────────────────────────────────────────────

const mesh = new MeshManager({
  router: router as any,
  callMcpTool,
  fetch: proxyFetch as any,
  ledger: ledger as any,
  discoveryInterval: parseInt(process.env.MESH_DISCOVERY_INTERVAL || '120000', 10),
  heartbeatInterval: parseInt(process.env.MESH_HEARTBEAT_INTERVAL || '60000', 10),
});

// ─── Infra ───────────────────────────────────────────────────────────────────

const infraScanner = new InfraScanner({
  fetch: proxyFetch as any,
  subnets: (process.env.SCAN_SUBNETS || '192.168.1,192.168.15,10.0.0').split(','),
  timeout: parseInt(process.env.SCAN_TIMEOUT || '3000', 10),
});

const infraAdopter = new InfraAdopter({
  registry: mesh.registry as any,
  trust: mesh.trust as any,
  fetch: proxyFetch as any,
});

const networkRoutes = new NetworkRoutes({ fetch: proxyFetch as any });
networkRoutes.detectLocalNetwork();

infraScanner.on('discovered', (svc: { type: string; endpoint: string; version: string }) => {
  console.log(`[infra] Descoberto: ${svc.type} em ${svc.endpoint} (v${svc.version})`);
});
infraAdopter.on('adopted', ({ nodeId, type, endpoint }: { nodeId: string; type: string; endpoint: string }) => {
  console.log(`[infra] Adotado: ${type} como ${nodeId} (${endpoint})`);
});

const canary = new CanaryRunner({
  mesh: mesh as any,
  ledger,
  ownerNode: process.env.OWNER_NODE || undefined,
  notify: (async (_nodeId: string, message: string) => {
    console.log(`[canary] Notificação: ${message}`);
    if (process.env.ALERT_PHONE) {
      try { await callMcpTool('send_whatsapp', { to: process.env.ALERT_PHONE, message }); } catch { /* */ }
    }
  }) as any,
});

// ─── Org ─────────────────────────────────────────────────────────────────────

const orgRegistry = new OrgRegistry({
  dataDir: process.env.LEDGER_DIR || './data',
  trust: mesh.trust,
});

// ─── Middleware ──────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(resolveScopes({
  resolveToken: getRequestToken as any,
  masterToken: API_TOKEN,
  mesh: mesh as any,
}) as any);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use(tokenFederation({
  getRequestToken: getRequestToken as any,
  masterToken: API_TOKEN,
  mesh: mesh as any,
  fetch: proxyFetch as any,
  hubEndpoints: process.env.HUB_ENDPOINTS
    ? process.env.HUB_ENDPOINTS.split(',')
    : (process.env.GATEWAY_URL ? [process.env.GATEWAY_URL] : []),
}) as any);

// ─── Local Tools ─────────────────────────────────────────────────────────────

const localTools = createLocalTools({ ledger, mesh: mesh as any, protocol });

// ─── Platform Detection ──────────────────────────────────────────────────────

const platformInfo = platformDetector.detect();
const dataSourceRegistry = new DataSourceRegistry(platformInfo);
const nodeCapabilities = [...new Set([
  ...(process.env.NODE_CAPABILITIES || 'chat,monitoring,deploy,relay').split(',').map(s => s.trim()),
  ...platformInfo.tools,
  ...platformInfo.dataSources.map(ds => ds.name),
])].filter(Boolean);

mesh.setPlatformInfo(platformInfo as any, dataSourceRegistry);

// ─── Event logging ───────────────────────────────────────────────────────────

mesh.on('peer-joined', (peer: { name: string; channels: string[] }) => {
  console.log(`[mesh] Novo peer: ${peer.name} — canais: ${peer.channels?.join(', ') || 'nenhum'}`);
});
mesh.on('peer-left', (peer: { name: string }) => {
  console.log(`[mesh] Peer saiu: ${peer.name}`);
});
router.on('sent', ({ channel, destination }: { channel: string; destination: string }) => {
  console.log(`[router] Enviado via ${channel} para ${destination}`);
});
router.on('queued', ({ destination, id }: { destination: string; id: string }) => {
  console.log(`[router] Enfileirado ${id} para ${destination}`);
});
router.on('channel-failed', ({ channel, error }: { channel: string; error: string }) => {
  console.log(`[router] Canal ${channel} falhou: ${error}`);
});

// ─── Monitor ─────────────────────────────────────────────────────────────────

const monitor = new MonitorService({
  callMcpTool,
  proxyFetch: proxyFetch as any,
  authHeaders,
  router: router as any,
  alertPhone: process.env.ALERT_PHONE || '',
  slowThreshold: parseInt(process.env.SLOW_THRESHOLD || '10000', 10),
  monitorInterval: parseInt(process.env.MONITOR_INTERVAL || '120000', 10),
  gatewayUrl: GATEWAY_URL,
});

// ─── Service Registry ────────────────────────────────────────────────────────

const serviceRegistry = new Map<string, ServiceEntry>();

// ─── Deps object ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- structural type boundaries between modules
const deps = {
  callMcpTool,
  proxyFetch,
  resolveToken,
  authHeaders,
  requireAuth,
  gatewayUrl: GATEWAY_URL,
  apiToken: API_TOKEN,
  port: PORT,
  router,
  queue,
  whatsapp,
  telegram,
  email,
  webhook,
  mesh,
  protocol,
  ledger,
  receiptLib,
  infraScanner,
  infraAdopter,
  canary,
  networkRoutes,
  orgRegistry,
  localTools,
  platformDetector,
  dataSourceRegistry,
  platformInfo,
  nodeCapabilities,
  serviceRegistry,
} as unknown as ServerDeps;

// ─── Register Routes ─────────────────────────────────────────────────────────

registerCoreRoutes(app, { ...deps, monitor });

registerTransportRoutes(app, deps);

registerMeshRoutes(app, deps);

registerHubRoutes(app, deps);

registerCapabilitiesRoutes(app, {
  ...deps,
  capabilitiesLib: capabilitiesLib as any,
  introspectHandler: introspectHandler as any,
} as any);

registerInfraRoutes(app, deps);

registerOrgEconomyRoutes(app, {
  ...deps,
  dashboardLib: { generateDashboard, verifyAsThirdParty } as any,
} as any);

registerServicesDeployRoutes(app, deps);

// ─── Startup ─────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\nTulipa API v0.4.0 — Multi-Channel + Mesh + Ledger`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Node: ${protocol.NODE_ID} (${protocol.NODE_NAME})`);
  console.log(`\nTransports: ${[...(router as any)._transports.keys()].join(', ')}`);

  console.log(`\nEndpoints:`);
  console.log('  GET  /api/health');
  console.log('  GET  /api/status');
  console.log('  GET  /api/monitor');
  console.log('  GET  /api/transport          — estado dos canais');
  console.log('  GET  /api/transport/health   — health check canais');
  console.log('  GET  /api/queue              — fila de mensagens');
  console.log('  POST /api/send               — enviar via protocolo');
  console.log('  GET  /api/whatsapp/history');
  console.log('  POST /api/whatsapp/send');
  console.log('  GET  /api/peers');
  console.log('  GET  /api/logs');
  console.log('  POST /api/mcp/:tool');

  if (email.configured) {
    console.log('  POST /api/email/send');
    console.log('  GET  /api/email/search');
    console.log('  GET  /api/email/drafts');
  } else {
    console.log('\n  Email: disponível via Gmail MCP');
  }

  console.log('  POST /api/webhook/send');
  console.log('  POST /api/webhook/endpoints      — registrar endpoint');
  console.log('  GET  /api/webhook/endpoints       — listar endpoints');
  console.log('  POST /api/webhook/incoming/:src   — receber webhook');
  if (webhook.configured) {
    console.log(`  Webhooks configurados: ${[...(webhook as any)._endpoints.keys()].join(', ')}`);
  }

  if (telegram.configured) {
    console.log('  POST /api/telegram/send');
    console.log('  GET  /api/telegram/updates');
    telegram.startPolling((msg: { from: string; text: string }) => {
      console.log(`[telegram] Mensagem de ${msg.from}: ${msg.text.slice(0, 50)}`);
    });
  } else {
    console.log('\n  Telegram: não configurado (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
  }

  console.log('\n  Mesh:');
  console.log('  GET  /api/mesh               — estado do mesh');
  console.log('  GET  /api/mesh/peers          — peers conhecidos');
  console.log('  POST /api/mesh/discover       — forçar discovery');
  console.log('  POST /api/mesh/ping/:nodeId   — ping peer');
  console.log('  POST /api/mesh/send/:nodeId   — enviar para peer');
  console.log('  POST /api/mesh/prompt/:nodeId — enviar prompt a peer (Claude P2P)');
  console.log('  POST /api/mesh/incoming       — receber de peer (P2P)');
  console.log('  POST /api/mesh/heartbeat      — pingar todos');

  console.log('\n  Services:');
  console.log('  GET  /api/services            — listar serviços da rede');
  console.log('  POST /api/services/register   — registrar nó/serviço');
  console.log('  POST /api/services/heartbeat  — heartbeat de nó');
  console.log('\n  Deploy:');
  console.log('  POST /api/deploy/webhook      — GitHub webhook auto-deploy');
  console.log('  POST /api/deploy/trigger      — deploy manual');
  console.log('  POST /api/deploy/remote       — deploy remoto via run_command');
  console.log('  GET  /api/deploy/log          — log de deploys');

  // Inicia mesh
  mesh.start().catch((err: Error) => {
    console.error(`[mesh] Falha ao iniciar: ${err.message}`);
  });

  monitor.start();
  queue.start(5000);
});

export default app;
