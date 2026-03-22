/**
 * Tulipa Pet API Server
 * Serves the web dashboard and provides WebSocket updates
 */

import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createPetServer(petManager, port = 3333, petNetwork = null) {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });

  // Serve static web dashboard
  app.use(express.static(join(__dirname, '..', 'web')));
  app.use(express.json());

  // API: Get pet state
  app.get('/api/pet', (req, res) => {
    res.json(petManager.getSnapshot());
  });

  // API: Get pet history
  app.get('/api/pet/history', (req, res) => {
    res.json(petManager.getHistory());
  });

  // API: Get raw sensor data
  app.get('/api/sensors', (req, res) => {
    res.json(petManager.getLastSensors());
  });

  // API: Pet interaction (petting, feeding, etc.)
  app.post('/api/pet/interact', (req, res) => {
    const { action } = req.body;
    const result = petManager.interact(action);
    res.json(result);
  });

  // API: List all known pets in the network
  app.get('/api/pets', (req, res) => {
    res.json(petManager.getAllPets());
  });

  // API: List achievements
  app.get('/api/achievements', (req, res) => {
    const all = petManager.getAchievements();
    const unlocked = all.filter(a => a.status === 'unlocked');
    res.json({
      total: all.length,
      unlocked: unlocked.length,
      achievements: all,
    });
  });

  // API: Rename pet
  app.post('/api/pet/name', (req, res) => {
    const { name } = req.body;
    if (name && name.length <= 20) {
      petManager.pet.name = name;
      res.json({ ok: true, name });
    } else {
      res.status(400).json({ error: 'Nome inválido (max 20 chars)' });
    }
  });

  // API: List all discovered peer pets with friendship levels
  app.get('/api/pets/network', (req, res) => {
    if (!petNetwork) {
      return res.json([]);
    }
    res.json(petNetwork.getNetworkPets());
  });

  // API: Send a gift to a peer pet
  app.post('/api/pets/gift', async (req, res) => {
    if (!petNetwork) {
      return res.status(503).json({ error: 'Pet network not available' });
    }
    const { peerId, needKey } = req.body;
    if (!peerId || !needKey) {
      return res.status(400).json({ error: 'peerId and needKey are required' });
    }
    try {
      const result = await petNetwork.sendGift(peerId, needKey);
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // WebSocket: real-time updates
  wss.on('connection', (ws) => {
    // Send initial state
    ws.send(JSON.stringify({
      type: 'state',
      data: petManager.getSnapshot(),
    }));

    ws.on('message', (msg) => {
      try {
        const { action } = JSON.parse(msg);
        if (action) {
          const result = petManager.interact(action);
          ws.send(JSON.stringify({ type: 'interaction', data: result }));
        }
      } catch {
        // ignore invalid messages
      }
    });
  });

  // Broadcast state to all connected clients
  petManager.on('update', (snapshot) => {
    const msg = JSON.stringify({ type: 'state', data: snapshot });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  });

  // Broadcast achievement unlocks to all connected clients
  petManager.on('achievement', (achievement) => {
    const msg = JSON.stringify({ type: 'achievement', data: achievement });
    wss.clients.forEach(client => {
      if (client.readyState === 1) client.send(msg);
    });
  });

  // Broadcast peer updates to all connected WebSocket clients
  if (petNetwork) {
    petNetwork.on('peer-update', (peerData) => {
      const msg = JSON.stringify({ type: 'peer-update', data: peerData });
      wss.clients.forEach(client => {
        if (client.readyState === 1) client.send(msg);
      });
    });
  }

  server.listen(port, () => {
    console.log(`🌷 Tulipa Pet dashboard: http://localhost:${port}`);
  });

  return { app, server, wss };
}
