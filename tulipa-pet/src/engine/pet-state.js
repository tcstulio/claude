/**
 * Pet State Engine
 * Manages the virtual pet's needs, mood, and evolution based on real sensor data.
 * Each Tulipa agent has its own pet instance.
 */

const NEEDS = {
  energia:   { label: 'Energia',    icon: '⚡', decay: 0.5,  weight: 1.0 },
  limpeza:   { label: 'Limpeza',    icon: '🧹', decay: 0.2,  weight: 0.8 },
  saude:     { label: 'Saúde',      icon: '❤️', decay: 0.3,  weight: 1.0 },
  seguranca: { label: 'Segurança',  icon: '🛡️', decay: 0.1,  weight: 0.9 },
  humor:     { label: 'Humor',      icon: '🎭', decay: 0.4,  weight: 0.7 },
  social:    { label: 'Social',     icon: '💬', decay: 0.6,  weight: 0.6 },
};

const MOODS = [
  { name: 'radiante',    minScore: 90, face: '(✿◠‿◠)',  color: '#4caf50' },
  { name: 'feliz',       minScore: 75, face: '(◕‿◕)',    color: '#8bc34a' },
  { name: 'contente',    minScore: 60, face: '(•‿•)',    color: '#cddc39' },
  { name: 'neutro',      minScore: 45, face: '(•_•)',    color: '#ffeb3b' },
  { name: 'desanimado',  minScore: 30, face: '(•︵•)',   color: '#ff9800' },
  { name: 'triste',      minScore: 15, face: '(╥﹏╥)',   color: '#f44336' },
  { name: 'crítico',     minScore: 0,  face: '(×_×)',    color: '#9c27b0' },
];

const EVOLUTION_STAGES = [
  { name: 'Semente',     minXP: 0,    maxLevel: 5,   sprite: '🌱' },
  { name: 'Broto',       minXP: 100,  maxLevel: 10,  sprite: '🌿' },
  { name: 'Botão',       minXP: 500,  maxLevel: 20,  sprite: '🌺' },
  { name: 'Tulipa',      minXP: 1500, maxLevel: 35,  sprite: '🌷' },
  { name: 'Jardim',      minXP: 5000, maxLevel: 50,  sprite: '🏵️' },
  { name: 'Floresta',    minXP: 15000, maxLevel: 100, sprite: '🌳' },
];

export class PetState {
  constructor(agentId, agentType = 'unknown') {
    this.agentId = agentId;
    this.agentType = agentType; // 'android', 'server', 'desktop'
    this.name = `Tulipa-${agentId.slice(-4)}`;
    this.birthDate = new Date().toISOString();
    this.xp = 0;
    this.level = 1;
    this.totalTicks = 0;

    // Initialize all needs at 70%
    this.needs = {};
    for (const [key, config] of Object.entries(NEEDS)) {
      this.needs[key] = { value: 70, ...config };
    }

    // Personality traits (influenced by agent type)
    this.personality = this._generatePersonality(agentType);

    // Event log
    this.events = [];
    this.lastUpdate = Date.now();
  }

  _generatePersonality(type) {
    const base = { curiosidade: 50, resistencia: 50, sociabilidade: 50, cautela: 50 };
    switch (type) {
      case 'android':
        return { ...base, curiosidade: 70, sociabilidade: 80, resistencia: 40 }; // mobile = social, curious, fragile
      case 'server':
        return { ...base, resistencia: 90, cautela: 70, sociabilidade: 30 }; // server = tough, cautious, solitary
      case 'desktop':
        return { ...base, curiosidade: 60, resistencia: 60, sociabilidade: 60 };
      default:
        return base;
    }
  }

  /**
   * Update pet state from sensor readings.
   * @param {Object} sensors - normalized sensor values (0-100)
   */
  updateFromSensors(sensors) {
    const now = Date.now();
    const elapsed = (now - this.lastUpdate) / 1000 / 60; // minutes
    this.lastUpdate = now;
    this.totalTicks++;

    // Apply natural decay
    for (const [key, need] of Object.entries(this.needs)) {
      need.value = Math.max(0, need.value - need.decay * elapsed);
    }

    // Map sensors to needs
    if (sensors.battery !== undefined) {
      this.needs.energia.value = sensors.battery;
    }
    if (sensors.cpuUsage !== undefined) {
      // High CPU = low energy
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
      // Ideal temp 30-45C for phone, mapped to 0-100 health impact
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
      // More tokens = slightly less secure
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
      // Minutes since last interaction
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
      // Circadian rhythm
      const hour = sensors.hourOfDay;
      if (hour >= 23 || hour < 6) {
        this.needs.energia.value = Math.min(this.needs.energia.value, 40);
        this.needs.humor.value = Math.min(this.needs.humor.value, 50);
      }
    }
    if (sensors.wifiSignal !== undefined) {
      // 0-100 signal strength
      this.needs.humor.value = Math.max(
        this.needs.humor.value * 0.7,
        this.needs.humor.value * 0.3 + sensors.wifiSignal * 0.5
      );
    }
    if (sensors.uptimeHours !== undefined) {
      // Very long uptime = needs rest
      if (sensors.uptimeHours > 72) {
        this.needs.energia.value = Math.min(this.needs.energia.value, 50);
      }
      if (sensors.uptimeHours > 168) { // 7 days
        this.needs.saude.value = Math.min(this.needs.saude.value, 60);
      }
    }

    // Clamp all values
    for (const need of Object.values(this.needs)) {
      need.value = Math.max(0, Math.min(100, Math.round(need.value)));
    }

    // Update level
    this._updateLevel();

    return this.getSnapshot();
  }

  _updateLevel() {
    const stage = this.getEvolutionStage();
    this.level = Math.min(
      stage.maxLevel,
      Math.floor(this.xp / 50) + 1
    );
  }

  getOverallScore() {
    let totalWeight = 0;
    let weightedSum = 0;
    for (const need of Object.values(this.needs)) {
      weightedSum += need.value * need.weight;
      totalWeight += need.weight;
    }
    return Math.round(weightedSum / totalWeight);
  }

  getMood() {
    const score = this.getOverallScore();
    return MOODS.find(m => score >= m.minScore) || MOODS[MOODS.length - 1];
  }

  getEvolutionStage() {
    let stage = EVOLUTION_STAGES[0];
    for (const s of EVOLUTION_STAGES) {
      if (this.xp >= s.minXP) stage = s;
    }
    return stage;
  }

  getCriticalNeeds() {
    return Object.entries(this.needs)
      .filter(([_, n]) => n.value < 30)
      .map(([key, n]) => ({ key, ...n }))
      .sort((a, b) => a.value - b.value);
  }

  getAge() {
    const ms = Date.now() - new Date(this.birthDate).getTime();
    const days = Math.floor(ms / 86400000);
    const hours = Math.floor((ms % 86400000) / 3600000);
    return { days, hours, total: `${days}d ${hours}h` };
  }

  addEvent(type, message) {
    this.events.unshift({
      time: new Date().toISOString(),
      type,
      message,
    });
    if (this.events.length > 50) this.events.pop();
  }

  getSnapshot() {
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
  toJSON() {
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

  static fromJSON(data) {
    const pet = new PetState(data.agentId, data.agentType);
    pet.name = data.name;
    pet.birthDate = data.birthDate;
    pet.xp = data.xp;
    pet.level = data.level;
    pet.totalTicks = data.totalTicks;
    pet.events = data.events || [];
    pet.lastUpdate = data.lastUpdate;
    for (const [key, value] of Object.entries(data.needs)) {
      if (pet.needs[key]) pet.needs[key].value = value;
    }
    if (data.personality) pet.personality = data.personality;
    return pet;
  }
}

export { NEEDS, MOODS, EVOLUTION_STAGES };
