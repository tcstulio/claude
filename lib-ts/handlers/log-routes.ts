// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';
import type { LogQueryService } from '../mesh/log-query-service.js';
import type { FederatedLogQuery } from '../mesh/federated-log-query.js';
import type { LogQuery } from '../mesh/log-query.js';

export interface LogRouteDeps extends Pick<ServerDeps, 'requireAuth'> {
  logQueryService: LogQueryService;
  federatedLogQuery: FederatedLogQuery;
}

export function registerLogRoutes(app: Application, deps: LogRouteDeps): void {
  const { requireAuth, logQueryService, federatedLogQuery } = deps;

  // Local log query — each peer exposes this
  app.post('/api/logs/query', (req: Request, res: Response) => {
    try {
      const q: LogQuery = req.body || {};
      const entries = logQueryService.query(q);
      res.json({ entries });
    } catch (err) {
      res.status(500).json({ error: `Falha na consulta de logs: ${(err as Error).message}` });
    }
  });

  // Federated log query — aggregates from all peers
  app.post('/api/network/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const q: LogQuery = req.body || {};
      const result = await federatedLogQuery.query(q);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Falha na consulta federada: ${(err as Error).message}` });
    }
  });

  // GET convenience endpoint for basic log queries
  app.get('/api/network/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const q: LogQuery = {};
      if (req.query.since) q.since = String(req.query.since);
      if (req.query.until) q.until = String(req.query.until);
      if (req.query.events) q.events = String(req.query.events).split(',');
      if (req.query.source) q.source = String(req.query.source);
      if (req.query.component) q.component = String(req.query.component);
      if (req.query.search) q.search = String(req.query.search);
      if (req.query.limit) q.limit = parseInt(String(req.query.limit), 10);
      if (req.query.includeFileLog) q.includeFileLog = req.query.includeFileLog === 'true';
      const result = await federatedLogQuery.query(q);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: `Falha na consulta federada: ${(err as Error).message}` });
    }
  });
}
