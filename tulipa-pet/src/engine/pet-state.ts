/**
 * Pet State Engine
 * Manages the virtual pet's needs, mood, and evolution based on real sensor data.
 * Each Tulipa agent has its own pet instance.
 */

// ── Interfaces ────────────────────────────────────────────────

export type NeedKey = 'energia' | 'limpeza' | 'saude' | 'seguranca' | 'humor' | 'social';
export type AgentType = 'android' | 'server' | 'desktop' | 'unknown';

export interface NeedConfig {
  label: string;
  icon: string;
  decay: number;
  weight: number;
}

export interface NeedState extends NeedConfig {
  value: number;
}

export interface Mood {
  name: string;
  minScore: number;
  face: string;
  color: string;
}

export interface EvolutionStage {
  name: string;
  minXP: number;
  maxLevel: number;
  sprite: string;
}

export interface PetPersonality {
  curiosidade: number;
  resistencia: number;
  sociabilidade: number;
  cautela: number;
}

export interface PetEvent {
  time: string;
  type: string;
  message: string;
  _notified?: boolean;
}

export interface PetAge {
  days: number;
  hours: number;
  total: string;
}

export interface NeedSnapshot {
  value: number;
  label: string;
  icon: string;
}

export interface CriticalNeed extends NeedConfig {
  key: string;
  value: number;
}

export interface PetSnapshot {
  agentId: string;
  agentType: AgentType;
  name: string;
  level: number;
  xp: number;
  age: PetAge;
  mood: Mood;
  stage: EvolutionStage;
  overallScore: number;
  needs: Record<string, NeedSnapshot>;
  criticalNeeds: CriticalNeed[];
  personality: PetPersonality;
  events: PetEvent[];
  lastUpdate: number;
}

export interface PetJSON {
  agentId: string;
  agentType: AgentType;
  name: string;
  birthDate: string;
  xp: number;
  level: number;
  totalTicks: number;
  needs: Record<string, number>;
  personality: PetPersonality;
  events: PetEvent[];
  lastUpdate: number;
}

export interface SensorReadings {
  battery?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  temperature?: number;
  errorRate?: number;
  failedLogins?: number;
  activeTokens?: number;
  tunnelUp?: boolean;
  lastInteraction?: number;
  peersOnline?: number;
  tasksCompleted?: number;
  hourOfDay?: number;
  wifiSignal?: number;
  uptimeHours?: number;
  latitude?: number;
  longitude?: number;
  gpuUsage?: number;

  // Economy counters (from Tulipa API metrics)
  mcpCalls?: number;
  mcpErrors?: number;
  messagesRouted?: number;
  messagesFailed?: number;
  httpRequests?: number;
  tasksFailed?: number;

  // Peaks / watermarks
  peakCpuPercent?: number;
  peakMemoryRss?: number;

  // Process-level
  processRss?: number;
  processHeapUsed?: number;

  // Terminal (tmux)
  terminalPanes?: number;
  terminalActivePanes?: number;
  terminalCommands?: string[];
  terminalMoodBoost?: number;
  terminalEnergyDrain?: number;
}

// ── Constants ─────────────────────────────────────────────────

const NEEDS: Record<NeedKey, NeedConfig> = {
  energia:   { label: 'Energia',    icon: '⚡', decay: 0.5,  weight: 1.0 },
  limpeza:   { label: 'Limpeza',    icon: '🧹', decay: 0.2,  weight: 0.8 },
  saude:     { label: 'Saúde',      icon: '❤️', decay: 0.3,  weight: 1.0 },
  seguranca: { label: 'Segurança',  icon: '🛡️', decay: 0.1,  weight: 0.9 },
  humor:     { label: 'Humor',      icon: '🎭', decay: 0.4,  weight: 0.7 },
  social:    { label: 'Social',     icon: '💬', decay: 0.6,  weight: 0.6 },
};

const MOODS: Mood[] = [
  { name: 'radiante',    minScore: 90, face: '(✿◠‿◠)',  color: '#4caf50' },
  { name: 'feliz',       minScore: 75, face: '(◕‿◕)',    color: '#8bc34a' },
  { name: 'contente',    minScore: 60, face: '(•‿•)',    color: '#cddc39' },
  { name: 'neutro',      minScore: 45, face: '(•_•)',    color: '#ffeb3b' },
  { name: 'desanimado',  minScore: 30, face: '(•︵•)',   color: '#ff9800' },
  { name: 'triste',      minScore: 15, face: '(╥﹏╥)',   color: '#f44336' },
  { name: 'crítico',     minScore: 0,  face: '(×_×)',    color: '#9c27b0' },
];

const EVOLUTION_STAGES: EvolutionStage[] = [
  { name: 'Semente',     minXP: 0,    maxLevel: 5,   sprite: '🌱' },
  { name: 'Broto',       minXP: 100,  maxLevel: 10,  sprite: '🌿' },
  { name: 'Botão',       minXP: 500,  maxLevel: 20,  sprite: '🌺' },
  { name: 'Tulipa',      minXP: 1500, maxLevel: 35,  sprite: '🌷' },
  { name: 'Jardim',      minXP: 5000, maxLevel: 50,  sprite: '🏵️' },
  { name: 'Floresta',    minXP: 15000, maxLevel: 100, sprite: '🌳' },
];

export class PetState {
  agentId: string;
  agentType: AgentType;
  name: string;
  birthDate: string;
  xp: number;
  level: number;
  totalTicks: number;
  needs: Record<NeedKey, NeedState>;
  personality: PetPersonality;
  events: PetEvent[];
  lastUpdate: number;

  constructor(agentId: string, agentType: AgentType = 'unknown') {
    this.agentId = agentId;
    this.agentType = agentType;
    this.name = `Tulipa-${agentId.slice(-4)}`;
    this.birthDate = new Date().toISOString();
    this.xp = 0;
    this.level = 1;
    this.totalTicks = 0;

    // Initialize all needs at 70%
    this.needs = {} as Record<NeedKey, NeedState>;
    for (const [key, config] of Object.entries(NEEDS) as [NeedKey, NeedConfig][]) {
      this.needs[key] = { value: 70, ...config };
    }

    // Personality traits (influenced by agent type)
    this.personality = this._generatePersonality(agentType);

    // Event log
    this.events = [];
    this.lastUpdate = Date.now();
  }

  private _generatePersonality(type: AgentType): PetPersonality {
    const base: PetPersonality = { curiosidade: 50, resistencia: 50, sociabilidade: 50, cautela: 50 };
    switch (type) {
      case 'android':
        return { ...base, curiosidade: 70, sociabilidade: 80, resistencia: 40 };
      case 'server':
        return { ...base, resistencia: 90, cautela: 70, sociabilidade: 30 };
      case 'desktop':
        return { ...base, curiosidade: 60, resistencia: 60, sociabilidade: 60 };
      default:
        return base;
    }
  }

  /**
   * Update pet state from sensor readings.
   */
  updateFromSensors(sensors: SensorReadings): PetSnapshot {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000 / 60; // minutes
    this.lastUpdate = now;
    this.totalTicks++;

    // Apply natural decay
    for (const need of Object.values(this.needs)) {
      need.value = Math.max(0, need.value - need.decay * elapsed);
    }

    // Map sensors to needs
    if (sensors.battery !== undefined) {
      this.needs.energia.value = sensors.battery;
    }
    if (sensors.cpuUsage !== undefined) {
      this.needs.energia.value = Math.min(
        this.needs.energia.value,
        100 - sensors.cpuUsage * 0.6
      );
    }
    if (sensors.memoryUsage !== undefined) {
      this.needs.saude.value = Math.max(20, 100 - sensors.memoryUsage * 0.8);
    }
    if (sensors.diskUsage !== undefined) {
      this.needs.limpeza.value = Math.max(10, 100 - sensors.diskUsage);
    }
    if (sensors.temperature !== undefined) {
      const tempPenalty = sensors.temperature > 40
        ? (sensors.temperature - 40) * 5
        : 0;
      this.needs.saude.value = Math.max(0, this.needs.saude.value - tempPenalty);
    }
    if (sensors.errorRate !== undefined) {
      this.needs.saude.value = Math.max(0, this.needs.saude.value - sensors.errorRate * 2);
    }
    if (sensors.failedLogins !== undefined) {
      this.needs.seguranca.value = Math.max(
        0,
        100 - sensors.failedLogins * 10
      );
    }
    if (sensors.activeTokens !== undefined) {
      this.needs.seguranca.value = Math.min(
        this.needs.seguranca.value,
        Math.max(40, 100 - sensors.activeTokens * 5)
      );
    }
    if (sensors.tunnelUp !== undefined) {
      this.needs.seguranca.value = sensors.tunnelUp
        ? Math.max(this.needs.seguranca.value, 60)
        : Math.min(this.needs.seguranca.value, 30);
    }
    if (sensors.lastInteraction !== undefined) {
      const loneliness = Math.min(100, sensors.lastInteraction / 2);
      this.needs.social.value = Math.max(0, 100 - loneliness);
      this.needs.humor.value = Math.max(
        20,
        this.needs.humor.value - loneliness * 0.3
      );
    }
    if (sensors.peersOnline !== undefined) {
      this.needs.social.value = Math.min(
        100,
        this.needs.social.value + sensors.peersOnline * 15
      );
    }
    if (sensors.tasksCompleted !== undefined) {
      this.xp += sensors.tasksCompleted * 10;
    }
    if (sensors.hourOfDay !== undefined) {
      const hour = sensors.hourOfDay;
      if (hour >= 23 || hour < 6) {
        this.needs.energia.value = Math.min(this.needs.energia.value, 40);
        this.needs.humor.value = Math.min(this.needs.humor.value, 50);
      }
    }
    if (sensors.wifiSignal !== undefined) {
      this.needs.humor.value = Math.max(
        this.needs.humor.value * 0.7,
        this.needs.humor.value * 0.3 + sensors.wifiSignal * 0.5
      );
    }
    if (sensors.uptimeHours !== undefined) {
      if (sensors.uptimeHours > 72) {
        this.needs.energia.value = Math.min(this.needs.energia.value, 50);
      }
      if (sensors.uptimeHours > 168) {
        this.needs.saude.value = Math.min(this.needs.saude.value, 60);
      }
    }

    // ── Economy counters → pet needs ────────────────────────────

    // MCP errors degrade health (something is wrong with the system)
    if (sensors.mcpErrors !== undefined && sensors.mcpCalls !== undefined && sensors.mcpCalls > 0) {
      const errorRate = sensors.mcpErrors / sensors.mcpCalls;
      if (errorRate > 0.1) {
        // More than 10% error rate = health penalty
        this.needs.saude.value = Math.max(0, this.needs.saude.value - errorRate * 30);
      }
    }

    // Messages routed boost social (pet is communicating)
    if (sensors.messagesRouted !== undefined && sensors.messagesRouted > 0) {
      const socialBoost = Math.min(20, sensors.messagesRouted * 0.5);
      this.needs.social.value = Math.min(100, this.needs.social.value + socialBoost);
    }

    // High HTTP requests = busy pet (slight energy drain if extreme)
    if (sensors.httpRequests !== undefined && sensors.httpRequests > 5000) {
      this.needs.energia.value = Math.max(20, this.needs.energia.value - 5);
    }

    // Peak CPU > 80% = stress penalty on health
    if (sensors.peakCpuPercent !== undefined && sensors.peakCpuPercent > 80) {
      const stressPenalty = (sensors.peakCpuPercent - 80) * 0.5;
      this.needs.saude.value = Math.max(0, this.needs.saude.value - stressPenalty);
    }

    // High process memory = needs cleanup (limpeza)
    if (sensors.processHeapUsed !== undefined) {
      const heapMB = sensors.processHeapUsed / (1024 * 1024);
      if (heapMB > 200) {
        const penalty = Math.min(20, (heapMB - 200) * 0.1);
        this.needs.limpeza.value = Math.max(0, this.needs.limpeza.value - penalty);
      }
    }

    // ── Terminal → pet mood/energy ──────────────────────────────

    // Terminal mood boost (positive commands = happy, no panes = lonely)
    if (sensors.terminalMoodBoost !== undefined) {
      this.needs.humor.value = Math.max(0, Math.min(100,
        this.needs.humor.value + sensors.terminalMoodBoost
      ));
    }

    // Terminal energy drain (many panes / heavy commands)
    if (sensors.terminalEnergyDrain !== undefined && sensors.terminalEnergyDrain > 0) {
      this.needs.energia.value = Math.max(0,
        this.needs.energia.value - sensors.terminalEnergyDrain * 0.5
      );
    }

    // Active panes = someone is around (social boost)
    if (sensors.terminalActivePanes !== undefined && sensors.terminalActivePanes > 0) {
      this.needs.social.value = Math.min(100, this.needs.social.value + 5);
    }

    // Clamp all values
    for (const need of Object.values(this.needs)) {
      need.value = Math.max(0, Math.min(100, Math.round(need.value)));
    }

    // Update level
    this._updateLevel();

    return this.getSnapshot();
  }

  private _updateLevel(): void {
    const stage = this.getEvolutionStage();
    this.level = Math.min(
      stage.maxLevel,
      Math.floor(this.xp / 50) + 1
    );
  }

  getOverallScore(): number {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const need of Object.values(this.needs)) {
      weightedSum += need.value * need.weight;
      totalWeight += need.weight;
    }
    return Math.round(weightedSum / totalWeight);
  }

  getMood(): Mood {
    const score = this.getOverallScore();
    return MOODS.find(m => score >= m.minScore) || MOODS[MOODS.length - 1];
  }

  getEvolutionStage(): EvolutionStage {
    let stage = EVOLUTION_STAGES[0];
    for (const s of EVOLUTION_STAGES) {
      if (this.xp >= s.minXP) stage = s;
    }
    return stage;
  }

  getCriticalNeeds(): CriticalNeed[] {
    return (Object.entries(this.needs) as [string, NeedState][])
      .filter(([_, n]) => n.value < 30)
      .map(([key, n]) => ({ key, ...n }))
      .sort((a, b) => a.value - b.value);
  }

  getAge(): PetAge {
    const ms = Date.now() - new Date(this.birthDate).getTime();
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return { days, hours, total: `${days}d ${hours}h` };
  }

  addEvent(type: string, message: string): void {
    this.events.unshift({
      time: new Date().toISOString(),
      type,
      message,
    });
    if (this.events.length > 50) this.events.pop();
  }

  getSnapshot(): PetSnapshot {
    const mood = this.getMood();
    const stage = this.getEvolutionStage();
    return {
      agentId: this.agentId,
      agentType: this.agentType,
      name: this.name,
      level: this.level,
      xp: this.xp,
      age: this.getAge(),
      mood,
      stage,
      overallScore: this.getOverallScore(),
      needs: Object.fromEntries(
        Object.entries(this.needs).map(([k, v]) => [k, {
          value: v.value,
          label: v.label,
          icon: v.icon,
        }])
      ),
      criticalNeeds: this.getCriticalNeeds(),
      personality: this.personality,
      events: this.events.slice(0, 10),
      lastUpdate: this.lastUpdate,
    };
  }

  // Serialize for persistence
  toJSON(): PetJSON {
    return {
      agentId: this.agentId,
      agentType: this.agentType,
      name: this.name,
      birthDate: this.birthDate,
      xp: this.xp,
      level: this.level,
      totalTicks: this.totalTicks,
      needs: Object.fromEntries(
        Object.entries(this.needs).map(([k, v]) => [k, v.value])
      ),
      personality: this.personality,
      events: this.events,
      lastUpdate: this.lastUpdate,
    };
  }

  static fromJSON(data: PetJSON): PetState {
    const pet = new PetState(data.agentId, data.agentType);
    pet.name = data.name;
    pet.birthDate = data.birthDate;
    pet.xp = data.xp;
    pet.level = data.level;
    pet.totalTicks = data.totalTicks;
    pet.events = data.events || [];
    pet.lastUpdate = data.lastUpdate;
    for (const [key, value] of Object.entries(data.needs)) {
      if (pet.needs[key as NeedKey]) pet.needs[key as NeedKey].value = value;
    }
    if (data.personality) pet.personality = data.personality;
    return pet;
  }
}

export { NEEDS, MOODS, EVOLUTION_STAGES };
