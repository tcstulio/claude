const express = require('express');
const app = express();

const GATEWAY_URL = process.env.GATEWAY_URL || 'https://agent.coolgroove.com.br';
const PORT = process.env.PORT || 3000;

app.use(express.json());

// Helper: chama MCP tool no gateway
async function callMcpTool(tool, args = {}) {
  const res = await fetch(`${GATEWAY_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
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
    const r = await fetch(`${GATEWAY_URL}/api/health`);
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

    const data = await callMcpTool('get_whatsapp_history', args);
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

    const data = await callMcpTool('send_whatsapp', { phone, message });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao enviar mensagem', detail: err.message });
  }
});

// GET /api/status — status do agente
app.get('/api/status', async (_req, res) => {
  try {
    const data = await callMcpTool('get_status');
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar status', detail: err.message });
  }
});

// GET /api/peers — listar agentes conectados
app.get('/api/peers', async (_req, res) => {
  try {
    const data = await callMcpTool('list_peers');
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

    const data = await callMcpTool('get_logs', args);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'Falha ao buscar logs', detail: err.message });
  }
});

// POST /api/mcp/:tool — proxy genérico para qualquer MCP tool
app.post('/api/mcp/:tool', async (req, res) => {
  try {
    const data = await callMcpTool(req.params.tool, req.body);
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
