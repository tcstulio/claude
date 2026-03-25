// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps, DashboardLibLike } from '../types.js';

export interface OrgEconomyDeps extends Pick<ServerDeps,
  'mesh' | 'protocol' | 'requireAuth' | 'ledger' | 'receiptLib' | 'orgRegistry'
> {
  dashboardLib: DashboardLibLike;
}

export function registerOrgEconomyRoutes(app: Application, deps: OrgEconomyDeps): void {
  const { mesh, protocol, requireAuth, ledger, receiptLib, orgRegistry, dashboardLib } = deps;

  // ─── Org Routes ──────────────────────────────────────────────────────

  app.post('/api/org', requireAuth, (req: Request, res: Response) => {
    const { name, policies } = req.body;
    if (!name) return res.status(400).json({ error: 'Campo "name" é obrigatório' });

    const createdBy = req.peer?.nodeId || protocol.NODE_ID;
    const org = orgRegistry.create(name, createdBy, policies);
    orgRegistry.save();
    res.json(org.toJSON());
  });

  app.get('/api/org', requireAuth, (req: Request, res: Response) => {
    const orgs = orgRegistry.list({ member: req.query.member as string | undefined });
    res.json({ orgs: orgs.map(o => o.toJSON()) });
  });

  app.get('/api/org/:orgId', requireAuth, (req: Request, res: Response) => {
    const org = orgRegistry.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });
    res.json({
      ...org.toJSON() as Record<string, unknown>,
      reputation: orgRegistry.getOrgReputation(org.id),
    });
  });

  app.post('/api/org/:orgId/invite', requireAuth, (req: Request, res: Response) => {
    const { nodeId, role } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Campo "nodeId" é obrigatório' });

    const org = orgRegistry.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });

    try {
      const invitedBy = req.peer?.nodeId || protocol.NODE_ID;
      const result = org.invite(nodeId, invitedBy, role);
      orgRegistry.save();
      res.json(result);
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  app.post('/api/org/:orgId/accept', requireAuth, (req: Request, res: Response) => {
    const org = orgRegistry.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });

    try {
      const nodeId = req.body.nodeId || req.peer?.nodeId || protocol.NODE_ID;
      const result = org.acceptInvite(nodeId);
      orgRegistry.save();
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.put('/api/org/:orgId/policies', requireAuth, (req: Request, res: Response) => {
    const org = orgRegistry.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });

    try {
      const changedBy = req.peer?.nodeId || protocol.NODE_ID;
      const policies = org.updatePolicies(req.body, changedBy);
      orgRegistry.save();
      res.json({ policies });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  app.delete('/api/org/:orgId/member/:nodeId', requireAuth, (req: Request, res: Response) => {
    const org = orgRegistry.get(req.params.orgId);
    if (!org) return res.status(404).json({ error: 'Org não encontrada' });

    try {
      const removedBy = req.peer?.nodeId || protocol.NODE_ID;
      org.removeMember(req.params.nodeId, removedBy);
      orgRegistry.save();
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  app.get('/api/org/reputation/:nodeId', (req: Request, res: Response) => {
    const boost = orgRegistry.getTrustBoost(req.params.nodeId);
    const orgs = orgRegistry.getPublicOrgInfo(req.params.nodeId);
    res.json({ nodeId: req.params.nodeId, trustBoost: boost, orgs });
  });

  app.delete('/api/org/:orgId', requireAuth, (req: Request, res: Response) => {
    try {
      const removedBy = req.peer?.nodeId || protocol.NODE_ID;
      orgRegistry.remove(req.params.orgId, removedBy);
      res.json({ ok: true });
    } catch (err) {
      res.status(403).json({ error: (err as Error).message });
    }
  });

  // ─── Economy Dashboard ───────────────────────────────────────────────

  app.get('/api/economy/dashboard', requireAuth, (_req: Request, res: Response) => {
    const data = dashboardLib.generateDashboard({
      ledger,
      trust: mesh.trust,
      registry: mesh.registry,
      nodeId: protocol.NODE_ID,
    });
    res.json(data);
  });

  app.post('/api/economy/dispute', requireAuth, (req: Request, res: Response) => {
    const { receipt: rcpt } = req.body;
    if (!rcpt) return res.status(400).json({ error: 'Campo "receipt" é obrigatório' });

    const result = dashboardLib.verifyAsThirdParty(rcpt, {
      registry: mesh.registry,
      receiptLib,
    });
    res.json(result);
  });

  app.get('/api/economy/ranking', requireAuth, (req: Request, res: Response) => {
    const skill = req.query.skill as string | undefined;
    const peers = skill
      ? mesh.registry.list({ capability: skill })
      : mesh.registry.list();

    const ranking = mesh.trust.rankForDelegation(peers, { skill, ledger });
    res.json({ skill: skill || 'all', ranking });
  });

  // ─── Ledger Routes ───────────────────────────────────────────────────

  app.get('/api/ledger', (_req: Request, res: Response) => {
    res.json(ledger.getSummary());
  });

  app.get('/api/ledger/balance', (_req: Request, res: Response) => {
    res.json(ledger.getBalance());
  });

  app.get('/api/ledger/receipts', (req: Request, res: Response) => {
    const receipts = ledger.getReceipts({
      peer: req.query.peer as string | undefined,
      skill: req.query.skill as string | undefined,
      since: req.query.since as string | undefined,
      limit: req.query.limit ? parseInt(req.query.limit as string, 10) : undefined,
    });
    res.json({ count: receipts.length, receipts });
  });

  app.post('/api/ledger/verify', (req: Request, res: Response) => {
    const { receipt: rcpt, fromPublicKey, toPublicKey } = req.body;
    if (!rcpt) return res.status(400).json({ error: 'Campo "receipt" é obrigatório' });

    const fromKey = fromPublicKey || mesh.registry.get(rcpt.from)?.metadata?.publicKey;
    const toKey = toPublicKey || mesh.registry.get(rcpt.to)?.metadata?.publicKey;

    const result = receiptLib.verifyReceipt(rcpt, { fromPublicKey: fromKey, toPublicKey: toKey });
    res.json(result);
  });

  app.get('/api/ledger/peer/:nodeId', (req: Request, res: Response) => {
    const balance = ledger.getPeerBalance(req.params.nodeId);
    const receipts = ledger.getReceipts({ peer: req.params.nodeId });
    res.json({
      peerId: req.params.nodeId,
      balance,
      receipts: receipts.length,
      recent: receipts.slice(-5),
    });
  });
}

export default registerOrgEconomyRoutes;
