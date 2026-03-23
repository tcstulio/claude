const express = require('express');
const { ProxyAgent, fetch: undiciFetch } = require('undici');
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
  alertSent: false,         // evita spam de alertas
};

async function sendAlert(message) {
  if (!ALERT_PHONE) {
    console.log(`[monitor] Alerta (sem ALERT_PHONE): ${message}`);
    return;
  }
  try {
    await callMcpTool('send_whatsapp', { phone: ALERT_PHONE, message });
    console.log(`[monitor] Alerta enviado para ${ALERT_PHONE}`);
  } catch (err) {
    console.error(`[monitor] Falha ao enviar alerta: ${err.message}`);
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
    const healthData = await healthRes.json();

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
        await sendAlert(`⚠️ Tulipa lenta — resposta em ${elapsed}ms (limite: ${SLOW_THRESHOLD}ms)`);
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
      await sendAlert(`✅ Tulipa voltou ao normal — resposta em ${elapsed}ms`);
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
      await sendAlert(`🔴 Tulipa OFFLINE — ${err.message} (${monitorState.consecutiveFailures} falhas consecutivas)`);
    }
  }
}

// Endpoint para consultar estado do monitor
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

// Inicia o watchdog
let monitorTimer = null;
function startMonitor() {
  if (!MONITOR_INTERVAL || MONITOR_INTERVAL < 10000) return;
  console.log(`[monitor] Watchdog ativo — check a cada ${MONITOR_INTERVAL / 1000}s`);
  if (ALERT_PHONE) console.log(`[monitor] Alertas WhatsApp para ***${ALERT_PHONE.slice(-4)}`);
  else console.log('[monitor] ALERT_PHONE não configurado — alertas somente no console');

  // Primeiro check após 10s (dá tempo do servidor subir)
  setTimeout(() => {
    runHealthCheck();
    monitorTimer = setInterval(runHealthCheck, MONITOR_INTERVAL);
  }, 10000);
}

// Helper: chama MCP tool no gateway
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

// GET /api/health — proxy para health do gateway
app.get('/api/health', async (_req, res) => {
  try {
    const r = await proxyFetch(`${GATEWAY_URL}/api/health`);
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Gateway indisponível', detail: err.message });
  }
});

// GET /api/whatsapp/history — histórico de conversas
app.get('/api/whatsapp/history', async (req, res) => {
  try {
    const { phone, limit } = req.query;
    const args = {};
    if (phone) args.phone = phone;
    if (limit) args.limit = parseInt(limit, 10);

    const data = await callMcpTool('get_whatsapp_history', args, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar histórico', detail: err.message });
  }
});

// POST /api/whatsapp/send — enviar mensagem WhatsApp
app.post('/api/whatsapp/send', async (req, res) => {
  try {
    const { phone, message } = req.body;

    if (!phone || !message) {
      return res.status(400).json({ error: 'Campos "phone" e "message" são obrigatórios' });
    }

    const data = await callMcpTool('send_whatsapp', { phone, message }, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar mensagem', detail: err.message });
  }
});

// GET /api/status — status do agente
app.get('/api/status', async (req, res) => {
  try {
    const data = await callMcpTool('get_status', {}, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar status', detail: err.message });
  }
});

// GET /api/peers — listar agentes conectados
app.get('/api/peers', async (req, res) => {
  try {
    const data = await callMcpTool('list_peers', {}, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao listar peers', detail: err.message });
  }
});

// GET /api/logs — logs do sistema
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

// POST /api/mcp/:tool — proxy genérico para qualquer MCP tool
app.post('/api/mcp/:tool', async (req, res) => {
  try {
    const data = await callMcpTool(req.params.tool, req.body, req);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Falha ao chamar tool "${req.params.tool}"`, detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Tulipa API rodando em http://localhost:${PORT}`);
  console.log(`Gateway: ${GATEWAY_URL}`);
  console.log('\nEndpoints disponíveis:');
  console.log('  GET  /api/health');
  console.log('  GET  /api/status');
  console.log('  GET  /api/monitor');
  console.log('  GET  /api/whatsapp/history?phone=5511...&limit=50');
  console.log('  POST /api/whatsapp/send  { phone, message }');
  console.log('  GET  /api/peers');
  console.log('  GET  /api/logs?limit=100');
  console.log('  POST /api/mcp/:tool  { ...arguments }');

  startMonitor();
});
