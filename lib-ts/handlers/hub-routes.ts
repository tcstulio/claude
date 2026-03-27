// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';

export function registerHubRoutes(app: Application, deps: ServerDeps): void {
  const { mesh, protocol, requireAuth } = deps;

  // ─── Hub Council ─────────────────────────────────────────────────────

  app.get('/api/hub/status', (_req: Request, res: Response) => {
    res.json({
      nodeId: protocol.NODE_ID,
      nodeName: protocol.NODE_NAME,
      ...mesh.hubRole.toJSON() as Record<string, unknown>,
    });
  });

  app.get('/api/hub/registry', (_req: Request, res: Response) => {
    res.json(mesh.hubRegistry.toJSON());
  });

  app.get('/api/hub/council', requireAuth, (_req: Request, res: Response) => {
    res.json(mesh.hubCouncil.toJSON());
  });

  app.post('/api/hub/propose', requireAuth, (req: Request, res: Response) => {
    const { type, targetNodeId, reason } = req.body;
    if (!type || !targetNodeId) {
      return res.status(400).json({ error: 'Campos "type" e "targetNodeId" são obrigatórios' });
    }
    try {
      const proposal = mesh.hubCouncil.propose(type, targetNodeId, reason || '');
      res.json({ ok: true, proposal });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/hub/vote', requireAuth, (req: Request, res: Response) => {
    const { proposalId, vote, reason } = req.body;
    if (!proposalId || !vote) {
      return res.status(400).json({ error: 'Campos "proposalId" e "vote" são obrigatórios' });
    }
    try {
      const result = mesh.hubCouncil.vote(proposalId, protocol.NODE_ID, vote, reason);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.post('/api/hub/evaluate', requireAuth, async (_req: Request, res: Response) => {
    try {
      const result = await mesh.hubAdvisor.analyze();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/hub/advisor', (_req: Request, res: Response) => {
    res.json(mesh.hubAdvisor.toJSON());
  });

  app.post('/api/hub/heartbeat', (req: Request, res: Response) => {
    const { nodeId, metrics } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'nodeId required' });
    const hub = mesh.hubRegistry.processHeartbeat(nodeId, metrics);
    res.json({ ok: true, hub });
  });

  app.post('/api/hub/sync', (req: Request, res: Response) => {
    const { hubs, epoch } = req.body;
    if (!hubs) return res.status(400).json({ error: 'hubs required' });
    const updated = mesh.hubRegistry.applySync(hubs, epoch);
    res.json({ ok: true, updated, localEpoch: mesh.hubRegistry._epoch });
  });

  app.post('/api/hub/election', (req: Request, res: Response) => {
    try {
      const result = mesh.hubCouncil.receiveProposal(req.body);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/hub/network-eval', requireAuth, (_req: Request, res: Response) => {
    res.json(mesh.hubCouncil.evaluateNetwork());
  });

  // ─── Federation ──────────────────────────────────────────────────────

  app.post('/api/network/query', async (req: Request, res: Response) => {
    const { skill, queryId, hopsRemaining, originNode } = req.body;
    if (!skill) return res.status(400).json({ error: 'Campo "skill" é obrigatório' });

    try {
      const result = await mesh.federation.query(skill, { queryId, hopsRemaining, originNode });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/network/relay', requireAuth, async (req: Request, res: Response) => {
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
      res.status(502).json({ error: `Relay falhou: ${(err as Error).message}` });
    }
  });

  app.get('/api/network/federation', (_req: Request, res: Response) => {
    res.json(mesh.federation.stats());
  });
}

export default registerHubRoutes;
