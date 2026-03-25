// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import type { Application, Request, Response, ServerDeps } from '../types.js';

export function registerTransportRoutes(app: Application, deps: ServerDeps): void {
  const { router, queue, whatsapp, telegram, email, webhook, requireAuth, protocol } = deps;

  // ─── WhatsApp ────────────────────────────────────────────────────────

  app.get('/api/whatsapp/history', requireAuth, async (req: Request, res: Response) => {
    try {
      const { phone, limit } = req.query as { phone?: string; limit?: string };
      const result = await whatsapp.receive(phone, { limit: limit ? parseInt(limit, 10) : undefined });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao buscar histórico', detail: (err as Error).message });
    }
  });

  app.post('/api/whatsapp/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { phone, message } = req.body;
      if (!phone || !message) {
        return res.status(400).json({ error: 'Campos "phone" e "message" são obrigatórios' });
      }
      const result = await router.send(phone, message);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao enviar mensagem', detail: (err as Error).message });
    }
  });

  // ─── Transport Layer ─────────────────────────────────────────────────

  app.get('/api/transport', (_req: Request, res: Response) => {
    res.json(router.toJSON());
  });

  app.get('/api/queue', (_req: Request, res: Response) => {
    res.json(queue.toJSON());
  });

  app.get('/api/transport/health', async (_req: Request, res: Response) => {
    const results = await router.healthCheckAll();
    res.json(results);
  });

  app.post('/api/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { destination, message, type, payload, channel } = req.body;
      if (!destination) {
        return res.status(400).json({ error: 'Campo "destination" é obrigatório' });
      }

      let msg: unknown;
      if (type) {
        msg = protocol.createMessage(type, payload || {}, null, { channel });
      } else if (message) {
        msg = message;
      } else {
        return res.status(400).json({ error: 'Envie "message" ou "type"+"payload"' });
      }

      const result = await router.send(destination, msg, { preferChannel: channel });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao enviar', detail: (err as Error).message });
    }
  });

  // ─── Telegram ────────────────────────────────────────────────────────

  app.post('/api/telegram/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { chatId, message } = req.body;
      if (!message) {
        return res.status(400).json({ error: 'Campo "message" é obrigatório' });
      }
      const dest = chatId || telegram._chatId;
      if (!dest) {
        return res.status(400).json({ error: 'Sem chatId (envie no body ou configure TELEGRAM_CHAT_ID)' });
      }
      const result = await telegram.send(dest, message);
      res.json({ ok: true, channel: 'telegram', result });
    } catch (err) {
      res.status(502).json({ error: 'Falha ao enviar via Telegram', detail: (err as Error).message });
    }
  });

  app.get('/api/telegram/updates', async (req: Request, res: Response) => {
    try {
      const { chatId, limit } = req.query as { chatId?: string; limit?: string };
      const messages = await telegram.receive(chatId, { limit: limit ? parseInt(limit, 10) : 20 });
      res.json({ ok: true, messages });
    } catch (err) {
      res.status(502).json({ error: 'Falha ao buscar updates', detail: (err as Error).message });
    }
  });

  // ─── Email ───────────────────────────────────────────────────────────

  app.post('/api/email/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { to, subject, body, message } = req.body;
      if (!to) return res.status(400).json({ error: 'Campo "to" é obrigatório' });
      const msg = subject ? { subject, body: body || '' } : (message || body || '');
      if (!msg) return res.status(400).json({ error: 'Envie "message" ou "subject"+"body"' });
      const result = await email.send(to, msg);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao enviar email', detail: (err as Error).message });
    }
  });

  app.get('/api/email/search', async (req: Request, res: Response) => {
    try {
      const { query, from, limit } = req.query as { query?: string; from?: string; limit?: string };
      const messages = await email.receive(from, { query, limit: limit ? parseInt(limit, 10) : 10 });
      res.json({ ok: true, messages });
    } catch (err) {
      res.status(502).json({ error: 'Falha ao buscar emails', detail: (err as Error).message });
    }
  });

  app.get('/api/email/drafts', async (_req: Request, res: Response) => {
    try {
      const drafts = await email.listDrafts();
      res.json({ ok: true, drafts });
    } catch (err) {
      res.status(502).json({ error: 'Falha ao listar drafts', detail: (err as Error).message });
    }
  });

  // ─── Webhook ─────────────────────────────────────────────────────────

  app.post('/api/webhook/send', requireAuth, async (req: Request, res: Response) => {
    try {
      const { endpoint, url, message } = req.body;
      if (!message) return res.status(400).json({ error: 'Campo "message" é obrigatório' });
      const dest = endpoint || url || webhook._defaultEndpoint;
      if (!dest) return res.status(400).json({ error: 'Envie "endpoint" (nome) ou "url"' });
      const result = await webhook.send(dest, message);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: 'Falha ao enviar webhook', detail: (err as Error).message });
    }
  });

  app.post('/api/webhook/endpoints', requireAuth, (req: Request, res: Response) => {
    try {
      const { name, url, headers, format, method } = req.body;
      if (!name || !url) return res.status(400).json({ error: 'Campos "name" e "url" são obrigatórios' });
      webhook.addEndpoint(name, { url, headers, format, method });
      if (!router.get('webhook') && webhook.configured) {
        router.register(webhook);
      }
      res.json({ ok: true, endpoints: webhook.listEndpoints() });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  app.get('/api/webhook/endpoints', (_req: Request, res: Response) => {
    res.json({ endpoints: webhook.listEndpoints() });
  });

  app.delete('/api/webhook/endpoints/:name', requireAuth, (req: Request, res: Response) => {
    webhook.removeEndpoint(req.params.name);
    res.json({ ok: true, endpoints: webhook.listEndpoints() });
  });

  app.post('/api/webhook/incoming/:source', (req: Request, res: Response) => {
    const source = req.params.source;
    const payload = req.body;
    console.log(`[webhook] Incoming de ${source}: ${JSON.stringify(payload).slice(0, 100)}`);
    webhook.emit('incoming', { source, payload });
    res.json({ ok: true, received: true });
  });
}

export default registerTransportRoutes;
