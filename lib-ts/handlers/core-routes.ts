// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';
import type { MonitorService } from './monitor.js';

export interface CoreRouteDeps extends Pick<ServerDeps,
  'callMcpTool' | 'proxyFetch' | 'requireAuth' | 'gatewayUrl' | 'protocol'
> {
  monitor: MonitorService;
}

export function registerCoreRoutes(app: Application, deps: CoreRouteDeps): void {
  const { callMcpTool, proxyFetch, requireAuth, gatewayUrl, protocol, monitor } = deps;

  // Build info
  app.get('/api/build-info', (_req: Request, res: Response) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const info = require('./build-info.json');
      res.json(info);
    } catch {
      res.json({ version: 'unknown', error: 'build-info.json não encontrado' });
    }
  });

  // Monitor
  app.get('/api/monitor', (_req: Request, res: Response) => {
    res.json({
      monitor: monitor.getState(),
      config: monitor.getConfig(),
    });
  });

  // Health proxy
  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      const r = await proxyFetch(`${gatewayUrl}/api/health`);
      res.status(r.status).json(await r.json());
    } catch (err) {
      res.status(502).json({ error: 'Gateway indisponível', detail: (err as Error).message });
    }
  });

  // Status
  app.get('/api/status', async (req: Request, res: Response) => {
    try {
      const data = await callMcpTool('get_status', {}, req);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao buscar status', detail: (err as Error).message });
    }
  });

  // Peers (via gateway MCP)
  app.get('/api/peers', async (req: Request, res: Response) => {
    try {
      const data = await callMcpTool('list_peers', {}, req);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao listar peers', detail: (err as Error).message });
    }
  });

  // Logs
  app.get('/api/logs', requireAuth, async (req: Request, res: Response) => {
    try {
      const args: Record<string, unknown> = {};
      if (req.query.limit) args.limit = parseInt(req.query.limit as string, 10);
      const data = await callMcpTool('get_logs', args, req);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao buscar logs', detail: (err as Error).message });
    }
  });

  // Proxy MCP genérico
  app.post('/api/mcp/:tool', requireAuth, async (req: Request, res: Response) => {
    try {
      const data = await callMcpTool(req.params.tool, req.body, req);
      res.json(data);
    } catch (err) {
      res.status(502).json({ error: `Falha ao chamar tool "${req.params.tool}"`, detail: (err as Error).message });
    }
  });
}

export default registerCoreRoutes;
