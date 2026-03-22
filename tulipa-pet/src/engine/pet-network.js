/**
 * Pet Network — Peer-to-peer pet sync system for the Tulipa network.
 *
 * Discovers other Tulipa pets via the MCP API, broadcasts own state,
 * triggers social interactions, and tracks friendships between pets.
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const FRIENDSHIPS_FILE = join(DATA_DIR, 'friendships.json');

const TULIPA_ENDPOINT = process.env.TULIPA_ENDPOINT || 'https://agent.coolgroove.com.br';
const TULIPA_TOKEN = process.env.TULIPA_TOKEN || '';

const SYNC_INTERVAL = 120_000; // 2 minutes
const SOCIAL_BOOST = 10;
const HUMOR_BOOST = 8;
const GIFT_BOOST = 15;
const FRIENDSHIP_PER_ENCOUNTER = 1;

/**
 * Call a Tulipa MCP tool via JSON-RPC 2.0.
 */
async function mcpCall(method, toolName, args = {}) {
  const res = await fetch(`${TULIPA_ENDPOINT}/mcp`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TULIPA_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: method,
      id: Date.now(),
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    throw new Error(`MCP call failed: ${res.status} ${res.statusText}`);
  }

  return res.json();
}

export class PetNetwork extends EventEmitter {
  constructor(petManager) {
    super();
    this.petManager = petManager;
    this.peers = new Map();         // peerId -> { snapshot, lastSeen }
    this.friendships = this._loadFriendships();
    this._timers = [];
    this._running = false;
  }

  // ── Lifecycle ────────────────────────────────────────────────

  start() {
    if (this._running) return;
    this._running = true;

    // Initial sync
    this._syncCycle();

    // Periodic sync every 2 minutes
    const timer = setInterval(() => this._syncCycle(), SYNC_INTERVAL);
    this._timers.push(timer);

    console.log(`🌐 Pet network started (sync every ${SYNC_INTERVAL / 1000}s)`);
  }

  stop() {
    this._running = false;
    this._timers.forEach(t => clearInterval(t));
    this._timers = [];
    this._saveFriendships();
    console.log('🌐 Pet network stopped');
  }

  // ── Main sync cycle ──────────────────────────────────────────

  async _syncCycle() {
    try {
      await this.broadcastState();
      await this.discoverPeers();
    } catch (err) {
      console.error('Network sync error:', err.message);
    }
  }

  // ── Broadcast ────────────────────────────────────────────────

  /**
   * Send own pet snapshot to the Tulipa network via MCP `send_prompt`.
   * Other agents can pick this up from the task system.
   */
  async broadcastState() {
    const snapshot = this.petManager.getSnapshot();
    const payload = JSON.stringify({
      type: 'tulipa-pet-state',
      version: 1,
      timestamp: Date.now(),
      pet: snapshot,
    });

    try {
      await mcpCall('tools/call', 'send_prompt', {
        prompt: `[TULIPA-PET-BROADCAST] ${payload}`,
      });
    } catch (err) {
      console.error('Broadcast error:', err.message);
    }
  }

  // ── Discovery ────────────────────────────────────────────────

  /**
   * Query the Tulipa network for other pets using list_peers and list_tasks.
   */
  async discoverPeers() {
    try {
      // Get peers on the network
      const peersRes = await mcpCall('tools/call', 'list_peers', {});
      const peers = peersRes?.result?.content || peersRes?.result || [];

      // Get tasks which may contain pet broadcasts from other agents
      const tasksRes = await mcpCall('tools/call', 'list_tasks', {});
      const tasks = tasksRes?.result?.content || tasksRes?.result || [];

      // Extract pet states from task data
      const petBroadcasts = this._extractPetBroadcasts(tasks);

      // Also try to identify peers that may have pets
      const peerList = Array.isArray(peers) ? peers : [];

      // Process discovered pet broadcasts
      for (const broadcast of petBroadcasts) {
        const { pet } = broadcast;
        if (!pet || !pet.agentId) continue;

        // Skip our own broadcasts
        if (pet.agentId === this.petManager.pet.agentId) continue;

        const peerId = pet.agentId;
        const wasKnown = this.peers.has(peerId);
        const prevSeen = wasKnown ? this.peers.get(peerId).lastSeen : 0;

        // Update peer record
        this.peers.set(peerId, {
          snapshot: pet,
          lastSeen: broadcast.timestamp || Date.now(),
        });

        // Register in petManager
        this.petManager.registerPeerPet(pet);

        // Trigger social interaction if peer is recently active (within 5 min)
        const isRecent = (Date.now() - (broadcast.timestamp || 0)) < 300_000;
        if (isRecent) {
          this._handleSocialInteraction(peerId, pet);
        }

        // Emit peer update
        this.emit('peer-update', {
          peerId,
          snapshot: pet,
          friendship: this.friendships[peerId] || { level: 0, encounters: 0 },
          isNew: !wasKnown,
        });
      }

      // Prune stale peers (not seen in 10 minutes)
      const staleThreshold = Date.now() - 600_000;
      for (const [id, peer] of this.peers) {
        if (peer.lastSeen < staleThreshold) {
          this.peers.delete(id);
        }
      }

    } catch (err) {
      console.error('Discovery error:', err.message);
    }
  }

  /**
   * Parse pet broadcast messages from the Tulipa task system.
   */
  _extractPetBroadcasts(tasks) {
    const broadcasts = [];
    const items = Array.isArray(tasks) ? tasks : [];

    for (const task of items) {
      try {
        // Tasks may have different shapes; look for pet broadcast marker
        const content = typeof task === 'string'
          ? task
          : (task.content || task.prompt || task.message || task.data || '');

        const str = typeof content === 'string' ? content : JSON.stringify(content);

        const marker = '[TULIPA-PET-BROADCAST]';
        const idx = str.indexOf(marker);
        if (idx === -1) continue;

        const jsonStr = str.slice(idx + marker.length).trim();
        const data = JSON.parse(jsonStr);

        if (data.type === 'tulipa-pet-state' && data.pet) {
          broadcasts.push(data);
        }
      } catch {
        // Skip unparseable tasks
      }
    }

    return broadcasts;
  }

  // ── Social interactions ──────────────────────────────────────

  /**
   * When two pets are online simultaneously, boost their social/humor
   * and update friendship levels.
   */
  _handleSocialInteraction(peerId, peerSnapshot) {
    // Initialize friendship if needed
    if (!this.friendships[peerId]) {
      this.friendships[peerId] = {
        level: 0,
        encounters: 0,
        lastEncounter: 0,
        peerName: peerSnapshot.name || `Tulipa-${peerId.slice(-4)}`,
        gifts: { sent: 0, received: 0 },
      };
    }

    const friendship = this.friendships[peerId];

    // Only count one encounter per sync cycle (avoid double counting)
    const now = Date.now();
    if (now - friendship.lastEncounter < SYNC_INTERVAL * 0.8) {
      return; // Already interacted recently
    }

    friendship.encounters += 1;
    friendship.level += FRIENDSHIP_PER_ENCOUNTER;
    friendship.lastEncounter = now;
    friendship.peerName = peerSnapshot.name || friendship.peerName;

    // Boost own pet's social and humor needs
    const pet = this.petManager.pet;
    pet.needs.social.value = Math.min(100, pet.needs.social.value + SOCIAL_BOOST);
    pet.needs.humor.value = Math.min(100, pet.needs.humor.value + HUMOR_BOOST);

    // Award XP for social interaction
    pet.xp += 2;

    // Generate fun event
    const ownName = pet.name;
    const peerName = peerSnapshot.name || `Tulipa-${peerId.slice(-4)}`;
    const events = [
      `${peerName} visitou ${ownName}!`,
      `${ownName} encontrou ${peerName} na rede!`,
      `${ownName} e ${peerName} brincaram juntos!`,
      `${peerName} mandou uma mensagem para ${ownName}!`,
      `${ownName} fez amizade com ${peerName}!`,
    ];
    const eventMsg = events[Math.floor(Math.random() * events.length)];
    pet.addEvent('social', eventMsg);

    // Bonus for milestone friendships
    if (friendship.level === 5) {
      pet.addEvent('friendship', `${ownName} e ${peerName} agora são amigos!`);
      pet.xp += 10;
    } else if (friendship.level === 20) {
      pet.addEvent('friendship', `${ownName} e ${peerName} agora são melhores amigos!`);
      pet.xp += 25;
    } else if (friendship.level === 50) {
      pet.addEvent('friendship', `${ownName} e ${peerName} têm uma amizade lendária!`);
      pet.xp += 50;
    }

    this._saveFriendships();
  }

  // ── Gifting ──────────────────────────────────────────────────

  /**
   * Send a gift to a peer pet — boosts a specific need of the other pet.
   * The gift is delivered via MCP send_prompt so the peer can process it.
   */
  async sendGift(peerId, needKey) {
    const validNeeds = ['energia', 'limpeza', 'saude', 'seguranca', 'humor', 'social'];
    if (!validNeeds.includes(needKey)) {
      throw new Error(`Invalid need key: ${needKey}. Valid: ${validNeeds.join(', ')}`);
    }

    if (!this.peers.has(peerId) && !this.friendships[peerId]) {
      throw new Error(`Unknown peer: ${peerId}`);
    }

    const ownPet = this.petManager.pet;
    const peerName = this.friendships[peerId]?.peerName || `Tulipa-${peerId.slice(-4)}`;

    // Build gift payload
    const giftPayload = JSON.stringify({
      type: 'tulipa-pet-gift',
      version: 1,
      timestamp: Date.now(),
      from: {
        agentId: ownPet.agentId,
        name: ownPet.name,
      },
      to: {
        agentId: peerId,
      },
      gift: {
        needKey,
        boost: GIFT_BOOST,
      },
    });

    // Send via MCP
    await mcpCall('tools/call', 'send_prompt', {
      prompt: `[TULIPA-PET-GIFT] ${giftPayload}`,
    });

    // Update friendship
    if (!this.friendships[peerId]) {
      this.friendships[peerId] = {
        level: 0,
        encounters: 0,
        lastEncounter: 0,
        peerName,
        gifts: { sent: 0, received: 0 },
      };
    }
    this.friendships[peerId].gifts.sent += 1;
    this.friendships[peerId].level += 2; // Gifts boost friendship more

    // Own pet gets a small humor boost for generosity
    ownPet.needs.humor.value = Math.min(100, ownPet.needs.humor.value + 5);
    ownPet.xp += 3;
    ownPet.addEvent('gift', `${ownPet.name} enviou um presente de ${needKey} para ${peerName}!`);

    this._saveFriendships();

    return {
      ok: true,
      message: `Presente de ${needKey} enviado para ${peerName}!`,
      friendship: this.friendships[peerId],
    };
  }

  // ── Friendships ──────────────────────────────────────────────

  getFriendships() {
    return { ...this.friendships };
  }

  _loadFriendships() {
    try {
      if (existsSync(FRIENDSHIPS_FILE)) {
        return JSON.parse(readFileSync(FRIENDSHIPS_FILE, 'utf-8'));
      }
    } catch (err) {
      console.error('Failed to load friendships:', err.message);
    }
    return {};
  }

  _saveFriendships() {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(FRIENDSHIPS_FILE, JSON.stringify(this.friendships, null, 2));
    } catch (err) {
      console.error('Failed to save friendships:', err.message);
    }
  }

  // ── Public getters ───────────────────────────────────────────

  /**
   * Return all discovered peers with friendship data for the API.
   */
  getNetworkPets() {
    const result = [];
    for (const [peerId, peer] of this.peers) {
      result.push({
        peerId,
        snapshot: peer.snapshot,
        lastSeen: peer.lastSeen,
        friendship: this.friendships[peerId] || {
          level: 0,
          encounters: 0,
          lastEncounter: 0,
          peerName: peer.snapshot?.name || `Tulipa-${peerId.slice(-4)}`,
          gifts: { sent: 0, received: 0 },
        },
      });
    }

    // Also include peers from friendships that aren't currently online
    for (const [peerId, friendship] of Object.entries(this.friendships)) {
      if (!this.peers.has(peerId)) {
        result.push({
          peerId,
          snapshot: null,
          lastSeen: friendship.lastEncounter,
          online: false,
          friendship,
        });
      }
    }

    return result;
  }
}
