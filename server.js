const express = require('express');
const { ProxyAgent, fetch: undiciFetch } = require('undici');

// ─── Transport Layer ───────────────────────────────────────────────────
const WhatsAppTransport = require('./lib/transport/whatsapp');
const TelegramTransport = require('./lib/transport/telegram');
const MessageQueue = require('./lib/queue');
const Router = require('./lib/router');
const MeshManager = require('./lib/mesh');
const protocol = require('./lib/protocol');

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

const router = new Router({ queue });
router.register(whatsapp);
if (telegram.configured) router.register(telegram);

// ─── Mesh Layer ───────────────────────────────────────────────────────
const mesh = new MeshManager({
  router,
  callMcpTool,
  discoveryInterval: parseInt(process.env.MESH_DISCOVERY_INTERVAL || '120000', 10),
  heartbeatInterval: parseInt(process.env.MESH_HEARTBEAT_INTERVAL || '60000', 10),
});

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
app.get('/api/whatsapp/history', async (req, res) => {
  try {
    const { phone, limit } = req.query;
    const result = await whatsapp.receive(phone, { limit: limit ? parseInt(limit, 10) : undefined });
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar histórico', detail: err.message });
  }
});

app.post('/api/whatsapp/send', async (req, res) => {
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

app.get('/api/logs', async (req, res) => {
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
app.post('/api/send', async (req, res) => {
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

app.post('/api/telegram/send', async (req, res) => {
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
app.post('/api/mesh/discover', async (_req, res) => {
  try {
    const peers = await mesh.discover();
    res.json({ ok: true, found: peers.length, registry: mesh.registry.toJSON() });
  } catch (err) {
    res.status(502).json({ error: 'Discovery falhou', detail: err.message });
  }
});

// Ping um peer específico
app.post('/api/mesh/ping/:nodeId', async (req, res) => {
  try {
    const start = Date.now();
    const result = await mesh.pingPeer(req.params.nodeId);
    res.json({ ok: true, latency: Date.now() - start, result });
  } catch (err) {
    res.status(502).json({ error: 'Ping falhou', detail: err.message });
  }
});

// Enviar mensagem para um peer
app.post('/api/mesh/send/:nodeId', async (req, res) => {
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
app.post('/api/mesh/heartbeat', async (_req, res) => {
  try {
    const results = await mesh.heartbeatAll();
    res.json({ ok: true, results });
  } catch (err) {
    res.status(502).json({ error: 'Heartbeat falhou', detail: err.message });
  }
});

// Proxy genérico MCP
app.post('/api/mcp/:tool', async (req, res) => {
  try {
    const data = await callMcpTool(req.params.tool, req.body, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Falha ao chamar tool "${req.params.tool}"`, detail: err.message });
  }
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
  console.log(`\nTulipa API v3.0 — Transport + Mesh`);
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

  // Inicia mesh (discovery + heartbeat)
  mesh.start().catch(err => {
    console.error(`[mesh] Falha ao iniciar: ${err.message}`);
  });

  startMonitor();
  queue.start(5000);
});
