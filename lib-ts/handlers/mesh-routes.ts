// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';

export function registerMeshRoutes(app: Application, deps: ServerDeps): void {
  const { mesh, requireAuth } = deps;

  // Estado do mesh
  app.get('/api/mesh', (_req: Request, res: Response) => {
    res.json(mesh.toJSON());
  });

  // Lista peers do registry local
  app.get('/api/mesh/peers', (req: Request, res: Response) => {
    const { status, capability } = req.query as { status?: string; capability?: string };
    const filter: Record<string, string> = {};
    if (status) filter.status = status;
    if (capability) filter.capability = capability;
    res.json({ peers: mesh.registry.list(filter) });
  });

  // Força discovery
  app.post('/api/mesh/discover', requireAuth, async (_req: Request, res: Response) => {
    try {
      const peers = await mesh.discover();
      res.json({ ok: true, found: peers.length, registry: mesh.registry.toJSON() });
    } catch (err) {
      res.status(502).json({ error: 'Discovery falhou', detail: (err as Error).message });
    }
  });

  // Ping um peer
  app.post('/api/mesh/ping/:nodeId', requireAuth, async (req: Request, res: Response) => {
    try {
      const start = Date.now();
      const result = await mesh.pingPeer(String(req.params.nodeId));
      res.json({ ok: true, latency: Date.now() - start, result });
    } catch (err) {
      res.status(502).json({ error: 'Ping falhou', detail: (err as Error).message });
    }
  });

  // Enviar mensagem para peer
  app.post('/api/mesh/send/:nodeId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { message } = req.body;
      if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
      const result = await mesh.sendToPeer(String(req.params.nodeId), message);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(502).json({ error: 'Envio falhou', detail: (err as Error).message });
    }
  });

  // Enviar prompt para peer
  app.post('/api/mesh/prompt/:nodeId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { prompt, text, system_prompt, model, timeout } = req.body;
      const promptText = prompt || text;
      if (!promptText) return res.status(400).json({ error: 'Campo "prompt" ou "text" é obrigatório' });
      const result = await mesh.sendPrompt(String(req.params.nodeId), promptText, {
        systemPrompt: system_prompt,
        model,
        timeoutMs: timeout || 30000,
      });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(502).json({ error: 'Prompt falhou', detail: (err as Error).message });
    }
  });

  // Admin token de peer
  app.post('/api/mesh/admin-token/:nodeId', requireAuth, async (req: Request, res: Response) => {
    try {
      const { admin_token } = req.body;
      const result = await mesh.requestAdminToken(String(req.params.nodeId), { adminToken: admin_token });
      res.json({ ok: true, ...result as Record<string, unknown> });
    } catch (err) {
      res.status(502).json({ error: 'Falha ao obter admin token', detail: (err as Error).message });
    }
  });

  // Registrar/atualizar peer endpoint
  app.post('/api/mesh/peers/:nodeId', (req: Request, res: Response) => {
    try {
      const { endpoint, name, capabilities, channels } = req.body;
      const info: Record<string, unknown> = {};
      if (endpoint) info.endpoint = endpoint;
      if (name) info.name = name;
      if (capabilities) info.capabilities = capabilities;
      if (channels) info.channels = channels;
      const peer = mesh.registry.upsert(String(req.params.nodeId), info);
      res.json({ ok: true, peer });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Receber mensagem de peer (P2P incoming)
  app.post('/api/mesh/incoming', (req: Request, res: Response) => {
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
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // Heartbeat manual
  app.post('/api/mesh/heartbeat', requireAuth, async (_req: Request, res: Response) => {
    try {
      const results = await mesh.heartbeatAll();
      res.json({ ok: true, results });
    } catch (err) {
      res.status(502).json({ error: 'Heartbeat falhou', detail: (err as Error).message });
    }
  });

  // ─── Network / Trust ─────────────────────────────────────────────────

  app.get('/api/network/peers/public', (_req: Request, res: Response) => {
    res.json({ peers: mesh.getPublicPeerList() });
  });

  app.get('/api/network/trust', requireAuth, (_req: Request, res: Response) => {
    res.json(mesh.trust.toJSON());
  });

  app.get('/api/network/rank/:skill', requireAuth, (req: Request, res: Response) => {
    const eligibleOnly = req.query.all !== 'true';
    const ranking = mesh.queryBySkill(String(req.params.skill), { eligibleOnly });
    res.json({ skill: req.params.skill, ranking });
  });

  app.post('/api/network/crawl', requireAuth, async (_req: Request, res: Response) => {
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/network/crawl', (_req: Request, res: Response) => {
    res.json(mesh.crawler.cacheInfo());
  });
}

export default registerMeshRoutes;
