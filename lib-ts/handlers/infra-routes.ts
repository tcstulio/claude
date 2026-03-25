// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';

export function registerInfraRoutes(app: Application, deps: ServerDeps): void {
  const { mesh, infraScanner, infraAdopter, canary, networkRoutes, requireAuth } = deps;

  // ─── Infra Scan ──────────────────────────────────────────────────────

  app.post('/api/infra/scan', requireAuth, async (req: Request, res: Response) => {
    const { endpoints, subnets } = req.body;
    try {
      let results: unknown[];
      if (endpoints && endpoints.length > 0) {
        results = await infraScanner.scanEndpoints(endpoints);
      } else {
        results = await infraScanner.scanSubnets({ subnets });
      }
      res.json({ found: results.length, results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.post('/api/infra/scan/:ip', requireAuth, async (req: Request, res: Response) => {
    try {
      const results = await infraScanner.scanHost(req.params.ip);
      res.json({ ip: req.params.ip, found: results.length, results });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/infra/scan', (_req: Request, res: Response) => {
    res.json(infraScanner.getLastScan() || { message: 'Nenhum scan realizado' });
  });

  // ─── Infra Adopt ─────────────────────────────────────────────────────

  app.post('/api/infra/adopt', requireAuth, (req: Request, res: Response) => {
    const { discovered, credentials } = req.body;
    if (!discovered || !discovered.type || !discovered.endpoint) {
      return res.status(400).json({ error: 'Campo "discovered" com type e endpoint é obrigatório' });
    }
    try {
      const result = infraAdopter.adopt(discovered, credentials);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/infra/adopted', requireAuth, (_req: Request, res: Response) => {
    res.json({ services: infraAdopter.list() });
  });

  app.post('/api/infra/test/:nodeId', requireAuth, async (req: Request, res: Response) => {
    try {
      const result = await infraAdopter.test(req.params.nodeId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/infra/adopted/:nodeId', requireAuth, (req: Request, res: Response) => {
    infraAdopter.remove(req.params.nodeId);
    res.json({ ok: true, removed: req.params.nodeId });
  });

  // ─── SSH ─────────────────────────────────────────────────────────────

  app.post('/api/infra/ssh/:nodeId', requireAuth, async (req: Request, res: Response) => {
    const { command, commands } = req.body;
    const peer = mesh.registry.get(req.params.nodeId);
    if (!peer?.metadata?.isInfra) {
      return res.status(404).json({ error: 'Peer não é um serviço de infra adotado' });
    }

    // Dynamic import to avoid requiring ssh2 when not used
    const { default: SSHTaskRunner } = await import('../infra/ssh-task.js');
    const ssh = new SSHTaskRunner({
      host: peer.metadata.ip as string,
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
      res.status(500).json({ error: (err as Error).message });
    }
  });

  // ─── Network Routes (multi-path) ────────────────────────────────────

  app.get('/api/routes', requireAuth, (_req: Request, res: Response) => {
    res.json(networkRoutes.toJSON());
  });

  app.post('/api/routes/:nodeId', requireAuth, (req: Request, res: Response) => {
    const { routes, auto } = req.body;
    if (auto) {
      const detected = networkRoutes.autoRegister(req.params.nodeId, req.body);
      return res.json({ nodeId: req.params.nodeId, routes: detected });
    }
    if (!routes || !Array.isArray(routes)) {
      return res.status(400).json({ error: 'Campo "routes" (array) é obrigatório' });
    }
    networkRoutes.setRoutes(req.params.nodeId, routes);
    res.json({ ok: true, routes: networkRoutes.getRoutes(req.params.nodeId) });
  });

  app.get('/api/routes/:nodeId/resolve', requireAuth, async (req: Request, res: Response) => {
    const force = req.query.force === 'true';
    const result = await networkRoutes.resolve(req.params.nodeId, { force });
    if (!result) return res.status(404).json({ error: 'Nenhuma rota funcional encontrada' });
    res.json(result);
  });

  app.post('/api/routes/:nodeId/test', requireAuth, async (req: Request, res: Response) => {
    const results = await networkRoutes.testAll(req.params.nodeId);
    res.json({ nodeId: req.params.nodeId, results });
  });

  // ─── Canary ──────────────────────────────────────────────────────────

  app.post('/api/canary/start', requireAuth, async (req: Request, res: Response) => {
    const { version, repo, branch, testCommands, preferNode } = req.body;
    if (!version || !repo) {
      return res.status(400).json({ error: 'Campos "version" e "repo" são obrigatórios' });
    }
    try {
      const run = await canary.start({ version, repo, branch, testCommands, preferNode });
      res.json(run);
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  });

  app.get('/api/canary/:runId', requireAuth, (req: Request, res: Response) => {
    const run = canary.getRun(req.params.runId);
    if (!run) return res.status(404).json({ error: 'Run não encontrado' });
    res.json(run);
  });

  app.get('/api/canary', requireAuth, (req: Request, res: Response) => {
    const { state, version } = req.query as { state?: string; version?: string };
    const runs = canary.listRuns({ state, version });
    res.json({ runs });
  });

  app.post('/api/canary/:runId/approve', requireAuth, (req: Request, res: Response) => {
    const { approved, reason } = req.body;
    if (typeof approved !== 'boolean') {
      return res.status(400).json({ error: 'Campo "approved" (boolean) é obrigatório' });
    }
    try {
      const run = canary.approve(req.params.runId, approved, reason);
      res.json(run);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });
}

export default registerInfraRoutes;
