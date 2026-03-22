/**
 * Achievements / Conquistas System
 * Tracks and awards achievements based on pet state, sensors, and history.
 * Persists to data/achievements.json
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const ACHIEVEMENTS_FILE = join(DATA_DIR, 'achievements.json');

/**
 * Achievement definitions organized by category.
 * Each achievement has:
 *   id, name, description, icon, category, condition(ctx), progressive (optional)
 *
 * condition(ctx) receives { petState, sensors, history, tracker, now }
 *   - returns true/false for instant achievements
 *   - for progressive ones, returns a number (current progress value)
 */
const ACHIEVEMENT_DEFS = [
  // ── Sobrevivencia ──────────────────────────────────────────
  {
    id: 'primeiro_dia',
    name: 'Primeiro Dia',
    description: 'Pet sobreviveu 24 horas',
    icon: '🐣',
    category: 'Sobrevivência',
    target: 1,
    condition: ({ petState }) => {
      const age = petState.getAge();
      return age.days >= 1;
    },
  },
  {
    id: 'uma_semana',
    name: 'Uma Semana',
    description: '7 dias online',
    icon: '📅',
    category: 'Sobrevivência',
    target: 7,
    progressive: true,
    condition: ({ petState }) => {
      return petState.getAge().days;
    },
  },
  {
    id: 'veterano',
    name: 'Veterano',
    description: '30 dias online',
    icon: '🎖️',
    category: 'Sobrevivência',
    target: 30,
    progressive: true,
    condition: ({ petState }) => {
      return petState.getAge().days;
    },
  },
  {
    id: 'imortal',
    name: 'Imortal',
    description: '100 dias online',
    icon: '♾️',
    category: 'Sobrevivência',
    target: 100,
    progressive: true,
    condition: ({ petState }) => {
      return petState.getAge().days;
    },
  },

  // ── Saude Perfeita ─────────────────────────────────────────
  {
    id: 'zen',
    name: 'Zen',
    description: 'Todas as necessidades acima de 80% por 1 hora',
    icon: '🧘',
    category: 'Saúde Perfeita',
    target: 60, // 60 ticks at 1-min interval = 1 hour
    progressive: true,
    condition: ({ petState, tracker }) => {
      const allAbove80 = Object.values(petState.needs).every(n => n.value >= 80);
      const streak = tracker._streaks.zen || 0;
      return allAbove80 ? streak + 1 : 0;
    },
    streakKey: 'zen',
  },
  {
    id: 'equilibrio',
    name: 'Equilíbrio',
    description: 'Score geral acima de 90% por 6 horas',
    icon: '⚖️',
    category: 'Saúde Perfeita',
    target: 360, // 360 minutes
    progressive: true,
    condition: ({ petState, tracker }) => {
      const above90 = petState.getOverallScore() >= 90;
      const streak = tracker._streaks.equilibrio || 0;
      return above90 ? streak + 1 : 0;
    },
    streakKey: 'equilibrio',
  },
  {
    id: 'intocavel',
    name: 'Intocável',
    description: 'Zero erros por 24 horas',
    icon: '✨',
    category: 'Saúde Perfeita',
    target: 1440, // 1440 minutes
    progressive: true,
    condition: ({ sensors, tracker }) => {
      const noErrors = (sensors.errorRate === undefined || sensors.errorRate === 0);
      const streak = tracker._streaks.intocavel || 0;
      return noErrors ? streak + 1 : 0;
    },
    streakKey: 'intocavel',
  },

  // ── Energia ────────────────────────────────────────────────
  {
    id: 'maratonista',
    name: 'Maratonista',
    description: 'Uptime de 7 dias sem restart',
    icon: '🏃',
    category: 'Energia',
    target: 168, // hours
    progressive: true,
    condition: ({ sensors }) => {
      return sensors.uptimeHours || 0;
    },
  },
  {
    id: 'sempre_carregado',
    name: 'Sempre Carregado',
    description: 'Bateria nunca abaixo de 50% por 3 dias (Android)',
    icon: '🔋',
    category: 'Energia',
    target: 4320, // 3 days in minutes
    progressive: true,
    condition: ({ sensors, tracker }) => {
      if (sensors.battery === undefined) return -1; // not applicable
      const above50 = sensors.battery >= 50;
      const streak = tracker._streaks.sempre_carregado || 0;
      return above50 ? streak + 1 : 0;
    },
    streakKey: 'sempre_carregado',
  },
  {
    id: 'sobrevivente',
    name: 'Sobrevivente',
    description: 'Recuperou de energia abaixo de 10%',
    icon: '🔥',
    category: 'Energia',
    target: 1,
    condition: ({ petState, tracker }) => {
      if (petState.needs.energia.value < 10) {
        tracker._flags.saw_low_energy = true;
      }
      if (tracker._flags.saw_low_energy && petState.needs.energia.value >= 50) {
        return true;
      }
      return false;
    },
  },

  // ── Social ─────────────────────────────────────────────────
  {
    id: 'primeiro_amigo',
    name: 'Primeiro Amigo',
    description: 'Encontrou outro pet na rede',
    icon: '🤝',
    category: 'Social',
    target: 1,
    condition: ({ tracker }) => {
      return (tracker._counters.peers_seen || 0) >= 1;
    },
  },
  {
    id: 'popular',
    name: 'Popular',
    description: 'Interagiu com 5 pets diferentes',
    icon: '🌟',
    category: 'Social',
    target: 5,
    progressive: true,
    condition: ({ tracker }) => {
      return tracker._counters.peers_seen || 0;
    },
  },
  {
    id: 'melhor_amigo',
    name: 'Melhor Amigo',
    description: 'Friendship level 10 com um pet',
    icon: '💛',
    category: 'Social',
    target: 10,
    progressive: true,
    condition: ({ tracker }) => {
      return tracker._counters.max_friendship || 0;
    },
  },
  {
    id: 'influencer',
    name: 'Influencer',
    description: 'Recebeu 10 presentes de outros pets',
    icon: '🎁',
    category: 'Social',
    target: 10,
    progressive: true,
    condition: ({ tracker }) => {
      return tracker._counters.gifts_received || 0;
    },
  },

  // ── Limpeza ────────────────────────────────────────────────
  {
    id: 'marie_kondo',
    name: 'Marie Kondo',
    description: 'Limpeza em 100% por 12 horas',
    icon: '🧼',
    category: 'Limpeza',
    target: 720, // 720 minutes
    progressive: true,
    condition: ({ petState, tracker }) => {
      const perfect = petState.needs.limpeza.value >= 100;
      const streak = tracker._streaks.marie_kondo || 0;
      return perfect ? streak + 1 : 0;
    },
    streakKey: 'marie_kondo',
  },
  {
    id: 'faxina_geral',
    name: 'Faxina Geral',
    description: 'Disco abaixo de 50% de uso',
    icon: '💿',
    category: 'Limpeza',
    target: 1,
    condition: ({ sensors }) => {
      return sensors.diskUsage !== undefined && sensors.diskUsage < 50;
    },
  },

  // ── Seguranca ──────────────────────────────────────────────
  {
    id: 'fortaleza',
    name: 'Fortaleza',
    description: 'Zero tentativas de invasão por 7 dias',
    icon: '🏰',
    category: 'Segurança',
    target: 10080, // 7 days in minutes
    progressive: true,
    condition: ({ sensors, tracker }) => {
      const safe = (sensors.failedLogins === undefined || sensors.failedLogins === 0);
      const streak = tracker._streaks.fortaleza || 0;
      return safe ? streak + 1 : 0;
    },
    streakKey: 'fortaleza',
  },
  {
    id: 'sentinela',
    name: 'Sentinela',
    description: 'Tunnel up por 30 dias seguidos',
    icon: '🗼',
    category: 'Segurança',
    target: 43200, // 30 days in minutes
    progressive: true,
    condition: ({ sensors, tracker }) => {
      if (sensors.tunnelUp === undefined) return -1;
      const up = sensors.tunnelUp === true;
      const streak = tracker._streaks.sentinela || 0;
      return up ? streak + 1 : 0;
    },
    streakKey: 'sentinela',
  },

  // ── Especiais ──────────────────────────────────────────────
  {
    id: 'noturno',
    name: 'Noturno',
    description: 'Ativo entre 2am e 5am',
    icon: '🦉',
    category: 'Especiais',
    target: 1,
    condition: ({ now }) => {
      const hour = now.getHours();
      return hour >= 2 && hour < 5;
    },
  },
  {
    id: 'viajante',
    name: 'Viajante',
    description: 'Mudou de localização GPS (Android)',
    icon: '✈️',
    category: 'Especiais',
    target: 1,
    condition: ({ sensors, tracker }) => {
      if (sensors.latitude === undefined || sensors.longitude === undefined) return false;
      const prevLat = tracker._flags.last_lat;
      const prevLon = tracker._flags.last_lon;
      tracker._flags.last_lat = sensors.latitude;
      tracker._flags.last_lon = sensors.longitude;
      if (prevLat === undefined) return false;
      // Moved more than ~0.01 degrees (~1km)
      const dist = Math.sqrt(
        Math.pow(sensors.latitude - prevLat, 2) +
        Math.pow(sensors.longitude - prevLon, 2)
      );
      return dist > 0.01;
    },
  },
  {
    id: 'gpu_gamer',
    name: 'GPU Gamer',
    description: 'GPU acima de 90% por 1 hora',
    icon: '🎮',
    category: 'Especiais',
    target: 60, // minutes
    progressive: true,
    condition: ({ sensors, tracker }) => {
      if (sensors.gpuUsage === undefined) return -1;
      const hot = sensors.gpuUsage >= 90;
      const streak = tracker._streaks.gpu_gamer || 0;
      return hot ? streak + 1 : 0;
    },
    streakKey: 'gpu_gamer',
  },
  {
    id: 'carinhoso',
    name: 'Carinhoso',
    description: 'Recebeu 100 interações de carinho',
    icon: '💕',
    category: 'Especiais',
    target: 100,
    progressive: true,
    condition: ({ tracker }) => {
      return tracker._counters.pet_interactions || 0;
    },
  },
  {
    id: 'evoluido',
    name: 'Evoluído',
    description: 'Chegou ao estágio Tulipa',
    icon: '🌷',
    category: 'Especiais',
    target: 1,
    condition: ({ petState }) => {
      return petState.getEvolutionStage().name === 'Tulipa' ||
             petState.getEvolutionStage().name === 'Jardim' ||
             petState.getEvolutionStage().name === 'Floresta';
    },
  },
];

export class AchievementTracker {
  constructor() {
    /** Map of achievement id -> { unlockedAt, progress } */
    this._state = {};
    /** Streak counters for continuous-condition achievements (reset to 0 on break) */
    this._streaks = {};
    /** Persistent counters (peers_seen, pet_interactions, gifts_received, etc.) */
    this._counters = {};
    /** Misc flags for stateful conditions */
    this._flags = {};

    // Initialize state for every defined achievement
    for (const def of ACHIEVEMENT_DEFS) {
      this._state[def.id] = {
        unlockedAt: null,
        progress: 0,
      };
    }
  }

  /**
   * Run all achievement checks.
   * @param {PetState} petState
   * @param {Object} sensors - latest sensor readings
   * @param {Array} history - recent history entries
   * @returns {Array} newly unlocked achievements (with full definition + unlockedAt)
   */
  check(petState, sensors, history) {
    const now = new Date();
    const newlyUnlocked = [];

    for (const def of ACHIEVEMENT_DEFS) {
      const state = this._state[def.id];

      // Skip already unlocked
      if (state.unlockedAt) continue;

      const ctx = { petState, sensors, history, tracker: this, now };
      let result;
      try {
        result = def.condition(ctx);
      } catch {
        continue;
      }

      // -1 means "not applicable to this environment"
      if (result === -1) continue;

      if (def.progressive) {
        // For streak-based achievements, update the streak
        if (def.streakKey) {
          this._streaks[def.streakKey] = typeof result === 'number' ? result : 0;
          state.progress = this._streaks[def.streakKey];
        } else {
          // Direct value (e.g., days alive, peers seen)
          state.progress = typeof result === 'number' ? result : 0;
        }

        if (state.progress >= def.target) {
          state.progress = def.target;
          state.unlockedAt = now.toISOString();
          newlyUnlocked.push(this._formatAchievement(def, state));
        }
      } else {
        // Boolean achievement
        if (result === true) {
          state.progress = def.target;
          state.unlockedAt = now.toISOString();
          newlyUnlocked.push(this._formatAchievement(def, state));
        }
      }
    }

    return newlyUnlocked;
  }

  /**
   * Increment a named counter. Call externally for events like interactions, gifts, etc.
   */
  incrementCounter(name, amount = 1) {
    this._counters[name] = (this._counters[name] || 0) + amount;
  }

  /**
   * Register a peer pet seen on the network.
   */
  registerPeer(peerId) {
    if (!this._flags.peers_set) this._flags.peers_set = new Set();
    // Sets don't serialize to JSON, so also keep the count
    if (typeof this._flags.peers_set === 'object' && this._flags.peers_set.add) {
      this._flags.peers_set.add(peerId);
      this._counters.peers_seen = this._flags.peers_set.size;
    }
  }

  /**
   * Update max friendship level seen with any peer.
   */
  updateFriendship(level) {
    this._counters.max_friendship = Math.max(
      this._counters.max_friendship || 0,
      level
    );
  }

  /**
   * Return all achievements with their status.
   */
  getAll() {
    return ACHIEVEMENT_DEFS.map(def => {
      const state = this._state[def.id];
      return this._formatAchievement(def, state);
    });
  }

  /**
   * Return only unlocked achievements.
   */
  getUnlocked() {
    return this.getAll().filter(a => a.status === 'unlocked');
  }

  _formatAchievement(def, state) {
    const unlocked = !!state.unlockedAt;
    return {
      id: def.id,
      name: def.name,
      description: def.description,
      icon: def.icon,
      category: def.category,
      status: unlocked ? 'unlocked' : 'locked',
      progress: state.progress,
      target: def.target,
      progressLabel: def.progressive
        ? `${Math.min(state.progress, def.target)}/${def.target}`
        : null,
      unlockedAt: state.unlockedAt,
    };
  }

  // ── Persistence ────────────────────────────────────────────

  toJSON() {
    // Convert Set to array for serialization
    const flagsCopy = { ...this._flags };
    if (flagsCopy.peers_set instanceof Set) {
      flagsCopy.peers_set = [...flagsCopy.peers_set];
    }
    return {
      state: this._state,
      streaks: this._streaks,
      counters: this._counters,
      flags: flagsCopy,
    };
  }

  fromJSON(data) {
    if (!data) return;

    // Restore state, merging with current definitions
    if (data.state) {
      for (const [id, saved] of Object.entries(data.state)) {
        if (this._state[id]) {
          this._state[id] = saved;
        }
      }
    }

    this._streaks = data.streaks || {};
    this._counters = data.counters || {};
    this._flags = data.flags || {};

    // Restore Set for peers
    if (Array.isArray(this._flags.peers_set)) {
      this._flags.peers_set = new Set(this._flags.peers_set);
      this._counters.peers_seen = this._flags.peers_set.size;
    }
  }

  save() {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(ACHIEVEMENTS_FILE, JSON.stringify(this.toJSON(), null, 2));
    } catch (e) {
      console.error('Failed to save achievements:', e.message);
    }
  }

  load() {
    try {
      if (existsSync(ACHIEVEMENTS_FILE)) {
        const data = JSON.parse(readFileSync(ACHIEVEMENTS_FILE, 'utf-8'));
        this.fromJSON(data);
      }
    } catch (e) {
      console.error('Failed to load achievements:', e.message);
    }
  }
}

export { ACHIEVEMENT_DEFS };
