/**
 * Pet Manager
 * Orchestrates sensor collection, pet state updates, and persistence.
 * Emits events for real-time dashboard updates.
 */

import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { PetState } from './pet-state.js';
import { AchievementTracker } from './achievements.js';
import { detectEnvironment, collectAllSensors } from '../sensors/collector-factory.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const PET_FILE = join(DATA_DIR, 'pet.json');
const HISTORY_FILE = join(DATA_DIR, 'history.json');

const COLLECT_INTERVAL = 60_000;  // 1 minute
const SAVE_INTERVAL = 300_000;    // 5 minutes
const HISTORY_MAX = 1440;         // 24 hours of minute-by-minute data

export class PetManager extends EventEmitter {
  constructor() {
    super();
    this.envType = detectEnvironment();
    this.pet = this._loadOrCreate();
    this.lastSensors = {};
    this.history = this._loadHistory();
    this.networkPets = new Map(); // pets from other agents
    this._timers = [];

    // Achievement system
    this.achievements = new AchievementTracker();
    this.achievements.load();

    console.log(`🌱 Pet "${this.pet.name}" loaded (${this.envType} agent)`);
    console.log(`   Level ${this.pet.level} | XP ${this.pet.xp} | Age ${this.pet.getAge().total}`);
    console.log(`   🏆 ${this.achievements.getUnlocked().length} achievements unlocked`);
  }

  _loadOrCreate() {
    try {
      if (existsSync(PET_FILE)) {
        const data = JSON.parse(readFileSync(PET_FILE, 'utf-8'));
        return PetState.fromJSON(data);
      }
    } catch (e) {
      console.error('Failed to load pet, creating new:', e.message);
    }

    // Create new pet
    const agentId = process.env.TULIPA_AGENT_ID || `agent-${Date.now().toString(36)}`;
    return new PetState(agentId, this.envType);
  }

  _loadHistory() {
    try {
      if (existsSync(HISTORY_FILE)) {
        return JSON.parse(readFileSync(HISTORY_FILE, 'utf-8'));
      }
    } catch {
      // ignore
    }
    return [];
  }

  _save() {
    try {
      if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
      writeFileSync(PET_FILE, JSON.stringify(this.pet.toJSON(), null, 2));
      writeFileSync(HISTORY_FILE, JSON.stringify(this.history.slice(-HISTORY_MAX)));
      this.achievements.save();
    } catch (e) {
      console.error('Failed to save pet:', e.message);
    }
  }

  async tick() {
    try {
      const sensors = await collectAllSensors(this.envType);
      this.lastSensors = sensors;

      const snapshot = this.pet.updateFromSensors(sensors);

      // Record history
      this.history.push({
        time: Date.now(),
        score: snapshot.overallScore,
        mood: snapshot.mood.name,
        needs: Object.fromEntries(
          Object.entries(snapshot.needs).map(([k, v]) => [k, v.value])
        ),
      });
      if (this.history.length > HISTORY_MAX) {
        this.history = this.history.slice(-HISTORY_MAX);
      }

      // Check for critical events
      const critical = this.pet.getCriticalNeeds();
      if (critical.length > 0) {
        for (const need of critical) {
          if (need.value < 15) {
            this.pet.addEvent('critical', `${need.label} está em nível crítico: ${need.value}%`);
          }
        }
      }

      // Check achievements
      const newAchievements = this.achievements.check(this.pet, sensors, this.history);
      for (const achievement of newAchievements) {
        this.pet.addEvent('achievement', `🏆 Conquista desbloqueada: ${achievement.icon} ${achievement.name}`);
        this.emit('achievement', achievement);
        console.log(`🏆 Achievement unlocked: ${achievement.icon} ${achievement.name}`);
      }

      this.emit('update', snapshot);
      return snapshot;
    } catch (e) {
      console.error('Tick error:', e.message);
      return this.pet.getSnapshot();
    }
  }

  interact(action) {
    let message = '';
    let xpGain = 0;

    switch (action) {
      case 'pet': // Carinho
        this.pet.needs.humor.value = Math.min(100, this.pet.needs.humor.value + 15);
        this.pet.needs.social.value = Math.min(100, this.pet.needs.social.value + 10);
        xpGain = 2;
        message = `${this.pet.name} recebeu carinho! 💕`;
        break;

      case 'feed': // Alimentar (restart services, free memory)
        this.pet.needs.energia.value = Math.min(100, this.pet.needs.energia.value + 20);
        xpGain = 3;
        message = `${this.pet.name} foi alimentado! ⚡`;
        break;

      case 'clean': // Limpar (clear logs, temp)
        this.pet.needs.limpeza.value = Math.min(100, this.pet.needs.limpeza.value + 25);
        xpGain = 5;
        message = `${this.pet.name} tomou banho! 🧹`;
        break;

      case 'heal': // Curar (fix errors, restart crashed services)
        this.pet.needs.saude.value = Math.min(100, this.pet.needs.saude.value + 15);
        xpGain = 5;
        message = `${this.pet.name} foi ao médico! ❤️`;
        break;

      case 'guard': // Proteger (check security, rotate tokens)
        this.pet.needs.seguranca.value = Math.min(100, this.pet.needs.seguranca.value + 20);
        xpGain = 4;
        message = `${this.pet.name} está mais seguro! 🛡️`;
        break;

      case 'play': // Brincar
        this.pet.needs.humor.value = Math.min(100, this.pet.needs.humor.value + 20);
        this.pet.needs.social.value = Math.min(100, this.pet.needs.social.value + 15);
        this.pet.needs.energia.value = Math.max(0, this.pet.needs.energia.value - 5);
        xpGain = 3;
        message = `${this.pet.name} brincou! 🎭`;
        break;

      default:
        return { ok: false, message: 'Ação desconhecida' };
    }

    this.pet.xp += xpGain;
    this.pet.addEvent('interaction', message);

    // Track interaction counts for achievements
    if (action === 'pet') {
      this.achievements.incrementCounter('pet_interactions');
    }

    const snapshot = this.pet.getSnapshot();
    this.emit('update', snapshot);
    this._save();

    return { ok: true, message, xpGain, snapshot };
  }

  start() {
    // Initial tick
    this.tick();

    // Periodic sensor collection
    this._timers.push(setInterval(() => this.tick(), COLLECT_INTERVAL));

    // Periodic save
    this._timers.push(setInterval(() => this._save(), SAVE_INTERVAL));

    console.log(`⏰ Collecting sensors every ${COLLECT_INTERVAL / 1000}s`);
  }

  stop() {
    this._timers.forEach(t => clearInterval(t));
    this._save();
    console.log('🌷 Pet saved and stopped');
  }

  getSnapshot() { return this.pet.getSnapshot(); }
  getLastSensors() { return this.lastSensors; }
  getHistory() { return this.history.slice(-100); }
  getAllPets() {
    return [
      this.pet.getSnapshot(),
      ...Array.from(this.networkPets.values()),
    ];
  }

  // Register a peer's pet state
  registerPeerPet(snapshot) {
    this.networkPets.set(snapshot.agentId, snapshot);
    this.achievements.registerPeer(snapshot.agentId);
  }

  getAchievements() {
    return this.achievements.getAll();
  }
}
