// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps, CapabilitiesLibLike } from '../types.js';

export interface CapabilitiesRouteDeps extends Pick<ServerDeps,
  'mesh' | 'protocol' | 'requireAuth' | 'localTools' | 'dataSourceRegistry' | 'platformInfo' | 'nodeCapabilities'
> {
  capabilitiesLib: CapabilitiesLibLike;
  introspectHandler: (opts: Record<string, unknown>) => (req: Request, res: Response) => void;
  apiToken: string;
}

export function registerCapabilitiesRoutes(app: Application, deps: CapabilitiesRouteDeps): void {
  const { mesh, protocol, requireAuth, localTools, dataSourceRegistry, platformInfo, nodeCapabilities, capabilitiesLib } = deps;

  // GET /api/infra — público, capabilities de infra deste nó
  app.get('/api/infra', (_req: Request, res: Response) => {
    const infra = capabilitiesLib.filterByCategory(nodeCapabilities, 'infra');
    res.json({
      nodeId: protocol.NODE_ID,
      nodeName: protocol.NODE_NAME,
      category: 'infra',
      capabilities: capabilitiesLib.enrich(infra),
      peers: mesh.registry.online().map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        infra: capabilitiesLib.filterByCategory(p.capabilities, 'infra'),
      })),
    });
  });

  // GET /api/knowledge — catálogo completo, filtrado por scopes
  app.get('/api/knowledge', requireAuth, (req: Request, res: Response) => {
    const scopes = req.grantedScopes || [];
    const accessible = capabilitiesLib.accessibleCapabilities(nodeCapabilities, scopes);

    res.json({
      nodeId: protocol.NODE_ID,
      nodeName: protocol.NODE_NAME,
      grantedScopes: scopes,
      capabilities: capabilitiesLib.enrich(accessible),
      restricted: nodeCapabilities.filter(c => !accessible.includes(c)).map(c => ({
        name: c,
        category: capabilitiesLib.classify(c),
        scope: capabilitiesLib.requiredScope(c),
        reason: 'Scope não autorizado',
      })),
      peers: mesh.registry.online().map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        capabilities: capabilitiesLib.enrich(
          capabilitiesLib.accessibleCapabilities(p.capabilities, scopes)
        ),
      })),
    });
  });

  // GET /api/capabilities — classificação de todas
  app.get('/api/capabilities', (_req: Request, res: Response) => {
    res.json({
      node: capabilitiesLib.enrich(nodeCapabilities),
      known: capabilitiesLib.KNOWN_CAPABILITIES,
      scopes: capabilitiesLib.DATA_SCOPES,
    });
  });

  // ─── Platform & Data Sources ─────────────────────────────────────────

  app.get('/api/platform', (_req: Request, res: Response) => {
    res.json({
      nodeId: protocol.NODE_ID,
      nodeName: protocol.NODE_NAME,
      ...platformInfo,
      capabilities: nodeCapabilities,
    });
  });

  app.get('/api/data-sources', (_req: Request, res: Response) => {
    res.json({
      nodeId: protocol.NODE_ID,
      nodeName: protocol.NODE_NAME,
      local: dataSourceRegistry.toJSON(),
      network: mesh.registry.online().map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        platform: p.platform,
        dataSources: p.dataSources || [],
      })).filter(p => (p.dataSources as unknown[]).length > 0),
    });
  });

  app.get('/api/data-sources/:name', (req: Request, res: Response) => {
    const name = req.params.name;
    const localSource = dataSourceRegistry.get(String(name));
    const networkPeers = mesh.registry.list({ dataSource: String(name) });

    res.json({
      source: name,
      local: localSource || null,
      network: networkPeers.map(p => ({
        nodeId: p.nodeId,
        name: p.name,
        platform: p.platform,
        status: p.status,
      })),
      totalProviders: (localSource ? 1 : 0) + networkPeers.length,
    });
  });

  // Roteamento inteligente por intent
  app.get('/api/network/route/:intent', (req: Request, res: Response) => {
    const intent = req.params.intent;
    const result = mesh.querySmartRoute(String(intent));

    res.json({
      intent,
      ...result,
      localPlatform: platformInfo.platform,
      localHas: nodeCapabilities.includes(String(intent)) || dataSourceRegistry.has(String(intent)),
    });
  });

  // Visão de plataformas na rede
  app.get('/api/network/platforms', (_req: Request, res: Response) => {
    const peers = mesh.registry.online();
    const platforms: Record<string, unknown[]> = {};

    for (const p of peers) {
      const plat = p.platform || 'unknown';
      if (!platforms[plat]) platforms[plat] = [];
      platforms[plat].push({
        nodeId: p.nodeId,
        name: p.name,
        capabilities: p.capabilities,
        dataSources: p.dataSources,
      });
    }

    const selfPlat = platformInfo.platform;
    if (!platforms[selfPlat]) platforms[selfPlat] = [];
    platforms[selfPlat].unshift({
      nodeId: protocol.NODE_ID,
      name: protocol.NODE_NAME,
      capabilities: nodeCapabilities,
      dataSources: dataSourceRegistry.toAnnounce(),
      self: true,
    });

    res.json({ platforms });
  });

  // ─── Local MCP Tools ─────────────────────────────────────────────────

  app.get('/api/local-tools', (_req: Request, res: Response) => {
    res.json({ tools: localTools.list() });
  });

  app.post('/api/local-mcp', (req: Request, res: Response) => {
    const { jsonrpc, method, id, params } = req.body;
    if (jsonrpc !== '2.0' || method !== 'tools/call') {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
    }

    const result = localTools.handle(params?.name, params?.arguments || {});
    if (!result) {
      return res.json({ jsonrpc: '2.0', id, error: { code: -32602, message: `Tool '${params?.name}' não encontrada` } });
    }

    res.json({ jsonrpc: '2.0', id, result });
  });

  // ─── Token Introspection ─────────────────────────────────────────────

  app.post('/api/network/introspect', deps.introspectHandler({
    masterToken: deps.apiToken,
    mesh,
  }));
}

export default registerCapabilitiesRoutes;
