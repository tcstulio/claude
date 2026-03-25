// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import * as crypto from 'node:crypto';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import type { Application, Request, Response, ServerDeps, ServiceEntry } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface DeployLogEntry {
  id: string;
  type: string;
  message: string;
  details: Record<string, unknown>;
  timestamp: string;
}

// ─── Service Registry + Deploy ───────────────────────────────────────────────

export function registerServicesDeployRoutes(app: Application, deps: ServerDeps): void {
  const { protocol, requireAuth, router, callMcpTool, proxyFetch, serviceRegistry, port } = deps;

  const ALERT_PHONE = process.env.ALERT_PHONE || '';
  const DEPLOY_SECRET = process.env.DEPLOY_SECRET || '';
  const DEPLOY_LOG: DeployLogEntry[] = [];
  const SERVICE_STALE_MS = 5 * 60 * 1000;

  // ─── Helpers ─────────────────────────────────────────────────────────

  function addDeployLog(type: string, message: string, details: Record<string, unknown> = {}): DeployLogEntry {
    const entry: DeployLogEntry = {
      id: crypto.randomUUID(),
      type,
      message,
      details,
      timestamp: new Date().toISOString(),
    };
    DEPLOY_LOG.unshift(entry);
    if (DEPLOY_LOG.length > 50) DEPLOY_LOG.length = 50;
    console.log(`[deploy] ${type}: ${message}`);
    return entry;
  }

  async function notifyDeploy(message: string): Promise<void> {
    addDeployLog('notify', message);
    if (ALERT_PHONE) {
      try {
        await router.send(ALERT_PHONE, `[Deploy] ${message}`);
      } catch (err) {
        console.error(`[deploy] Falha ao notificar: ${(err as Error).message}`);
      }
    }
    for (const [nodeId, entry] of serviceRegistry) {
      if (nodeId === protocol.NODE_ID) continue;
      if (entry.status !== 'online') continue;
      for (const svc of entry.services) {
        if (svc.url && svc.type === 'api') {
          try {
            await proxyFetch(`${svc.url}/api/webhook/incoming/deploy`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ source: protocol.NODE_NAME, message, timestamp: new Date().toISOString() }),
              signal: AbortSignal.timeout(5000),
            });
          } catch { /* best effort */ }
        }
      }
    }
  }

  function verifyGitHubSignature(payload: string, signature: string | undefined): boolean {
    if (!DEPLOY_SECRET) return true;
    if (!signature) return false;
    const hmac = crypto.createHmac('sha256', DEPLOY_SECRET);
    hmac.update(payload);
    const expected = `sha256=${hmac.digest('hex')}`;
    try {
      return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // Registra este nó ao iniciar
  function registerSelf(): void {
    const selfId = protocol.NODE_ID;
    serviceRegistry.set(selfId, {
      nodeId: selfId,
      name: protocol.NODE_NAME,
      services: [{
        name: 'tulipa-api',
        url: `http://localhost:${port}`,
        type: 'api',
        version: '4.0',
      }],
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'online',
    });
  }

  // Sweep stale services
  setInterval(() => {
    const now = Date.now();
    for (const [nodeId, entry] of serviceRegistry) {
      if (nodeId === protocol.NODE_ID) continue;
      const age = now - new Date(entry.lastHeartbeat).getTime();
      if (age > SERVICE_STALE_MS) {
        entry.status = 'offline';
      }
    }
  }, 60000);

  // Registra este nó
  registerSelf();

  // ─── Service Registry Routes ─────────────────────────────────────────

  app.get('/api/services', (_req: Request, res: Response) => {
    const all: Array<Record<string, unknown>> = [];
    for (const [nodeId, entry] of serviceRegistry) {
      for (const svc of entry.services) {
        all.push({
          ...svc,
          nodeId,
          nodeName: entry.name,
          status: entry.status,
          registeredAt: entry.registeredAt,
          lastHeartbeat: entry.lastHeartbeat,
        });
      }
    }
    res.json({ services: all, nodes: serviceRegistry.size });
  });

  app.post('/api/services/register', (req: Request, res: Response) => {
    const { nodeId, name, services } = req.body;
    if (!nodeId || !services || !Array.isArray(services)) {
      return res.status(400).json({ error: 'Campos "nodeId" e "services" (array) são obrigatórios' });
    }
    serviceRegistry.set(nodeId, {
      nodeId,
      name: name || nodeId,
      services,
      registeredAt: new Date().toISOString(),
      lastHeartbeat: new Date().toISOString(),
      status: 'online',
    });
    console.log(`[registry] Nó ${name || nodeId} registrou ${services.length} serviço(s)`);
    res.json({ ok: true, registered: services.length });
  });

  app.post('/api/services/heartbeat', (req: Request, res: Response) => {
    const { nodeId } = req.body;
    if (!nodeId) return res.status(400).json({ error: 'Campo "nodeId" é obrigatório' });
    const entry = serviceRegistry.get(nodeId);
    if (!entry) return res.status(404).json({ error: 'Nó não registrado' });
    entry.lastHeartbeat = new Date().toISOString();
    entry.status = 'online';
    res.json({ ok: true });
  });

  app.delete('/api/services/:nodeId', requireAuth, (req: Request, res: Response) => {
    serviceRegistry.delete(req.params.nodeId);
    res.json({ ok: true });
  });

  // ─── Deploy Routes ───────────────────────────────────────────────────

  app.post('/api/deploy/webhook', (req: Request, res: Response) => {
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);

    if (DEPLOY_SECRET && !verifyGitHubSignature(rawBody, signature)) {
      addDeployLog('error', 'Assinatura inválida no webhook');
      return res.status(403).json({ error: 'Assinatura inválida' });
    }

    let payload: Record<string, unknown>;
    try {
      payload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    } catch {
      payload = {};
    }

    const ref = (payload.ref || '') as string;
    const pusher = (payload.pusher as Record<string, unknown>)?.name || 'unknown';
    const commits = (payload.commits as unknown[])?.length || 0;

    addDeployLog('webhook', `Push de ${pusher}: ${commits} commit(s) em ${ref}`);

    const deployScript = path.join(process.cwd(), 'deploy.sh');
    execFile('bash', [deployScript], { timeout: 60000 }, async (err, stdout, stderr) => {
      if (err) {
        addDeployLog('error', `Deploy falhou: ${err.message}`, { stdout, stderr });
        await notifyDeploy(`FALHOU — ${err.message}`);
        return;
      }
      addDeployLog('deploy', `Deploy OK — ${commits} commit(s) de ${pusher}`, { stdout });
      await notifyDeploy(`OK — ${commits} commit(s) de ${pusher} em ${ref}`);
    });

    res.json({ ok: true, message: 'Deploy iniciado' });
  });

  app.post('/api/deploy/trigger', requireAuth, async (_req: Request, res: Response) => {
    const deployScript = path.join(process.cwd(), 'deploy.sh');

    addDeployLog('deploy', 'Deploy manual iniciado');
    execFile('bash', [deployScript], { timeout: 60000 }, async (err, stdout, stderr) => {
      if (err) {
        addDeployLog('error', `Deploy manual falhou: ${err.message}`, { stdout, stderr });
        await notifyDeploy(`Deploy manual FALHOU — ${err.message}`);
        return;
      }
      addDeployLog('deploy', 'Deploy manual OK', { stdout });
      await notifyDeploy('Deploy manual concluído com sucesso');
    });

    res.json({ ok: true, message: 'Deploy manual iniciado' });
  });

  app.get('/api/deploy/log', (_req: Request, res: Response) => {
    res.json({ log: DEPLOY_LOG });
  });

  app.post('/api/deploy/remote', requireAuth, async (req: Request, res: Response) => {
    try {
      const { target, commands } = req.body;
      if (!commands || !Array.isArray(commands)) {
        return res.status(400).json({ error: 'Campo "commands" (array de strings) é obrigatório' });
      }

      const results: Array<{ command: string; ok: boolean; result?: unknown; error?: string }> = [];
      for (const cmd of commands) {
        try {
          const result = await callMcpTool('run_command', { command: cmd }, req);
          results.push({ command: cmd, ok: true, result });
          addDeployLog('deploy', `Comando remoto OK: ${cmd}`);
        } catch (err) {
          results.push({ command: cmd, ok: false, error: (err as Error).message });
          addDeployLog('error', `Comando remoto falhou: ${cmd} — ${(err as Error).message}`);
        }
      }

      const allOk = results.every(r => r.ok);
      if (allOk) {
        await notifyDeploy(`Deploy remoto${target ? ` em ${target}` : ''} — ${commands.length} comando(s) executados`);
      }

      res.json({ ok: allOk, results });
    } catch (err) {
      res.status(502).json({ error: 'Deploy remoto falhou', detail: (err as Error).message });
    }
  });
}

export default registerServicesDeployRoutes;
