const express = require('express');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// ─── Transport Layer ───────────────────────────────────────────────────
const WhatsAppTransport = require('./lib/transport/whatsapp');
const TelegramTransport = require('./lib/transport/telegram');
const EmailTransport = require('./lib/transport/email');
const WebhookTransport = require('./lib/transport/webhook');
const MessageQueue = require('./lib/queue');
const Router = require('./lib/router');
const MeshManager = require('./lib/mesh');
const protocol = require('./lib/protocol');
const Ledger = require('./lib/ledger/ledger');
const receiptLib = require('./lib/ledger/receipt');
const createLocalTools = require('./lib/local-tools');
const capabilitiesLib = require('./lib/capabilities');
const { requireScope, resolveScopes } = require('./lib/middleware/scope-guard');
const { InfraScanner } = require('./lib/infra/scanner');
const InfraAdopter = require('./lib/infra/adopt');
const SSHTaskRunner = require('./lib/infra/ssh-task');
const { CanaryRunner } = require('./lib/infra/canary');
const OrgRegistry = require('./lib/org/org-registry');

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

// Extrai token do header Authorization do request
function getRequestToken(req) {
  const auth = req?.get?.('authorization') || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

// Middleware de autenticação — requer Bearer token válido no request
function requireAuth(req, res, next) {
  const token = getRequestToken(req);
  if (!token) {
    return res.status(401).json({ error: 'Authorization required — envie header Authorization: Bearer <token>' });
  }
  if (API_TOKEN && token !== API_TOKEN) {
    return res.status(403).json({ error: 'Token inválido' });
  }
  next();
}

app.use(express.json());
app.use(express.static('public'));

// ─── Helper: chama MCP tool no gateway (com retry para 502/503) ──────
let _mcpCallId = 0;
const MCP_MAX_RETRIES = 3;
const MCP_RETRY_DELAYS = [2000, 4000, 8000]; // backoff exponencial

async function callMcpTool(tool, args = {}, req = null) {
  let lastError;

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
        const err = new Error(detail);
        err.statusCode = res.status;
        throw err;
      }

      const json = await res.json();

      // JSON-RPC 2.0: desembrulha result/error
      if (json.jsonrpc === '2.0') {
        if (json.error) {
          throw new Error(`MCP error ${json.error.code}: ${json.error.message}`);
        }
        return json.result;
      }

      return json;

    } catch (err) {
      lastError = err;
      const retryable = err.statusCode === 502 || err.statusCode === 503 || err.code === 'UND_ERR_CONNECT_TIMEOUT' || err.name === 'TimeoutError';

      if (retryable && attempt < MCP_MAX_RETRIES) {
        const delay = MCP_RETRY_DELAYS[attempt] || 8000;
        console.log(`[mcp] ${tool} falhou (${err.message}), retry ${attempt + 1}/${MCP_MAX_RETRIES} em ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastError;
}

// ─── Inicializa Transport Layer ────────────────────────────────────────
const queue = new MessageQueue({
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

// ─── Ledger Layer ─────────────────────────────────────────────────────
const ledger = new Ledger({
  nodeId: protocol.NODE_ID,
  dataDir: process.env.LEDGER_DIR || './data/ledger',
});

// ─── Mesh Layer ───────────────────────────────────────────────────────
const mesh = new MeshManager({
  router,
  callMcpTool,
  fetch: proxyFetch,
  ledger,
  discoveryInterval: parseInt(process.env.MESH_DISCOVERY_INTERVAL || '120000', 10),
  heartbeatInterval: parseInt(process.env.MESH_HEARTBEAT_INTERVAL || '60000', 10),
});

// ─── Infra Layer ──────────────────────────────────────────────────────
const infraScanner = new InfraScanner({
  fetch: proxyFetch,
  subnets: (process.env.SCAN_SUBNETS || '192.168.1,192.168.15,10.0.0').split(','),
  timeout: parseInt(process.env.SCAN_TIMEOUT || '3000', 10),
});
const infraAdopter = new InfraAdopter({
  registry: mesh.registry,
  trust: mesh.trust,
  fetch: proxyFetch,
});

infraScanner.on('discovered', (svc) => {
  console.log(`[infra] Descoberto: ${svc.type} em ${svc.endpoint} (v${svc.version})`);
});
infraAdopter.on('adopted', ({ nodeId, type, endpoint }) => {
  console.log(`[infra] Adotado: ${type} como ${nodeId} (${endpoint})`);
});

const canary = new CanaryRunner({
  mesh,
  ledger,
  ownerNode: process.env.OWNER_NODE || null,
  notify: async (nodeId, message) => {
    console.log(`[canary] Notificação: ${message}`);
    // Se WhatsApp configurado, enviar alerta
    if (process.env.ALERT_PHONE) {
      try { await callMcpTool('send_whatsapp', { to: process.env.ALERT_PHONE, message }); } catch {}
    }
  },
});

// ─── Org Layer ────────────────────────────────────────────────────────
const orgRegistry = new OrgRegistry({
  dataDir: process.env.LEDGER_DIR || './data',
  trust: mesh.trust,
});

// ─── Scope Resolution (popula req.grantedScopes) ─────────────────────
app.use(resolveScopes({
  resolveToken: getRequestToken,
  masterToken: API_TOKEN,
  mesh,
}));

// ─── Local MCP Tools ──────────────────────────────────────────────────
const localTools = createLocalTools({ ledger, mesh, protocol });

mesh.on('peer-joined', (peer) => {
  console.log(`[mesh] Novo peer: ${peer.name} — canais: ${peer.channels.join(', ') || 'nenhum'}`);
});
mesh.on('peer-left', (peer) => {
  console.log(`[mesh] Peer saiu: ${peer.name}`);
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
const fs = require('fs');
const path = require('path');

const MONITOR_INTERVAL = parseInt(process.env.MONITOR_INTERVAL || '120000', 10); // 2 min
const ALERT_PHONE     = process.env.ALERT_PHONE || '';  // ex: 5511999999999
const SLOW_THRESHOLD  = parseInt(process.env.SLOW_THRESHOLD || '10000', 10); // 10s
const MONITOR_STATE_PATH = path.join(__dirname, 'data', 'monitor-state.json');

function loadMonitorState() {
  const defaults = {
    status: 'unknown',
    lastCheck: null,
    lastOk: null,
    lastError: null,
    errorMessage: null,
    responseTime: null,
    consecutiveFailures: 0,
    alertSent: false,
  };
  try {
    if (fs.existsSync(MONITOR_STATE_PATH)) {
      const saved = JSON.parse(fs.readFileSync(MONITOR_STATE_PATH, 'utf-8'));
      return { ...defaults, ...saved };
    }
  } catch { /* usa defaults */ }
  return defaults;
}

function saveMonitorState() {
  try {
    const dir = path.dirname(MONITOR_STATE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(MONITOR_STATE_PATH, JSON.stringify(monitorState, null, 2));
  } catch { /* best effort */ }
}

const monitorState = loadMonitorState();

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
      headers: authHeaders(),
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 0,
        params: { name: 'get_status', arguments: {} },
      }),
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
      saveMonitorState();
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

    saveMonitorState();

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

    saveMonitorState();
  }
}

// ─── Endpoints ─────────────────────────────────────────────────────────

// Build info (público, para verificar versão deployada)
app.get('/api/build-info', (_req, res) => {
  try {
    const info = require('./build-info.json');
    res.json(info);
  } catch {
    res.json({ version: 'unknown', error: 'build-info.json não encontrado' });
  }
});

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

// Enviar prompt para um peer (o peer processa via Claude e retorna resposta)
app.post('/api/mesh/prompt/:nodeId', requireAuth, async (req, res) => {
  try {
    const { prompt, text, system_prompt, model, timeout } = req.body;
    const promptText = prompt || text;
    if (!promptText) return res.status(400).json({ error: 'Campo "prompt" ou "text" é obrigatório' });
    const result = await mesh.sendPrompt(req.params.nodeId, promptText, {
      systemPrompt: system_prompt,
      model,
      timeoutMs: timeout || 30000,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: 'Prompt falhou', detail: err.message });
  }
});

// Solicitar admin token de um peer (para gerenciamento remoto)
app.post('/api/mesh/admin-token/:nodeId', requireAuth, async (req, res) => {
  try {
    const { admin_token } = req.body;
    const result = await mesh.requestAdminToken(req.params.nodeId, {
      adminToken: admin_token,
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(502).json({ error: 'Falha ao obter admin token', detail: err.message });
  }
});

// ─── Network / Trust Routes (Sprint 6) ────────────────────────────────

// Lista pública de peers — sem tokens, sem auth. Para crawlers de outros nós.
app.get('/api/network/peers/public', (_req, res) => {
  res.json({ peers: mesh.getPublicPeerList() });
});

// Trust graph do nó
app.get('/api/network/trust', requireAuth, (_req, res) => {
  res.json(mesh.trust.toJSON());
});

// Ranking de delegação por skill
app.get('/api/network/rank/:skill', requireAuth, (req, res) => {
  const eligibleOnly = req.query.all !== 'true';
  const ranking = mesh.queryBySkill(req.params.skill, { eligibleOnly });
  res.json({ skill: req.params.skill, ranking });
});

// Crawl da rede (BFS)
app.post('/api/network/crawl', requireAuth, async (_req, res) => {
  try {
    const result = await mesh.crawlNetwork({ force: true });
    res.json({
      ok: true,
      total: result.total,
      crawled: result.crawled,
      hops: result.hops,
      errors: result.errors,
      cached: result.cached || false,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Crawler cache info
app.get('/api/network/crawl', (_req, res) => {
  res.json(mesh.crawler.cacheInfo());
});

// ─── Federation Routes (Sprint 7) ─────────────────────────────────────

// Busca federada por skill na rede
app.post('/api/network/query', async (req, res) => {
  const { skill, queryId, hopsRemaining, originNode } = req.body;
  if (!skill) return res.status(400).json({ error: 'Campo "skill" é obrigatório' });

  try {
    const result = await mesh.federation.query(skill, { queryId, hopsRemaining, originNode });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Relay de task via este hub
app.post('/api/network/relay', requireAuth, async (req, res) => {
  const { targetNodeId, prompt, skill, originNode } = req.body;
  if (!targetNodeId || !prompt) {
    return res.status(400).json({ error: 'Campos "targetNodeId" e "prompt" são obrigatórios' });
  }

  try {
    const result = await mesh.sendPrompt(targetNodeId, prompt, { skill });
    res.json({
      ok: true,
      relayedVia: protocol.NODE_ID,
      originNode,
      targetNodeId,
      response: result.response,
      model: result.model,
      method: result.method,
    });
  } catch (err) {
    res.status(502).json({ error: `Relay falhou: ${err.message}` });
  }
});

// Estatísticas da federação (rate limits, queries recentes)
app.get('/api/network/federation', (_req, res) => {
  res.json(mesh.federation.stats());
});

// ─── Capabilities Routes (Sprint 3) ───────────────────────────────────

// Capabilities deste nó (configuráveis via env ou hardcoded para v0.4.0)
const NODE_CAPABILITIES = (process.env.NODE_CAPABILITIES || 'chat,monitoring,deploy,relay,whatsapp,telegram,email,calendar').split(',').map(s => s.trim()).filter(Boolean);

// GET /api/infra — público, sem auth. O que este nó oferece em infra.
app.get('/api/infra', (_req, res) => {
  const infra = capabilitiesLib.filterByCategory(NODE_CAPABILITIES, 'infra');
  res.json({
    nodeId: protocol.NODE_ID,
    nodeName: protocol.NODE_NAME,
    category: 'infra',
    capabilities: capabilitiesLib.enrich(infra),
    peers: mesh.registry.online().map(p => ({
      nodeId: p.nodeId,
      name: p.name,
      infra: capabilitiesLib.filterByCategory(p.capabilities, 'infra'),
    })),
  });
});

// GET /api/knowledge — catálogo completo, filtrado por scopes do requester.
app.get('/api/knowledge', requireAuth, (req, res) => {
  const scopes = req.grantedScopes || [];
  const accessible = capabilitiesLib.accessibleCapabilities(NODE_CAPABILITIES, scopes);

  res.json({
    nodeId: protocol.NODE_ID,
    nodeName: protocol.NODE_NAME,
    grantedScopes: scopes,
    capabilities: capabilitiesLib.enrich(accessible),
    restricted: NODE_CAPABILITIES.filter(c => !accessible.includes(c)).map(c => ({
      name: c,
      category: capabilitiesLib.classify(c),
      scope: capabilitiesLib.requiredScope(c),
      reason: 'Scope não autorizado',
    })),
    peers: mesh.registry.online().map(p => ({
      nodeId: p.nodeId,
      name: p.name,
      capabilities: capabilitiesLib.enrich(
        capabilitiesLib.accessibleCapabilities(p.capabilities, scopes)
      ),
    })),
  });
});

// GET /api/capabilities — classificação de todas as capabilities conhecidas
app.get('/api/capabilities', (_req, res) => {
  res.json({
    node: capabilitiesLib.enrich(NODE_CAPABILITIES),
    known: capabilitiesLib.KNOWN_CAPABILITIES,
    scopes: capabilitiesLib.DATA_SCOPES,
  });
});

// ─── Local MCP Tools Routes ───────────────────────────────────────────

// Listar tools locais disponíveis
app.get('/api/local-tools', (req, res) => {
  res.json({ tools: localTools.list() });
});

// Chamar tool local via JSON-RPC 2.0 (mesma interface do gateway /mcp)
app.post('/api/local-mcp', (req, res) => {
  const { jsonrpc, method, id, params } = req.body;
  if (jsonrpc !== '2.0' || method !== 'tools/call') {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  const result = localTools.handle(params?.name, params?.arguments || {});
  if (!result) {
    return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Tool '${params?.name}' não encontrada` } });
  }

  res.json({ jsonrpc: '2.0', id, result });
});

// ─── Infra Routes (Sprint 4) ──────────────────────────────────────────

// Scan de endpoints específicos
app.post('/api/infra/scan', requireAuth, async (req, res) => {
  const { endpoints, subnets } = req.body;
  try {
    let results;
    if (endpoints && endpoints.length > 0) {
      results = await infraScanner.scanEndpoints(endpoints);
    } else {
      results = await infraScanner.scanSubnets({ subnets });
    }
    res.json({ found: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Scan de um host específico
app.post('/api/infra/scan/:ip', requireAuth, async (req, res) => {
  try {
    const results = await infraScanner.scanHost(req.params.ip);
    res.json({ ip: req.params.ip, found: results.length, results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Último scan realizado
app.get('/api/infra/scan', (_req, res) => {
  res.json(infraScanner.getLastScan() || { message: 'Nenhum scan realizado' });
});

// Adotar serviço descoberto
app.post('/api/infra/adopt', requireAuth, (req, res) => {
  const { discovered, credentials } = req.body;
  if (!discovered || !discovered.type || !discovered.endpoint) {
    return res.status(400).json({ error: 'Campo "discovered" com type e endpoint é obrigatório' });
  }

  try {
    const result = infraAdopter.adopt(discovered, credentials);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Listar serviços adotados
app.get('/api/infra/adopted', requireAuth, (_req, res) => {
  res.json({ services: infraAdopter.list() });
});

// Testar conectividade de serviço adotado
app.post('/api/infra/test/:nodeId', requireAuth, async (req, res) => {
  try {
    const result = await infraAdopter.test(req.params.nodeId);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Remover serviço adotado
app.delete('/api/infra/adopted/:nodeId', requireAuth, (req, res) => {
  infraAdopter.remove(req.params.nodeId);
  res.json({ ok: true, removed: req.params.nodeId });
});

// Executar comando SSH via task
app.post('/api/infra/ssh/:nodeId', requireAuth, async (req, res) => {
  const { command, commands } = req.body;
  const peer = mesh.registry.get(req.params.nodeId);
  if (!peer?.metadata?.isInfra) {
    return res.status(404).json({ error: 'Peer não é um serviço de infra adotado' });
  }

  const ssh = new SSHTaskRunner({
    host: peer.metadata.ip,
    port: peer.metadata.port === 22 ? 22 : undefined,
    user: req.body.user || 'root',
    keyPath: req.body.keyPath,
    timeout: req.body.timeout,
  });

  try {
    if (commands && Array.isArray(commands)) {
      const results = await ssh.executeMany(commands, { stopOnError: req.body.stopOnError });
      res.json({ results });
    } else if (command) {
      const result = await ssh.execute(command);
      res.json(result);
    } else {
      res.status(400).json({ error: 'Campo "command" ou "commands" é obrigatório' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Org Routes (Sprint 9) ────────────────────────────────────────────

// Criar org
app.post('/api/org', requireAuth, (req, res) => {
  const { name, policies } = req.body;
  if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório' });

  const createdBy = req.peer?.nodeId || protocol.NODE_ID;
  const org = orgRegistry.create(name, createdBy, policies);
  orgRegistry.save();
  res.json(org.toJSON());
});

// Listar orgs (opcionalmente filtrar por member)
app.get('/api/org', requireAuth, (req, res) => {
  const orgs = orgRegistry.list({ member: req.query.member });
  res.json({ orgs: orgs.map(o => o.toJSON()) });
});

// Detalhes de uma org
app.get('/api/org/:orgId', requireAuth, (req, res) => {
  const org = orgRegistry.get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Org não encontrada' });
  res.json({
    ...org.toJSON(),
    reputation: orgRegistry.getOrgReputation(org.id),
  });
});

// Convidar membro
app.post('/api/org/:orgId/invite', requireAuth, (req, res) => {
  const { nodeId, role } = req.body;
  if (!nodeId) return res.status(400).json({ error: 'Campo "nodeId" é obrigatório' });

  const org = orgRegistry.get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Org não encontrada' });

  try {
    const invitedBy = req.peer?.nodeId || protocol.NODE_ID;
    const result = org.invite(nodeId, invitedBy, role);
    orgRegistry.save();
    res.json(result);
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// Aceitar convite
app.post('/api/org/:orgId/accept', requireAuth, (req, res) => {
  const org = orgRegistry.get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Org não encontrada' });

  try {
    const nodeId = req.body.nodeId || req.peer?.nodeId || protocol.NODE_ID;
    const result = org.acceptInvite(nodeId);
    orgRegistry.save();
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Atualizar políticas
app.put('/api/org/:orgId/policies', requireAuth, (req, res) => {
  const org = orgRegistry.get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Org não encontrada' });

  try {
    const changedBy = req.peer?.nodeId || protocol.NODE_ID;
    const policies = org.updatePolicies(req.body, changedBy);
    orgRegistry.save();
    res.json({ policies });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// Remover membro
app.delete('/api/org/:orgId/member/:nodeId', requireAuth, (req, res) => {
  const org = orgRegistry.get(req.params.orgId);
  if (!org) return res.status(404).json({ error: 'Org não encontrada' });

  try {
    const removedBy = req.peer?.nodeId || protocol.NODE_ID;
    org.removeMember(req.params.nodeId, removedBy);
    orgRegistry.save();
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// Reputação cross-hub de um agente
app.get('/api/org/reputation/:nodeId', (_req, res) => {
  const boost = orgRegistry.getTrustBoost(_req.params.nodeId);
  const orgs = orgRegistry.getPublicOrgInfo(_req.params.nodeId);
  res.json({ nodeId: _req.params.nodeId, trustBoost: boost, orgs });
});

// Deletar org
app.delete('/api/org/:orgId', requireAuth, (req, res) => {
  try {
    const removedBy = req.peer?.nodeId || protocol.NODE_ID;
    orgRegistry.remove(req.params.orgId, removedBy);
    res.json({ ok: true });
  } catch (err) {
    res.status(403).json({ error: err.message });
  }
});

// ─── Canary Routes (Sprint 5) ─────────────────────────────────────────

// Iniciar canary test
app.post('/api/canary/start', requireAuth, async (req, res) => {
  const { version, repo, branch, testCommands, preferNode } = req.body;
  if (!version || !repo) {
    return res.status(400).json({ error: 'Campos "version" e "repo" são obrigatórios' });
  }

  try {
    const run = await canary.start({ version, repo, branch, testCommands, preferNode });
    res.json(run);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Status de um canary run
app.get('/api/canary/:runId', requireAuth, (req, res) => {
  const run = canary.getRun(req.params.runId);
  if (!run) return res.status(404).json({ error: 'Run não encontrado' });
  res.json(run);
});

// Listar canary runs
app.get('/api/canary', requireAuth, (req, res) => {
  const runs = canary.listRuns({ state: req.query.state, version: req.query.version });
  res.json({ runs });
});

// Aprovar ou rejeitar promoção
app.post('/api/canary/:runId/approve', requireAuth, (req, res) => {
  const { approved, reason } = req.body;
  if (typeof approved !== 'boolean') {
    return res.status(400).json({ error: 'Campo "approved" (boolean) é obrigatório' });
  }

  try {
    const run = canary.approve(req.params.runId, approved, reason);
    res.json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Economy Dashboard (Sprint 8) ─────────────────────────────────────
const { generateDashboard, verifyAsThirdParty } = require('./lib/ledger/dashboard');

// Dashboard consolidado: saldo, top contribuidores, skills, peers
app.get('/api/economy/dashboard', requireAuth, (_req, res) => {
  const data = generateDashboard({
    ledger,
    trust: mesh.trust,
    registry: mesh.registry,
    nodeId: protocol.NODE_ID,
  });
  res.json(data);
});

// Verificação de receipt como terceiro (disputas)
app.post('/api/economy/dispute', requireAuth, (req, res) => {
  const { receipt: rcpt } = req.body;
  if (!rcpt) return res.status(400).json({ error: 'Campo "receipt" é obrigatório' });

  const result = verifyAsThirdParty(rcpt, {
    registry: mesh.registry,
    receiptLib,
  });
  res.json(result);
});

// Ranking econômico dos peers (trust × reputation × saldo)
app.get('/api/economy/ranking', requireAuth, (req, res) => {
  const skill = req.query.skill;
  const peers = skill
    ? mesh.registry.list({ capability: skill })
    : mesh.registry.list();

  const ranking = mesh.trust.rankForDelegation(peers, {
    skill,
    ledger,
  });
  res.json({ skill: skill || 'all', ranking });
});

// ─── Ledger Routes ────────────────────────────────────────────────────

// Resumo do ledger (saldo, totais, por skill/peer)
app.get('/api/ledger', (req, res) => {
  res.json(ledger.getSummary());
});

// Saldo atual
app.get('/api/ledger/balance', (req, res) => {
  res.json(ledger.getBalance());
});

// Listar receipts (com filtros: ?peer=X&skill=Y&since=Z&limit=N)
app.get('/api/ledger/receipts', (req, res) => {
  const receipts = ledger.getReceipts({
    peer: req.query.peer,
    skill: req.query.skill,
    since: req.query.since,
    limit: req.query.limit ? parseInt(req.query.limit, 10) : undefined,
  });
  res.json({ count: receipts.length, receipts });
});

// Verificar um receipt (aceita receipt no body + public keys opcionais)
app.post('/api/ledger/verify', (req, res) => {
  const { receipt: rcpt, fromPublicKey, toPublicKey } = req.body;
  if (!rcpt) return res.status(400).json({ error: 'Campo "receipt" é obrigatório' });

  // Tenta buscar public keys do registry se não fornecidas
  const fromKey = fromPublicKey || mesh.registry.get(rcpt.from)?.metadata?.publicKey;
  const toKey = toPublicKey || mesh.registry.get(rcpt.to)?.metadata?.publicKey;

  const result = receiptLib.verifyReceipt(rcpt, { fromPublicKey: fromKey, toPublicKey: toKey });
  res.json(result);
});

// Saldo com um peer específico
app.get('/api/ledger/peer/:nodeId', (req, res) => {
  const balance = ledger.getPeerBalance(req.params.nodeId);
  const receipts = ledger.getReceipts({ peer: req.params.nodeId });
  res.json({
    peerId: req.params.nodeId,
    balance,
    receipts: receipts.length,
    recent: receipts.slice(-5),
  });
});

// Registrar ou atualizar endpoint de um peer
app.post('/api/mesh/peers/:nodeId', (req, res) => {
  try {
    const { endpoint, name, capabilities, channels } = req.body;
    const info = {};
    if (endpoint) info.endpoint = endpoint;
    if (name) info.name = name;
    if (capabilities) info.capabilities = capabilities;
    if (channels) info.channels = channels;
    const peer = mesh.registry.upsert(req.params.nodeId, info);
    res.json({ ok: true, peer });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Receber mensagem de outro peer (endpoint P2P)
app.post('/api/mesh/incoming', (req, res) => {
  try {
    const { from, message } = req.body;
    if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
    const parsed = mesh.handleMessage(message);
    if (parsed) {
      console.log(`[mesh] Mensagem recebida de ${from || 'unknown'}: ${parsed.type}`);
      res.json({ ok: true, type: parsed.type, id: parsed.id });
    } else {
      res.json({ ok: false, error: 'Mensagem inválida ou não reconhecida' });
    }
  } catch (err) {
    res.status(400).json({ error: err.message });
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

// ─── Startup ───────────────────────────────────────────────────────────

let monitorTimer = null;
function startMonitor() {
  if (!MONITOR_INTERVAL || MONITOR_INTERVAL < 10000) return;
  console.log(`[monitor] Watchdog ativo — check a cada ${MONITOR_INTERVAL / 1000}s`);
  if (ALERT_PHONE) {
    const channels = [...router._transports.keys()].join(' → ');
    console.log(`[monitor] Alertas para ***${ALERT_PHONE.slice(-4)} via ${channels} (fallback automático)`);
  } else {
    console.log('[monitor] ALERT_PHONE não configurado — alertas somente no console');
  }

  setTimeout(() => {
    runHealthCheck();
    monitorTimer = setInterval(runHealthCheck, MONITOR_INTERVAL);
  }, 10000);
}

app.listen(PORT, () => {
  console.log(`\nTulipa API v0.4.0 — Multi-Channel + Mesh + Ledger`);
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
  console.log('  POST /api/mesh/prompt/:nodeId — enviar prompt a peer (Claude P2P)');
  console.log('  POST /api/mesh/incoming       — receber de peer (P2P)');
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

  // Registra este nó no service registry
  registerSelf();

  // Inicia mesh (discovery + heartbeat)
  mesh.start().catch(err => {
    console.error(`[mesh] Falha ao iniciar: ${err.message}`);
  });

  startMonitor();
  queue.start(5000);
});
