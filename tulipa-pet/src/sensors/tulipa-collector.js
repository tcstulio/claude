/**
 * Tulipa Network Sensor Collector
 * Fetches data from the Tulipa agent API for social/network metrics
 */

const TULIPA_ENDPOINT = process.env.TULIPA_ENDPOINT || 'https://agent.coolgroove.com.br';
const TULIPA_TOKEN = process.env.TULIPA_TOKEN;

async function mcpCall(method, args = {}) {
  if (!TULIPA_TOKEN) return null;
  try {
    const res = await fetch(`${TULIPA_ENDPOINT}/mcp`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${TULIPA_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: Date.now(),
        params: { name: method, arguments: args },
      }),
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    return data.result;
  } catch {
    return null;
  }
}

async function apiGet(path) {
  if (!TULIPA_TOKEN) return null;
  try {
    const res = await fetch(`${TULIPA_ENDPOINT}${path}`, {
      headers: { 'Authorization': `Bearer ${TULIPA_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    return await res.json();
  } catch {
    return null;
  }
}

export async function collectTulipaSensors() {
  const sensors = {};

  // Health check
  const health = await apiGet('/api/health');
  sensors.tulipa_online = !!health?.status;

  // Peers (social)
  const peers = await mcpCall('list_peers');
  if (peers?.content?.[0]?.text) {
    try {
      const peerData = JSON.parse(peers.content[0].text);
      sensors.peersOnline = Array.isArray(peerData) ? peerData.filter(p => p.online).length : 0;
    } catch {
      sensors.peersOnline = 0;
    }
  }

  // Tokens (security)
  const tokens = await mcpCall('list_tokens');
  if (tokens?.content?.[0]?.text) {
    try {
      const tokenData = JSON.parse(tokens.content[0].text);
      sensors.activeTokens = Array.isArray(tokenData) ? tokenData.filter(t => t.active).length : 0;
    } catch {
      sensors.activeTokens = 0;
    }
  }

  // Tasks (XP)
  const tasks = await mcpCall('list_tasks');
  if (tasks?.content?.[0]?.text) {
    try {
      const taskData = JSON.parse(tasks.content[0].text);
      sensors.tasksCompleted = Array.isArray(taskData)
        ? taskData.filter(t => t.status === 'completed').length
        : 0;
    } catch {
      sensors.tasksCompleted = 0;
    }
  }

  // System status
  const status = await mcpCall('get_status');
  if (status?.content?.[0]?.text) {
    try {
      const statusData = JSON.parse(status.content[0].text);
      sensors.tunnelUp = statusData.cloudflared === 'running' || statusData.tunnel === 'up';
    } catch {
      // ignore
    }
  }

  // WhatsApp history (social interaction)
  const whatsapp = await mcpCall('get_whatsapp_history');
  if (whatsapp?.content?.[0]?.text) {
    try {
      const messages = JSON.parse(whatsapp.content[0].text);
      if (Array.isArray(messages) && messages.length > 0) {
        const lastMsg = new Date(messages[0].timestamp || messages[0].date);
        sensors.lastInteraction = (Date.now() - lastMsg.getTime()) / 60000; // minutes
      }
    } catch {
      // ignore
    }
  }

  return sensors;
}
