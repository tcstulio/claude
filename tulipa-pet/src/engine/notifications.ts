/**
 * Proactive WhatsApp Notification System
 * Monitors pet state and sends WhatsApp messages via Tulipa MCP API
 * when critical events occur. The pet talks in first person, like a
 * Tamagotchi that can text you!
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { PetManager } from './pet-manager.js';
import type { PetState, PetSnapshot, SensorReadings, NeedKey } from './pet-state.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const NOTIFICATIONS_FILE = join(DATA_DIR, 'notifications.json');

const TULIPA_ENDPOINT = process.env.TULIPA_ENDPOINT || 'https://agent.coolgroove.com.br';
const TULIPA_TOKEN = process.env.TULIPA_TOKEN;
const OWNER_PHONE = process.env.TULIPA_OWNER_PHONE || null;

// Rate limiting
const MAX_PER_NEED_MS = 60 * 60 * 1000;   // 1 hour between same-need alerts
const MAX_DAILY_MESSAGES = 10;
const HISTORY_MAX = 50;

// ── Interfaces ────────────────────────────────────────────────

export interface NotificationHistoryEntry {
  time: string;
  category: string;
  message: string;
  sent: boolean;
}

interface NotificationPersistedState {
  history?: NotificationHistoryEntry[];
  lastNotification?: Record<string, number>;
  dailyCount?: number;
  dailyCountDate?: string;
}

type CriticalMessageFn = (value: number, sensors?: SensorReadings) => string;
type RecoveryMessageFn = (value: number) => string;

// ── Message templates ─────────────────────────────────────────

// Critical need message templates — fun first-person pet messages
const CRITICAL_MESSAGES: Record<NeedKey, CriticalMessageFn> = {
  energia: (value) => {
    const msgs = [
      `⚡ Minha energia tá em ${value}%! Me ajuda!`,
      `⚡ Tô quase apagando... energia em ${value}%! Preciso de carga!`,
      `⚡ S.O.S.! Energia em ${value}%... tô ficando com sono 😴`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
  saude: (value, sensors) => {
    if (sensors?.temperature && sensors.temperature > 80) {
      return `🌡️ Tô com febre! Temperatura do servidor em ${Math.round(sensors.temperature)}°C!`;
    }
    const msgs = [
      `❤️ Minha saúde tá em ${value}%... não tô me sentindo bem 🤒`,
      `❤️ Preciso de cuidados! Saúde caiu pra ${value}%`,
      `❤️ Acho que preciso de um médico... saúde em ${value}%`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
  seguranca: (value, sensors) => {
    if (sensors?.failedLogins && sensors.failedLogins > 3) {
      return `🛡️ Alerta! ${sensors.failedLogins} tentativas de login falharam na última hora!`;
    }
    const msgs = [
      `🛡️ Tô me sentindo vulnerável... segurança em ${value}%!`,
      `🛡️ Alerta de segurança! Nível em ${value}%. Dá uma olhada?`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
  limpeza: (value, sensors) => {
    if (sensors?.diskUsage && sensors.diskUsage > 90) {
      return `💾 Disco quase cheio (${Math.round(sensors.diskUsage)}%)! Preciso de uma faxina!`;
    }
    const msgs = [
      `🧹 Tô precisando de uma faxina! Limpeza em ${value}%`,
      `🧹 Acumulei muita sujeira... limpeza em ${value}%. Me dá um banho?`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
  humor: (value) => {
    const msgs = [
      `🎭 Tô pra baixo... humor em ${value}%. Vem brincar comigo?`,
      `🎭 Tô entediado demais! Humor caiu pra ${value}%...`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
  social: (value) => {
    const msgs = [
      `💬 Tô me sentindo sozinho... ninguém fala comigo há um tempão 😢`,
      `💬 Social em ${value}%... sinto falta de companhia!`,
    ];
    return msgs[Math.floor(Math.random() * msgs.length)];
  },
};

const RECOVERY_MESSAGES: Record<NeedKey, RecoveryMessageFn> = {
  energia:   (value) => `😊 Me recuperei! Energia de volta a ${value}%! Tô ligadão! ⚡`,
  saude:     (value) => `😊 Me recuperei! Saúde de volta a ${value}%! Tô me sentindo ótimo! ❤️`,
  seguranca: (value) => `😊 Segurança restaurada! Tô em ${value}% agora. Pode ficar tranquilo! 🛡️`,
  limpeza:   (value) => `😊 Faxina feita! Limpeza em ${value}%! Tô brilhando! ✨`,
  humor:     (value) => `😊 Voltei pro alto astral! Humor em ${value}%! 🎉`,
  social:    (value) => `😊 Me sinto amado de novo! Social em ${value}%! 💕`,
};

export class NotificationManager {
  petManager: PetManager;
  pet: PetState;
  history: NotificationHistoryEntry[];
  lastNotification: Record<string, number>;
  dailyCount: number;
  dailyCountDate: string;
  dailySummaryHour: number;

  private _running: boolean;
  private _timers: ReturnType<typeof setInterval>[];
  private _previousNeeds: Record<string, number>;
  private _wasCritical: Set<string>;
  private _knownPeers: Set<string>;
  private _onUpdate: ((snapshot: PetSnapshot) => void) | null;

  constructor(petManager: PetManager) {
    this.petManager = petManager;
    this.pet = petManager.pet;

    // State
    this._running = false;
    this._timers = [];
    this._previousNeeds = {};
    this._wasCritical = new Set();
    this._knownPeers = new Set();
    this._onUpdate = null;

    // Load persisted state
    const saved = this._load();
    this.history = saved.history || [];
    this.lastNotification = saved.lastNotification || {};
    this.dailyCount = saved.dailyCount || 0;
    this.dailyCountDate = saved.dailyCountDate || this._todayStr();
    this.dailySummaryHour = parseInt(process.env.TULIPA_SUMMARY_HOUR ?? '', 10) || 9;

    // Snapshot current needs so first tick doesn't fire false recoveries
    this._snapshotNeeds();
  }

  // ── Lifecycle ──────────────────────────────────────────────

  start(): void {
    if (this._running) return;
    this._running = true;

    // Listen to pet updates
    this._onUpdate = (snapshot: PetSnapshot) => this._checkSnapshot(snapshot);
    this.petManager.on('update', this._onUpdate);

    // Daily summary scheduler — check every minute
    this._timers.push(setInterval(() => this._checkDailySummary(), 60_000));

    // Persist state every 5 minutes
    this._timers.push(setInterval(() => this._save(), 300_000));

    console.log('📱 NotificationManager started — monitoring pet state');
    console.log(`   Daily summary at ${this.dailySummaryHour}:00`);
  }

  stop(): void {
    this._running = false;
    this._timers.forEach(t => clearInterval(t));
    this._timers = [];
    if (this._onUpdate) {
      this.petManager.off('update', this._onUpdate);
      this._onUpdate = null;
    }
    this._save();
    console.log('📱 NotificationManager stopped');
  }

  // ── Public API ─────────────────────────────────────────────

  /**
   * Send a notification with rate limiting.
   * @returns true if sent, false if rate-limited
   */
  async notify(category: string, message: string): Promise<boolean> {
    // Reset daily counter if new day
    if (this._todayStr() !== this.dailyCountDate) {
      this.dailyCount = 0;
      this.dailyCountDate = this._todayStr();
    }

    // Rate limit: max per category per hour
    const lastTime = this.lastNotification[category] || 0;
    if (Date.now() - lastTime < MAX_PER_NEED_MS) {
      console.log(`📱 Rate limited [${category}]: ${message.slice(0, 50)}...`);
      return false;
    }

    // Rate limit: max daily
    if (this.dailyCount >= MAX_DAILY_MESSAGES) {
      console.log(`📱 Daily limit reached (${MAX_DAILY_MESSAGES}), skipping: ${message.slice(0, 50)}...`);
      return false;
    }

    const sent = await this._sendWhatsApp(message);
    if (sent) {
      this.lastNotification[category] = Date.now();
      this.dailyCount++;
      this._addToHistory(category, message, true);
      this._save();
    } else {
      this._addToHistory(category, message, false);
    }
    return sent;
  }

  /**
   * Force send daily summary (bypasses rate limiting, doesn't count toward daily limit).
   */
  async sendDailySummary(): Promise<boolean> {
    const snapshot = this.petManager.getSnapshot();
    const age = snapshot.age;
    const mood = snapshot.mood;
    const stage = snapshot.stage;

    // Build needs summary
    const needsLines = Object.entries(snapshot.needs)
      .map(([_key, n]) => {
        const bar = this._progressBar(n.value);
        return `${n.icon} ${n.label}: ${bar} ${n.value}%`;
      })
      .join('\n');

    // Today's achievements
    const todayEvents = (this.pet.events || [])
      .filter(e => {
        const eventDate = new Date(e.time).toDateString();
        return eventDate === new Date().toDateString();
      });

    const achievementEvents = todayEvents.filter(e => e.type === 'achievement');
    const achievementsLine = achievementEvents.length > 0
      ? `\n🏆 Conquistas hoje: ${achievementEvents.map(a => a.message).join(', ')}`
      : '';

    const interactionCount = todayEvents.filter(e => e.type === 'interaction').length;

    // Economy data from last sensors
    const sensors = this.petManager.getLastSensors();
    const economyLines = [];
    if (sensors.mcpCalls !== undefined) {
      const errRate = sensors.mcpCalls > 0
        ? `(${((sensors.mcpErrors || 0) / sensors.mcpCalls * 100).toFixed(1)}% erro)`
        : '';
      economyLines.push(`⚙️ MCP: ${sensors.mcpCalls} chamadas ${errRate}`);
    }
    if (sensors.messagesRouted !== undefined) {
      economyLines.push(`📨 Mensagens roteadas: ${sensors.messagesRouted}`);
    }
    if (sensors.cpuUsage !== undefined) {
      economyLines.push(`🖥️ CPU: ${sensors.cpuUsage}%${sensors.peakCpuPercent ? ` (pico: ${Math.round(sensors.peakCpuPercent)}%)` : ''}`);
    }
    if (sensors.processRss !== undefined) {
      const mb = Math.round(sensors.processRss / (1024 * 1024));
      economyLines.push(`🧠 RAM processo: ${mb}MB`);
    }
    const economySection = economyLines.length > 0
      ? `\n*Economia:*\n${economyLines.join('\n')}`
      : '';

    const message = [
      `🌅 Bom dia! Aqui é o ${snapshot.name}!`,
      ``,
      `📊 *Resumo do dia*`,
      `${mood.face} Humor: ${mood.name}`,
      `🎮 Level ${snapshot.level} | XP: ${snapshot.xp}`,
      `${stage.sprite} Estágio: ${stage.name}`,
      `📅 Idade: ${age.total}`,
      ``,
      `*Minhas necessidades:*`,
      needsLines,
      ``,
      `🎯 Score geral: ${snapshot.overallScore}%`,
      `🤝 Interações hoje: ${interactionCount}`,
      achievementsLine,
      economySection,
      ``,
      `Me cuida! 🌷`,
    ].filter(line => line !== undefined).join('\n');

    const sent = await this._sendWhatsApp(message);
    this._addToHistory('daily_summary', message, sent);
    this._save();
    return sent;
  }

  /**
   * Get last 50 notification records.
   */
  getNotificationHistory(): NotificationHistoryEntry[] {
    return this.history.slice(0, HISTORY_MAX);
  }

  // ── Monitoring Logic ───────────────────────────────────────

  private _checkSnapshot(snapshot: PetSnapshot): void {
    const sensors = this.petManager.getLastSensors();

    // 1. Check critical needs (below 15%)
    for (const [key, need] of Object.entries(snapshot.needs)) {
      const value = need.value;
      const prevValue = this._previousNeeds[key] ?? value;

      // Critical: dropped below 15%
      if (value < 15) {
        if (!this._wasCritical.has(key)) {
          const msgFn = CRITICAL_MESSAGES[key as NeedKey];
          if (msgFn) {
            const msg = msgFn(value, sensors);
            this.notify(`critical:${key}`, msg);
          }
          this._wasCritical.add(key);
        }
      }

      // Recovery: was critical, now above 60%
      if (this._wasCritical.has(key) && value > 60) {
        const msgFn = RECOVERY_MESSAGES[key as NeedKey];
        if (msgFn) {
          const msg = msgFn(value);
          this.notify(`recovery:${key}`, msg);
        }
        this._wasCritical.delete(key);
      }

      this._previousNeeds[key] = value;
    }

    // 2. Check for new achievements
    const recentEvents = (this.pet.events || []).slice(0, 5);
    for (const event of recentEvents) {
      if (event.type === 'achievement' && !event._notified) {
        const msg = `🏆 Conquista desbloqueada: ${event.message}`;
        this.notify('achievement', msg);
        event._notified = true;
      }
    }

    // 3. Check for new peers (social)
    const allPets = this.petManager.getAllPets();
    for (const pet of allPets) {
      if (pet.agentId !== this.pet.agentId && !this._knownPeers.has(pet.agentId)) {
        this._knownPeers.add(pet.agentId);
        const peerName = pet.name || `Tulipa-${pet.agentId.slice(-4)}`;
        const msg = `👋 ${peerName} apareceu na rede! Fizemos amizade! 🌷`;
        this.notify('social', msg);
      }
    }
  }

  private _snapshotNeeds(): void {
    const snapshot = this.petManager.getSnapshot();
    for (const [key, need] of Object.entries(snapshot.needs)) {
      this._previousNeeds[key] = need.value;
      if (need.value < 15) {
        this._wasCritical.add(key);
      }
    }
  }

  private _checkDailySummary(): void {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Send at the configured hour, first minute window
    if (hour === this.dailySummaryHour && minute === 0) {
      const todayKey = `daily_${this._todayStr()}`;
      if (!this.lastNotification[todayKey]) {
        this.lastNotification[todayKey] = Date.now();
        this.sendDailySummary();
      }
    }
  }

  // ── WhatsApp API ───────────────────────────────────────────

  private async _sendWhatsApp(message: string): Promise<boolean> {
    if (!TULIPA_TOKEN) {
      console.log('📱 [DRY RUN] No TULIPA_TOKEN set. Would send:', message.slice(0, 80));
      return false;
    }

    try {
      const payload = {
        jsonrpc: '2.0',
        method: 'tools/call',
        id: Date.now(),
        params: {
          name: 'send_whatsapp',
          arguments: {
            message,
            ...(OWNER_PHONE ? { phone: OWNER_PHONE } : {}),
          },
        },
      };

      const response = await fetch(`${TULIPA_ENDPOINT}/mcp`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${TULIPA_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        console.error(`📱 WhatsApp send failed: HTTP ${response.status}`);
        return false;
      }

      const result = await response.json() as { error?: { message?: string } };
      if (result.error) {
        console.error('📱 WhatsApp MCP error:', result.error.message || result.error);
        return false;
      }

      console.log('📱 WhatsApp sent:', message.slice(0, 60));
      return true;
    } catch (err) {
      console.error('📱 WhatsApp send error:', (err as Error).message);
      return false;
    }
  }

  // ── Persistence ────────────────────────────────────────────

  private _load(): NotificationPersistedState {
    try {
      if (existsSync(NOTIFICATIONS_FILE)) {
        return JSON.parse(readFileSync(NOTIFICATIONS_FILE, 'utf-8'));
      }
    } catch (e) {
      console.error('Failed to load notification state:', (e as Error).message);
    }
    return {};
  }

  private _save(): void {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      const state: NotificationPersistedState = {
        history: this.history.slice(0, HISTORY_MAX),
        lastNotification: this.lastNotification,
        dailyCount: this.dailyCount,
        dailyCountDate: this.dailyCountDate,
      };
      writeFileSync(NOTIFICATIONS_FILE, JSON.stringify(state, null, 2));
    } catch (e) {
      console.error('Failed to save notification state:', (e as Error).message);
    }
  }

  private _addToHistory(category: string, message: string, sent: boolean): void {
    this.history.unshift({
      time: new Date().toISOString(),
      category,
      message,
      sent,
    });
    if (this.history.length > HISTORY_MAX) {
      this.history = this.history.slice(0, HISTORY_MAX);
    }
  }

  // ── Helpers ────────────────────────────────────────────────

  private _todayStr(): string {
    return new Date().toISOString().slice(0, 10);
  }

  private _progressBar(value: number): string {
    const filled = Math.round(value / 10);
    const empty = 10 - filled;
    return '█'.repeat(filled) + '░'.repeat(empty);
  }
}
