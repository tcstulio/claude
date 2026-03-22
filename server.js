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

// Helper: chama MCP tool no gateway
async function callMcpTool(tool, args = {}, req = null) {
  const res = await proxyFetch(`${GATEWAY_URL}/mcp`, {
    method: 'POST',
    headers: authHeaders(req),
    body: JSON.stringify({ tool, arguments: args }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gateway retornou ${res.status}: ${text}`);
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
  console.log('  GET  /api/whatsapp/history?phone=5511...&limit=50');
  console.log('  POST /api/whatsapp/send  { phone, message }');
  console.log('  GET  /api/peers');
  console.log('  GET  /api/logs?limit=100');
  console.log('  POST /api/mcp/:tool  { ...arguments }');
});
