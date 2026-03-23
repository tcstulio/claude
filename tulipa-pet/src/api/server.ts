/**
 * Tulipa Pet API Server
 * Serves the web dashboard and provides WebSocket updates
 */

import express, { Request, Response } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer, Server } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import type { Express } from 'express';
import type { EventEmitter } from 'events';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface PetManager extends EventEmitter {
  getSnapshot(): unknown;
  getHistory(): unknown;
  getLastSensors(): unknown;
  interact(action: string): unknown;
  getAllPets(): unknown;
  getAchievements(): unknown[];
  pet: { name: string };
}

interface PetNetwork extends EventEmitter {
  getNetworkPets(): unknown;
  sendGift(peerId: string, needKey: string): Promise<unknown>;
}

interface WsMessage {
  type: string;
  data: unknown;
}

interface InteractBody {
  action: string;
}

interface NameBody {
  name: string;
}

interface GiftBody {
  peerId: string;
  needKey: string;
}

interface PetDaemon {
  getProcessSnapshot(): Record<string, unknown>;
  getRestartHistory(): unknown[];
  getSensorContribution(): unknown;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

interface PetServerResult {
  app: Express;
  server: Server;
  wss: WebSocketServer;
}

export function createPetServer(
  petManager: PetManager,
  port: number = 3333,
  petNetwork: PetNetwork | null = null,
  daemon: PetDaemon | null = null
): PetServerResult {
  const app: Express = express();
  const server: Server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Serve static web dashboard
  app.use(express.static(join(__dirname, '..', 'web')));
  app.use(express.json());

  // API: Get pet state
  app.get('/api/pet', (_req: Request, res: Response) => {
    res.json(petManager.getSnapshot());
  });

  // API: Get pet history
  app.get('/api/pet/history', (_req: Request, res: Response) => {
    res.json(petManager.getHistory());
  });

  // API: Get raw sensor data
  app.get('/api/sensors', (_req: Request, res: Response) => {
    res.json(petManager.getLastSensors());
  });

  // API: Pet interaction (petting, feeding, etc.)
  app.post('/api/pet/interact', (req: Request, res: Response) => {
    const { action } = req.body as InteractBody;
    const result = petManager.interact(action);
    res.json(result);
  });

  // API: List all known pets in the network
  app.get('/api/pets', (_req: Request, res: Response) => {
    res.json(petManager.getAllPets());
  });

  // API: List achievements
  app.get('/api/achievements', (_req: Request, res: Response) => {
    const all = petManager.getAchievements() as Array<{ status: string }>;
    const unlocked = all.filter(a => a.status === 'unlocked');
    res.json({
      total: all.length,
      unlocked: unlocked.length,
      achievements: all,
    });
  });

  // API: Rename pet
  app.post('/api/pet/name', (req: Request, res: Response) => {
    const { name } = req.body as NameBody;
    if (name && name.length <= 20) {
      petManager.pet.name = name;
      res.json({ ok: true, name });
    } else {
      res.status(400).json({ error: 'Nome inválido (max 20 chars)' });
    }
  });

  // API: List all discovered peer pets with friendship levels
  app.get('/api/pets/network', (_req: Request, res: Response) => {
    if (!petNetwork) {
      res.json([]);
      return;
    }
    res.json(petNetwork.getNetworkPets());
  });

  // API: Send a gift to a peer pet
  app.post('/api/pets/gift', async (req: Request, res: Response) => {
    if (!petNetwork) {
      res.status(503).json({ error: 'Pet network not available' });
      return;
    }
    const { peerId, needKey } = req.body as GiftBody;
    if (!peerId || !needKey) {
      res.status(400).json({ error: 'peerId and needKey are required' });
      return;
    }
    try {
      const result = await petNetwork.sendGift(peerId, needKey);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // API: Process/service monitoring (from daemon)
  app.get('/api/processes', (_req: Request, res: Response) => {
    if (!daemon) {
      res.status(503).json({ error: 'Daemon not running' });
      return;
    }
    res.json(daemon.getProcessSnapshot());
  });

  // API: Daemon sensor contribution to pet
  app.get('/api/daemon/sensors', (_req: Request, res: Response) => {
    if (!daemon) {
      res.status(503).json({ error: 'Daemon not running' });
      return;
    }
    res.json(daemon.getSensorContribution());
  });

  // API: Restart history
  app.get('/api/daemon/restarts', (_req: Request, res: Response) => {
    if (!daemon) {
      res.json([]);
      return;
    }
    res.json(daemon.getRestartHistory());
  });

  // WebSocket: real-time updates
  wss.on('connection', (ws: WebSocket) => {
    // Send initial state
    const initMsg: WsMessage = {
      type: 'state',
      data: petManager.getSnapshot(),
    };
    ws.send(JSON.stringify(initMsg));

    ws.on('message', (msg: Buffer | string) => {
      try {
        const { action } = JSON.parse(msg.toString()) as InteractBody;
        if (action) {
          const result = petManager.interact(action);
          const responseMsg: WsMessage = { type: 'interaction', data: result };
          ws.send(JSON.stringify(responseMsg));
        }
      } catch {
        // ignore invalid messages
      }
    });
  });

  // Broadcast state to all connected clients
  petManager.on('update', (snapshot: unknown) => {
    const msg = JSON.stringify({ type: 'state', data: snapshot } as WsMessage);
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  });

  // Broadcast achievement unlocks to all connected clients
  petManager.on('achievement', (achievement: unknown) => {
    const msg = JSON.stringify({ type: 'achievement', data: achievement } as WsMessage);
    wss.clients.forEach((client: WebSocket) => {
      if (client.readyState === WebSocket.OPEN) client.send(msg);
    });
  });

  // Broadcast peer updates to all connected WebSocket clients
  if (petNetwork) {
    petNetwork.on('peer-update', (peerData: unknown) => {
      const msg = JSON.stringify({ type: 'peer-update', data: peerData } as WsMessage);
      wss.clients.forEach((client: WebSocket) => {
        if (client.readyState === WebSocket.OPEN) client.send(msg);
      });
    });
  }

  // Broadcast daemon events (service status changes, restarts)
  if (daemon) {
    for (const eventName of ['service-event', 'critical-alert', 'restart-attempt', 'hot-update', 'build-success', 'build-error']) {
      daemon.on(eventName, (data: unknown) => {
        const msg = JSON.stringify({ type: `daemon:${eventName}`, data } as WsMessage);
        wss.clients.forEach((client: WebSocket) => {
          if (client.readyState === WebSocket.OPEN) client.send(msg);
        });
      });
    }
  }

  server.listen(port, () => {
    console.log(`🌷 Tulipa Pet dashboard: http://localhost:${port}`);
  });

  return { app, server, wss };
}
