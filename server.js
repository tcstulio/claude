const express = require('express');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// ─── Transport Layer ───────────────────────────────────────────────────
const WhatsAppTransport = require('./lib/transport/whatsapp');
const TelegramTransport = require('./lib/transport/telegram');
const EmailTransport = require('./lib/transport/email');
const WebhookTransport = require('./lib/transport/webhook');
const Router = require('./lib/router');
const MeshManager = require('./lib/mesh');
const protocol = require('./lib/protocol');

// ─── Fase 9-11: SQLite, Task Engine, Identity ─────────────────────────
const Storage = require('./lib/storage');
const MessageQueueSQLite = require('./lib/queue-sqlite');
const TaskEngine = require('./lib/task-engine');
const Identity = require('./lib/identity');

const app = express();

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://agent.coolgroove.com.br';
const PORT = process.env.PORT || 3000;

// Configura proxy se disponível no ambiente
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const API_TOKEN = process.env.TULIPA_TOKEN || '';

function proxyFetch(url, options = {}) {
  return undiciFetch(url, { ...options, dispatcher });
}

// Resolve token: env var ou passthrough do header Authorization do cliente
function resolveToken(req) {
  if (API_TOKEN) return API_TOKEN;
  const auth = req?.get?.('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

function authHeaders(req) {
  const h = { 'Content-Type': 'application/json' };
  const token = resolveToken(req);
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

app.use(express.json());
app.use(express.static('public'));

// ─── Rate Limiting ────────────────────────────────────────────────────
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 min
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX || '60', 10); // 60 req/min
const rateLimitMap = new Map();

function rateLimit(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = rateLimitMap.get(ip);

  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW) {
    entry = { count: 0, windowStart: now };
    rateLimitMap.set(ip, entry);
  }

  entry.count++;

  if (entry.count > RATE_LIMIT_MAX) {
    res.set('Retry-After', Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000));
    return res.status(429).json({ error: 'Rate limit excedido', retryAfter: Math.ceil((entry.windowStart + RATE_LIMIT_WINDOW - now) / 1000) });
  }

  next();
}

// Limpa IPs antigos a cada 5 min
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW * 2) rateLimitMap.delete(ip);
  }
}, 5 * 60 * 1000);

// Rate limit em todas as rotas API
app.use('/api', rateLimit);

// ─── Autenticação do Dashboard ────────────────────────────────────────
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || process.env.TULIPA_TOKEN || '';

function requireAuth(req, res, next) {
  // Sem token configurado = modo dev (sem auth)
  if (!DASHBOARD_TOKEN) return next();

  const auth = req.get('authorization') || '';
  const queryToken = req.query.token;
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : queryToken;

  if (token === DASHBOARD_TOKEN) return next();

  res.status(401).json({ error: 'Token inválido ou ausente', hint: 'Envie Authorization: Bearer <token>' });
}

// Rotas públicas (sem auth): health, monitor, services GET, dashboard HTML
// Rotas protegidas: tudo que modifica estado (send, deploy, mcp, etc)

// ─── Helper: chama MCP tool no gateway ─────────────────────────────────
async function callMcpTool(tool, args = {}, req = null) {
  const res = await proxyFetch(`${GATEWAY_URL}/mcp`, {
    method: 'POST',
    headers: authHeaders(req),
    body: JSON.stringify({ tool, arguments: args }),
  });

  if (!res.ok) {
    const text = await res.text();
    const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
    const detail = isHtml
      ? `Gateway retornou ${res.status} (servidor MCP offline)`
      : `Gateway retornou ${res.status}: ${text}`;
    throw new Error(detail);
  }

  return res.json();
}

// ─── Inicializa Storage (SQLite) ──────────────────────────────────────
const storage = new Storage();

// ─── Inicializa Identity (Ed25519) ────────────────────────────────────
const identity = new Identity({
  nodeId: protocol.NODE_ID,
  nodeName: protocol.NODE_NAME,
});

// ─── Inicializa Transport Layer ────────────────────────────────────────
const queue = new MessageQueueSQLite({
  storage,
  sendFn: async (item) => {
    await router.send(item.destination, item.message, { preferChannel: item.channel });
  },
});

const whatsapp = new WhatsAppTransport({
  callMcpTool,
  groups: process.env.WHATSAPP_GROUPS ? process.env.WHATSAPP_GROUPS.split(',') : [],
  priority: 1,
});

const telegram = new TelegramTransport({
  fetch: proxyFetch,
  priority: 2,
});

const email = new EmailTransport({
  callGmailTool: async (tool, args) => callMcpTool(tool, args),
  priority: 3,
});

const webhook = new WebhookTransport({
  fetch: proxyFetch,
  priority: 4,
});

const router = new Router({ queue });
router.register(whatsapp);
if (telegram.configured) router.register(telegram);
if (email.configured) router.register(email);
if (webhook.configured) router.register(webhook);

// ─── Mesh Layer ───────────────────────────────────────────────────────
const mesh = new MeshManager({
  router,
  callMcpTool,
  discoveryInterval: parseInt(process.env.MESH_DISCOVERY_INTERVAL || '120000', 10),
  heartbeatInterval: parseInt(process.env.MESH_HEARTBEAT_INTERVAL || '60000', 10),
});

mesh.on('peer-joined', (peer) => {
  console.log(`[mesh] Novo peer: ${peer.name} — canais: ${peer.channels.join(', ') || 'nenhum'}`);
  // Persiste peer no SQLite
  storage.upsertPeer(peer);
});
mesh.on('peer-left', (peer) => {
  console.log(`[mesh] Peer saiu: ${peer.name}`);
});

// ─── Task Engine ────────────────────────────────────────────────────
const taskEngine = new TaskEngine({
  storage,
  mesh,
  callMcpTool,
  maxConcurrent: parseInt(process.env.TASK_MAX_CONCURRENT || '5', 10),
});

// Handler: enviar mensagem via router
taskEngine.registerHandler('send_message', async (task) => {
  const { destination, message, channel } = task.input;
  return router.send(destination, message, { preferChannel: channel });
});

// Handler: chamar MCP tool
taskEngine.registerHandler('mcp_call', async (task) => {
  const { tool, args } = task.input;
  return callMcpTool(tool, args);
});

// Handler genérico (echo)
taskEngine.registerHandler('generic', async (task) => {
  return { received: task.description, input: task.input };
});

// Log de eventos do router
router.on('sent', ({ channel, destination }) => {
  console.log(`[router] Enviado via ${channel} para ${destination}`);
});
router.on('queued', ({ destination, id }) => {
  console.log(`[router] Enfileirado ${id} para ${destination}`);
});
router.on('channel-failed', ({ channel, error }) => {
  console.log(`[router] Canal ${channel} falhou: ${error}`);
});

// ─── Monitor / Watchdog ────────────────────────────────────────────────
const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL || '120000', 10); // 2 min
const ALERT_PHONE     = process.env.ALERT_PHONE || '';  // ex: 5511999999999
const SLOW_THRESHOLD  = parseInt(process.env.SLOW_THRESHOLD || '10000', 10); // 10s

const monitorState = {
  status: 'unknown',       // 'ok' | 'degraded' | 'offline'
  lastCheck: null,
  lastOk: null,
  lastError: null,
  errorMessage: null,
  responseTime: null,
  consecutiveFailures: 0,
  alertSent: false,
};

async function sendAlert(message) {
  if (!ALERT_PHONE) {
    console.log(`[monitor] Alerta (sem ALERT_PHONE): ${message}`);
    return;
  }
  // Usa o router — tenta todos os canais disponíveis
  const result = await router.send(ALERT_PHONE, message);
  if (result.ok) {
    console.log(`[monitor] Alerta enviado via ${result.channel}`);
  } else if (result.queued) {
    console.log(`[monitor] Alerta enfileirado (${result.id})`);
  } else {
    console.error(`[monitor] Falha ao enviar alerta: ${JSON.stringify(result.errors)}`);
  }
}

async function runHealthCheck() {
  const start = Date.now();
  monitorState.lastCheck = new Date().toISOString();

  try {
    // 1. Testa o health do Express/gateway
    const healthRes = await proxyFetch(`${GATEWAY_URL}/api/health`, {
      signal: AbortSignal.timeout(15000),
    });

    if (!healthRes.ok) throw new Error(`Health retornou ${healthRes.status}`);
    await healthRes.json();

    // 2. Testa o MCP (é o que costuma cair com 502)
    const mcpRes = await proxyFetch(`${GATEWAY_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'get_status', arguments: {} }),
      signal: AbortSignal.timeout(15000),
    });

    const elapsed = Date.now() - start;
    monitorState.responseTime = elapsed;

    if (!mcpRes.ok) {
      const text = await mcpRes.text();
      const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
      throw new Error(isHtml ? `MCP offline (${mcpRes.status})` : `MCP erro ${mcpRes.status}: ${text.slice(0, 200)}`);
    }

    // 3. Verifica se está lento
    if (elapsed > SLOW_THRESHOLD) {
      monitorState.status = 'degraded';
      monitorState.errorMessage = `Resposta lenta: ${elapsed}ms`;
      monitorState.consecutiveFailures++;

      if (!monitorState.alertSent && monitorState.consecutiveFailures >= 2) {
        monitorState.alertSent = true;
        await sendAlert(`Tulipa lenta — resposta em ${elapsed}ms (limite: ${SLOW_THRESHOLD}ms)`);
      }
      return;
    }

    // Tudo OK
    const wasDown = monitorState.status === 'offline' || monitorState.status === 'degraded';
    monitorState.status = 'ok';
    monitorState.lastOk = monitorState.lastCheck;
    monitorState.errorMessage = null;
    monitorState.consecutiveFailures = 0;

    // Notifica recuperação
    if (wasDown && monitorState.alertSent) {
      monitorState.alertSent = false;
      await sendAlert(`Tulipa voltou ao normal — resposta em ${elapsed}ms`);
    }

  } catch (err) {
    const elapsed = Date.now() - start;
    monitorState.responseTime = elapsed;
    monitorState.status = 'offline';
    monitorState.lastError = monitorState.lastCheck;
    monitorState.errorMessage = err.message;
    monitorState.consecutiveFailures++;

    console.error(`[monitor] Falha #${monitorState.consecutiveFailures}: ${err.message}`);

    // Alerta após 2 falhas consecutivas (evita falso positivo)
    if (!monitorState.alertSent && monitorState.consecutiveFailures >= 2) {
      monitorState.alertSent = true;
      await sendAlert(`Tulipa OFFLINE — ${err.message} (${monitorState.consecutiveFailures} falhas consecutivas)`);
    }
  }
}

// ─── Endpoints ─────────────────────────────────────────────────────────

// Monitor
app.get('/api/monitor', (_req, res) => {
  res.json({
    monitor: monitorState,
    config: {
      interval: MONITOR_INTERVAL,
      alertPhone: ALERT_PHONE ? `***${ALERT_PHONE.slice(-4)}` : '(não configurado)',
      slowThreshold: SLOW_THRESHOLD,
    },
  });
});

// Health proxy
app.get('/api/health', async (_req, res) => {
  try {
    const r = await proxyFetch(`${GATEWAY_URL}/api/health`);
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Gateway indisponível', detail: err.message });
  }
});

// WhatsApp — agora via transport layer
app.get('/api/whatsapp/history', requireAuth, async (req, res) => {
  try {
    const { phone, limit } = req.query;
    const result = await whatsapp.receive(phone, { limit: limit ? parseInt(limit, 10) : undefined });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar histórico', detail: err.message });
  }
});

app.post('/api/whatsapp/send', requireAuth, async (req, res) => {
  try {
    const { phone, message } = req.body;
    if (!phone || !message) {
      return res.status(400).json({ error: 'Campos "phone" e "message" são obrigatórios' });
    }
    // Usa router para fallback automático
    const result = await router.send(phone, message);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar mensagem', detail: err.message });
  }
});

// Status, peers, logs — via callMcpTool direto
app.get('/api/status', async (req, res) => {
  try {
    const data = await callMcpTool('get_status', {}, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar status', detail: err.message });
  }
});

app.get('/api/peers', async (req, res) => {
  try {
    const data = await callMcpTool('list_peers', {}, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao listar peers', detail: err.message });
  }
});

app.get('/api/logs', requireAuth, async (req, res) => {
  try {
    const { limit } = req.query;
    const args = {};
    if (limit) args.limit = parseInt(limit, 10);
    const data = await callMcpTool('get_logs', args, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar logs', detail: err.message });
  }
});

// ─── Transport Layer endpoints ─────────────────────────────────────────

// Estado do router e transports
app.get('/api/transport', (_req, res) => {
  res.json(router.toJSON());
});

// Estado da fila
app.get('/api/queue', (_req, res) => {
  res.json(queue.toJSON());
});

// Health check de todos os canais
app.get('/api/transport/health', async (_req, res) => {
  const results = await router.healthCheckAll();
  res.json(results);
});

// Enviar mensagem via protocolo padronizado
app.post('/api/send', requireAuth, async (req, res) => {
  try {
    const { destination, message, type, payload, channel } = req.body;
    if (!destination) {
      return res.status(400).json({ error: 'Campo "destination" é obrigatório' });
    }

    // Se enviou type/payload, cria mensagem no protocolo
    let msg;
    if (type) {
      msg = protocol.createMessage(type, payload || {}, null, { channel });
    } else if (message) {
      msg = message;
    } else {
      return res.status(400).json({ error: 'Envie "message" ou "type"+"payload"' });
    }

    const result = await router.send(destination, msg, { preferChannel: channel });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar', detail: err.message });
  }
});

// ─── Telegram endpoints ────────────────────────────────────────────────

app.post('/api/telegram/send', requireAuth, async (req, res) => {
  try {
    const { chatId, message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    }
    const dest = chatId || telegram._chatId;
    if (!dest) {
      return res.status(400).json({ error: 'Sem chatId (envie no body ou configure TELEGRAM_CHAT_ID)' });
    }
    const result = await telegram.send(dest, message);
    res.json({ ok: true, channel: 'telegram', result });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar via Telegram', detail: err.message });
  }
});

app.get('/api/telegram/updates', async (req, res) => {
  try {
    const { chatId, limit } = req.query;
    const messages = await telegram.receive(chatId, { limit: limit ? parseInt(limit, 10) : 20 });
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar updates', detail: err.message });
  }
});

// ─── Email endpoints ──────────────────────────────────────────────────

app.post('/api/email/send', requireAuth, async (req, res) => {
  try {
    const { to, subject, body, message } = req.body;
    if (!to) return res.status(400).json({ error: 'Campo "to" é obrigatório' });
    const msg = subject ? { subject, body: body || '' } : (message || body || '');
    if (!msg) return res.status(400).json({ error: 'Envie "message" ou "subject"+"body"' });
    const result = await email.send(to, msg);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar email', detail: err.message });
  }
});

app.get('/api/email/search', async (req, res) => {
  try {
    const { query, from, limit } = req.query;
    const messages = await email.receive(from, { query, limit: limit ? parseInt(limit, 10) : 10 });
    res.json({ ok: true, messages });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar emails', detail: err.message });
  }
});

app.get('/api/email/drafts', async (_req, res) => {
  try {
    const drafts = await email.listDrafts();
    res.json({ ok: true, drafts });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao listar drafts', detail: err.message });
  }
});

// ─── Webhook endpoints ────────────────────────────────────────────────

app.post('/api/webhook/send', requireAuth, async (req, res) => {
  try {
    const { endpoint, url, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    const dest = endpoint || url || webhook._defaultEndpoint;
    if (!dest) return res.status(400).json({ error: 'Envie "endpoint" (nome) ou "url"' });
    const result = await webhook.send(dest, message);
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar webhook', detail: err.message });
  }
});

// Registrar endpoint em runtime
app.post('/api/webhook/endpoints', requireAuth, (req, res) => {
  try {
    const { name, url, headers, format, method } = req.body;
    if (!name || !url) return res.status(400).json({ error: 'Campos "name" e "url" são obrigatórios' });
    webhook.addEndpoint(name, { url, headers, format, method });
    // Se não estava no router, registra agora
    if (!router.get('webhook') && webhook.configured) {
      router.register(webhook);
    }
    res.json({ ok: true, endpoints: webhook.listEndpoints() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/webhook/endpoints', (_req, res) => {
  res.json({ endpoints: webhook.listEndpoints() });
});

app.delete('/api/webhook/endpoints/:name', requireAuth, (req, res) => {
  webhook.removeEndpoint(req.params.name);
  res.json({ ok: true, endpoints: webhook.listEndpoints() });
});

// Receber webhook (incoming) — outros serviços postam aqui
app.post('/api/webhook/incoming/:source', (req, res) => {
  const source = req.params.source;
  const payload = req.body;
  console.log(`[webhook] Incoming de ${source}: ${JSON.stringify(payload).slice(0, 100)}`);
  webhook.emit('incoming', { source, payload });
  res.json({ ok: true, received: true });
});

// ─── Mesh endpoints ───────────────────────────────────────────────────

// Estado do mesh
app.get('/api/mesh', (_req, res) => {
  res.json(mesh.toJSON());
});

// Lista peers do registry local
app.get('/api/mesh/peers', (_req, res) => {
  const { status, capability } = _req.query;
  const filter = {};
  if (status) filter.status = status;
  if (capability) filter.capability = capability;
  res.json({ peers: mesh.registry.list(filter) });
});

// Força discovery agora
app.post('/api/mesh/discover', requireAuth, async (_req, res) => {
  try {
    const peers = await mesh.discover();
    res.json({ ok: true, found: peers.length, registry: mesh.registry.toJSON() });
  } catch (err) {
    res.status(502).json({ error: 'Discovery falhou', detail: err.message });
  }
});

// Ping um peer específico
app.post('/api/mesh/ping/:nodeId', requireAuth, async (req, res) => {
  try {
    const start = Date.now();
    const result = await mesh.pingPeer(req.params.nodeId);
    res.json({ ok: true, latency: Date.now() - start, result });
  } catch (err) {
    res.status(502).json({ error: 'Ping falhou', detail: err.message });
  }
});

// Enviar mensagem para um peer
app.post('/api/mesh/send/:nodeId', requireAuth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    const result = await mesh.sendToPeer(req.params.nodeId, message);
    res.json({ ok: true, result });
  } catch (err) {
    res.status(502).json({ error: 'Envio falhou', detail: err.message });
  }
});

// Heartbeat manual (pinga todos os peers)
app.post('/api/mesh/heartbeat', requireAuth, async (_req, res) => {
  try {
    const results = await mesh.heartbeatAll();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(502).json({ error: 'Heartbeat falhou', detail: err.message });
  }
});

// Proxy genérico MCP
app.post('/api/mcp/:tool', requireAuth, async (req, res) => {
  try {
    const data = await callMcpTool(req.params.tool, req.body, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Falha ao chamar tool "${req.params.tool}"`, detail: err.message });
  }
});

// ─── Service Registry ─────────────────────────────────────────────────
const crypto = require('crypto');

const serviceRegistry = new Map();

// Registra este próprio nó como serviço ao iniciar
function registerSelf() {
  const selfId = protocol.NODE_ID;
  serviceRegistry.set(selfId, {
    nodeId: selfId,
    name: protocol.NODE_NAME,
    services: [{
      name: 'tulipa-api',
      url: `http://localhost:${PORT}`,
      type: 'api',
      version: '4.0',
    }],
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'online',
  });
}

// Listar todos os serviços da rede
app.get('/api/services', (_req, res) => {
  const all = [];
  for (const [nodeId, entry] of serviceRegistry) {
    for (const svc of entry.services) {
      all.push({
        ...svc,
        nodeId,
        nodeName: entry.name,
        status: entry.status,
        registeredAt: entry.registeredAt,
        lastHeartbeat: entry.lastHeartbeat,
      });
    }
  }
  res.json({ services: all, nodes: serviceRegistry.size });
});

// Registrar serviço (outros nós chamam este endpoint para se anunciar)
app.post('/api/services/register', (req, res) => {
  const { nodeId, name, services } = req.body;
  if (!nodeId || !services || !Array.isArray(services)) {
    return res.status(400).json({ error: 'Campos "nodeId" e "services" (array) são obrigatórios' });
  }
  serviceRegistry.set(nodeId, {
    nodeId,
    name: name || nodeId,
    services,
    registeredAt: new Date().toISOString(),
    lastHeartbeat: new Date().toISOString(),
    status: 'online',
  });
  console.log(`[registry] Nó ${name || nodeId} registrou ${services.length} serviço(s)`);
  res.json({ ok: true, registered: services.length });
});

// Heartbeat — nó avisa que ainda está vivo
app.post('/api/services/heartbeat', (req, res) => {
  const { nodeId } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'Campo "nodeId" é obrigatório' });
  const entry = serviceRegistry.get(nodeId);
  if (!entry) return res.status(404).json({ error: 'Nó não registrado' });
  entry.lastHeartbeat = new Date().toISOString();
  entry.status = 'online';
  res.json({ ok: true });
});

// Remover nó do registry
app.delete('/api/services/:nodeId', requireAuth, (req, res) => {
  serviceRegistry.delete(req.params.nodeId);
  res.json({ ok: true });
});

// Sweep: marca como offline nós sem heartbeat há mais de 5 min
const SERVICE_STALE_MS = 5 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  for (const [nodeId, entry] of serviceRegistry) {
    if (nodeId === protocol.NODE_ID) continue; // não limpa a si mesmo
    const age = now - new Date(entry.lastHeartbeat).getTime();
    if (age > SERVICE_STALE_MS) {
      entry.status = 'offline';
    }
  }
}, 60000);

// ─── Deploy Webhook + Auto-update ─────────────────────────────────────
const DEPLOY_SECRET = process.env.DEPLOY_SECRET || '';
const DEPLOY_LOG = [];

function addDeployLog(type, message, details = {}) {
  const entry = {
    id: crypto.randomUUID(),
    type, // 'deploy' | 'webhook' | 'error' | 'notify'
    message,
    details,
    timestamp: new Date().toISOString(),
  };
  DEPLOY_LOG.unshift(entry);
  if (DEPLOY_LOG.length > 50) DEPLOY_LOG.length = 50; // mantém últimos 50
  console.log(`[deploy] ${type}: ${message}`);
  return entry;
}

async function notifyDeploy(message) {
  addDeployLog('notify', message);
  // Notifica via router (WhatsApp, Telegram, etc)
  if (ALERT_PHONE) {
    try {
      await router.send(ALERT_PHONE, `[Deploy] ${message}`);
    } catch (err) {
      console.error(`[deploy] Falha ao notificar: ${err.message}`);
    }
  }
  // Notifica peers registrados
  for (const [nodeId, entry] of serviceRegistry) {
    if (nodeId === protocol.NODE_ID) continue;
    if (entry.status !== 'online') continue;
    for (const svc of entry.services) {
      if (svc.url && svc.type === 'api') {
        try {
          await proxyFetch(`${svc.url}/api/webhook/incoming/deploy`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ source: protocol.NODE_NAME, message, timestamp: new Date().toISOString() }),
            signal: AbortSignal.timeout(5000),
          });
        } catch (_) { /* best effort */ }
      }
    }
  }
}

// Verificar assinatura do GitHub webhook
function verifyGitHubSignature(payload, signature) {
  if (!DEPLOY_SECRET) return true; // sem secret, aceita tudo (dev mode)
  if (!signature) return false;
  const hmac = crypto.createHmac('sha256', DEPLOY_SECRET);
  hmac.update(payload);
  const expected = `sha256=${hmac.digest('hex')}`;
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// GitHub webhook → auto-deploy
app.post('/api/deploy/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const signature = req.headers['x-hub-signature-256'];
  const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

  if (DEPLOY_SECRET && !verifyGitHubSignature(rawBody, signature)) {
    addDeployLog('error', 'Assinatura inválida no webhook');
    return res.status(403).json({ error: 'Assinatura inválida' });
  }

  let payload;
  try {
    payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    payload = {};
  }

  const ref = payload.ref || '';
  const pusher = payload.pusher?.name || 'unknown';
  const commits = payload.commits?.length || 0;

  addDeployLog('webhook', `Push de ${pusher}: ${commits} commit(s) em ${ref}`);

  // Executa deploy via shell
  const { execFile } = require('child_process');
  const deployScript = require('path').join(__dirname, 'deploy.sh');

  execFile('bash', [deployScript], { timeout: 60000 }, async (err, stdout, stderr) => {
    if (err) {
      addDeployLog('error', `Deploy falhou: ${err.message}`, { stdout, stderr });
      await notifyDeploy(`FALHOU — ${err.message}`);
      return;
    }
    addDeployLog('deploy', `Deploy OK — ${commits} commit(s) de ${pusher}`, { stdout });
    await notifyDeploy(`OK — ${commits} commit(s) de ${pusher} em ${ref}`);
  });

  res.json({ ok: true, message: 'Deploy iniciado' });
});

// Deploy manual (trigger via API)
app.post('/api/deploy/trigger', requireAuth, async (req, res) => {
  const { execFile } = require('child_process');
  const deployScript = require('path').join(__dirname, 'deploy.sh');

  addDeployLog('deploy', 'Deploy manual iniciado');

  execFile('bash', [deployScript], { timeout: 60000 }, async (err, stdout, stderr) => {
    if (err) {
      addDeployLog('error', `Deploy manual falhou: ${err.message}`, { stdout, stderr });
      await notifyDeploy(`Deploy manual FALHOU — ${err.message}`);
      return;
    }
    addDeployLog('deploy', 'Deploy manual OK', { stdout });
    await notifyDeploy('Deploy manual concluído com sucesso');
  });

  res.json({ ok: true, message: 'Deploy manual iniciado' });
});

// Log de deploys
app.get('/api/deploy/log', (_req, res) => {
  res.json({ log: DEPLOY_LOG });
});

// Deploy remoto via run_command (para deployar no Android)
app.post('/api/deploy/remote', requireAuth, async (req, res) => {
  try {
    const { target, commands } = req.body;
    if (!commands || !Array.isArray(commands)) {
      return res.status(400).json({ error: 'Campo "commands" (array de strings) é obrigatório' });
    }

    const results = [];
    for (const cmd of commands) {
      try {
        const result = await callMcpTool('run_command', { command: cmd }, req);
        results.push({ command: cmd, ok: true, result });
        addDeployLog('deploy', `Comando remoto OK: ${cmd}`);
      } catch (err) {
        results.push({ command: cmd, ok: false, error: err.message });
        addDeployLog('error', `Comando remoto falhou: ${cmd} — ${err.message}`);
      }
    }

    const allOk = results.every(r => r.ok);
    if (allOk) {
      await notifyDeploy(`Deploy remoto${target ? ` em ${target}` : ''} — ${commands.length} comando(s) executados`);
    }

    res.json({ ok: allOk, results });
  } catch (err) {
    res.status(502).json({ error: 'Deploy remoto falhou', detail: err.message });
  }
});

// ─── Task Engine endpoints ──────────────────────────────────────────

app.get('/api/tasks', requireAuth, (_req, res) => {
  const { status } = _req.query;
  if (status) {
    res.json({ tasks: storage.getTasksByStatus(status) });
  } else {
    res.json({ stats: storage.getTaskStats(), tasks: taskEngine.toJSON() });
  }
});

app.post('/api/tasks', requireAuth, (req, res) => {
  const { description, type, input, priority, assignedTo } = req.body;
  if (!description) return res.status(400).json({ error: 'Campo "description" é obrigatório' });
  const task = taskEngine.submit(description, { type, input, priority, assignedTo });
  res.json({ ok: true, task });
});

app.post('/api/tasks/:id/decompose', requireAuth, (req, res) => {
  const { subtasks } = req.body;
  if (!subtasks || !Array.isArray(subtasks)) {
    return res.status(400).json({ error: 'Campo "subtasks" (array) é obrigatório' });
  }
  const created = taskEngine.decompose(req.params.id, subtasks);
  res.json({ ok: true, created: created.length, subtasks: created });
});

app.post('/api/tasks/:id/delegate', requireAuth, async (req, res) => {
  try {
    const { nodeId } = req.body;
    const target = nodeId || taskEngine.autoAssign(req.params.id);
    if (!target) return res.status(400).json({ error: 'Nenhum peer disponível para delegação' });
    const result = await taskEngine.delegate(req.params.id, target);
    res.json({ ok: true, nodeId: target, result });
  } catch (err) {
    res.status(502).json({ error: 'Delegação falhou', detail: err.message });
  }
});

app.get('/api/tasks/:id', requireAuth, (req, res) => {
  const task = storage.getTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task não encontrada' });
  const subtasks = storage.getSubtasks(req.params.id);
  res.json({ task, subtasks });
});

// ─── Identity endpoints ────────────────────────────────────────────

app.get('/api/identity', (_req, res) => {
  res.json(identity.exportPublicKey());
});

app.post('/api/identity/sign', requireAuth, (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Campo "data" é obrigatório' });
  const signature = identity.sign(data);
  res.json({ signature, signerKey: identity.publicKey, fingerprint: identity.fingerprint });
});

app.post('/api/identity/verify', (req, res) => {
  const { data, signature, publicKey } = req.body;
  if (!data || !signature || !publicKey) {
    return res.status(400).json({ error: 'Campos "data", "signature" e "publicKey" são obrigatórios' });
  }
  const valid = Identity.verify(data, signature, publicKey);
  res.json({ valid });
});

// ─── Storage / Search endpoints ──────────────────────────────────────

app.get('/api/storage/stats', (_req, res) => {
  res.json(storage.stats);
});

app.get('/api/messages/search', requireAuth, (req, res) => {
  const { q, limit } = req.query;
  if (!q) return res.status(400).json({ error: 'Query param "q" é obrigatório' });
  const results = storage.searchMessages(q, limit ? parseInt(limit, 10) : 50);
  res.json({ results, count: results.length });
});

// ─── Audit Log endpoint ────────────────────────────────────────────

app.get('/api/audit', requireAuth, (req, res) => {
  const { event, source, since, limit } = req.query;
  const logs = storage.getAuditLog({
    event, source, since,
    limit: limit ? parseInt(limit, 10) : 100,
  });
  res.json({ logs, count: logs.length });
});

// ─── Startup ───────────────────────────────────────────────────────────

let monitorTimer = null;
function startMonitor() {
  if (!MONITOR_INTERVAL || MONITOR_INTERVAL < 10000) return;
  console.log(`[monitor] Watchdog ativo — check a cada ${MONITOR_INTERVAL / 1000}s`);
  if (ALERT_PHONE) console.log(`[monitor] Alertas para ***${ALERT_PHONE.slice(-4)}`);
  else console.log('[monitor] ALERT_PHONE não configurado — alertas somente no console');

  setTimeout(() => {
    runHealthCheck();
    monitorTimer = setInterval(runHealthCheck, MONITOR_INTERVAL);
  }, 10000);
}

app.listen(PORT, () => {
  console.log(`\nTulipa API v5.0 — SQLite + Tasks + Identity + Mesh`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log(`Node: ${protocol.NODE_ID} (${protocol.NODE_NAME})`);
  console.log(`\nTransports: ${[...router._transports.keys()].join(', ')}`);
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

  // Email endpoints
  if (email.configured) {
    console.log('  POST /api/email/send');
    console.log('  GET  /api/email/search');
    console.log('  GET  /api/email/drafts');
  } else {
    console.log('\n  Email: disponível via Gmail MCP');
  }

  // Webhook endpoints
  console.log('  POST /api/webhook/send');
  console.log('  POST /api/webhook/endpoints      — registrar endpoint');
  console.log('  GET  /api/webhook/endpoints       — listar endpoints');
  console.log('  POST /api/webhook/incoming/:src   — receber webhook');
  if (webhook.configured) {
    console.log(`  Webhooks configurados: ${[...webhook._endpoints.keys()].join(', ')}`);
  }

  // Telegram endpoints (só mostra se configurado)
  if (telegram.configured) {
    console.log('  POST /api/telegram/send');
    console.log('  GET  /api/telegram/updates');
    telegram.startPolling((msg) => {
      console.log(`[telegram] Mensagem de ${msg.from}: ${msg.text.slice(0, 50)}`);
    });
  } else {
    console.log('\n  Telegram: não configurado (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID)');
  }

  // Mesh endpoints
  console.log('\n  Mesh:');
  console.log('  GET  /api/mesh               — estado do mesh');
  console.log('  GET  /api/mesh/peers          — peers conhecidos');
  console.log('  POST /api/mesh/discover       — forçar discovery');
  console.log('  POST /api/mesh/ping/:nodeId   — ping peer');
  console.log('  POST /api/mesh/send/:nodeId   — enviar para peer');
  console.log('  POST /api/mesh/heartbeat      — pingar todos');

  // Service Registry + Deploy
  console.log('\n  Services:');
  console.log('  GET  /api/services            — listar serviços da rede');
  console.log('  POST /api/services/register   — registrar nó/serviço');
  console.log('  POST /api/services/heartbeat  — heartbeat de nó');
  console.log('\n  Deploy:');
  console.log('  POST /api/deploy/webhook      — GitHub webhook auto-deploy');
  console.log('  POST /api/deploy/trigger      — deploy manual');
  console.log('  POST /api/deploy/remote       — deploy remoto via run_command');
  console.log('  GET  /api/deploy/log          — log de deploys');

  // Task Engine
  console.log('\n  Tasks:');
  console.log('  GET  /api/tasks               — listar tarefas');
  console.log('  POST /api/tasks               — criar tarefa');
  console.log('  GET  /api/tasks/:id           — detalhe da tarefa');
  console.log('  POST /api/tasks/:id/decompose — decompor em subtarefas');
  console.log('  POST /api/tasks/:id/delegate  — delegar para peer');

  // Identity
  console.log('\n  Identity:');
  console.log('  GET  /api/identity            — chave pública + fingerprint');
  console.log('  POST /api/identity/sign       — assinar dados');
  console.log('  POST /api/identity/verify     — verificar assinatura');
  console.log(`  Fingerprint: ${identity.fingerprint}`);

  // Storage
  console.log('\n  Storage:');
  console.log('  GET  /api/storage/stats       — estatísticas do banco');
  console.log('  GET  /api/messages/search     — buscar mensagens');
  console.log('  GET  /api/audit               — log de auditoria');

  // Registra este nó no service registry
  registerSelf();

  // Inicia mesh (discovery + heartbeat)
  mesh.start().catch(err => {
    console.error(`[mesh] Falha ao iniciar: ${err.message}`);
  });

  // Inicia task engine
  taskEngine.start();

  startMonitor();
  queue.start(5000);

  // Log audit de startup
  storage.log('system.startup', protocol.NODE_ID, null, {
    version: '5.0',
    transports: [...router._transports.keys()],
    fingerprint: identity.fingerprint,
  });
});
