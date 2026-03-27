'use strict';

const { EventEmitter } = require('events');
const os = require('os');

/**
 * HubRole — state machine que gerencia o papel de hub de um nó.
 *
 * Estados:
 *   leaf → candidate → nominated → promoting → active → demoting → leaf
 *
 * Cada transição emite um evento e incrementa o epoch.
 */

const HUB_STATES = ['leaf', 'candidate', 'nominated', 'promoting', 'active', 'demoting'];

const VALID_TRANSITIONS = {
  leaf:       ['candidate'],
  candidate:  ['nominated', 'leaf'],       // pode desistir
  nominated:  ['promoting', 'leaf'],       // pode ser rejeitado
  promoting:  ['active', 'leaf'],          // pode falhar
  active:     ['demoting'],
  demoting:   ['leaf'],
};

class HubRole extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} [options.initialRole='auto'] — 'hub', 'leaf', ou 'auto'
   * @param {number} [options.metricsInterval=15000] — intervalo de coleta de métricas (ms)
   */
  constructor(options = {}) {
    super();
    this._state = 'leaf';
    this._epoch = 0;
    this._promotedAt = null;
    this._demotedAt = null;
    this._promotedBy = null;
    this._metrics = {};
    this._metricsInterval = options.metricsInterval || 15000;
    this._metricsTimer = null;
    this._startedAt = Date.now();
    this._requestCount = 0;

    // Auto-bootstrap: se HUB_ROLE=hub, auto-promove sem council
    if (options.initialRole === 'hub') {
      this._state = 'active';
      this._promotedAt = Date.now();
      this._promotedBy = 'bootstrap';
      this._epoch = 1;
    }
  }

  // ─── Getters ─────────────────────────────────────────────────────────

  get state() { return this._state; }
  get epoch() { return this._epoch; }
  get isHub() { return this._state === 'active'; }
  get isCandidate() { return this._state === 'candidate' || this._state === 'nominated'; }
  get isLeaf() { return this._state === 'leaf'; }
  get uptime() { return Date.now() - this._startedAt; }

  get capabilities() {
    const base = this.isHub ? ['hub', 'relay'] : ['relay'];
    const platform = this._platformCapabilities || [];
    return [...new Set([...base, ...platform])];
  }

  /** Define capabilities detectadas da plataforma local */
  setPlatformCapabilities(caps) {
    this._platformCapabilities = caps || [];
  }

  // ─── State Transitions ──────────────────────────────────────────────

  _transition(newState, meta = {}) {
    const valid = VALID_TRANSITIONS[this._state];
    if (!valid || !valid.includes(newState)) {
      throw new Error(`Transição inválida: ${this._state} → ${newState}`);
    }

    const oldState = this._state;
    this._state = newState;
    this._epoch++;

    this.emit('transition', {
      from: oldState,
      to: newState,
      epoch: this._epoch,
      ...meta,
    });

    return { from: oldState, to: newState, epoch: this._epoch };
  }

  /** Nó se oferece como candidato */
  selfNominate(reason) {
    return this._transition('candidate', { reason, by: 'self' });
  }

  /** Council nomeia este nó */
  nominate(proposerId, reason) {
    if (this._state === 'leaf') this._transition('candidate', { reason, by: proposerId });
    return this._transition('nominated', { reason, by: proposerId });
  }

  /** Council aprova promoção */
  promote(epoch, promotedBy) {
    if (this._state === 'nominated' || this._state === 'candidate') {
      // Pula para promoting se estava como candidate
      if (this._state === 'candidate') this._transition('nominated', { by: promotedBy });
    }
    this._transition('promoting', { by: promotedBy });
    this._promotedAt = Date.now();
    this._promotedBy = promotedBy;
    // Transição imediata para active (promoção é local)
    return this._transition('active', { epoch, by: promotedBy });
  }

  /** Council ou self inicia demoção */
  demote(reason, demotedBy) {
    this._transition('demoting', { reason, by: demotedBy });
    this._demotedAt = Date.now();
    this._promotedAt = null;
    return this._transition('leaf', { reason, by: demotedBy });
  }

  /** Cancela candidatura (rejeição ou timeout) */
  cancelNomination(reason) {
    if (this._state === 'candidate' || this._state === 'nominated' || this._state === 'promoting') {
      // Reset direto para leaf
      const oldState = this._state;
      this._state = 'leaf';
      this._epoch++;
      this.emit('transition', { from: oldState, to: 'leaf', reason, epoch: this._epoch });
    }
  }

  // ─── Métricas ───────────────────────────────────────────────────────

  /** Incrementa contador de requests (chamado pelo middleware) */
  trackRequest() {
    this._requestCount++;
  }

  /** Coleta métricas do sistema */
  collectMetrics() {
    const cpus = os.cpus();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    // CPU usage médio (simplificado — idle vs total)
    let cpuUsage = 0;
    if (cpus.length > 0) {
      const totals = cpus.reduce((acc, cpu) => {
        const times = cpu.times;
        acc.idle += times.idle;
        acc.total += times.user + times.nice + times.sys + times.idle + times.irq;
        return acc;
      }, { idle: 0, total: 0 });
      cpuUsage = Math.round((1 - totals.idle / totals.total) * 100);
    }

    this._metrics = {
      cpu: cpuUsage,
      memoryUsed: Math.round(((totalMem - freeMem) / totalMem) * 100),
      memoryTotal: Math.round(totalMem / 1024 / 1024),
      uptime: this.uptime,
      requestsPerMin: this._requestCount, // reset a cada coleta
      peerCount: 0, // preenchido pelo MeshManager
      loadAvg: os.loadavg()[0],
      platform: os.platform(),
      arch: os.arch(),
      state: this._state,
      epoch: this._epoch,
      isHub: this.isHub,
      promotedAt: this._promotedAt,
    };

    this._requestCount = 0;
    return this._metrics;
  }

  /** Inicia coleta periódica de métricas */
  startMetrics() {
    if (this._metricsTimer) return;
    this.collectMetrics(); // coleta inicial
    this._metricsTimer = setInterval(() => this.collectMetrics(), this._metricsInterval);
  }

  /** Para coleta de métricas */
  stopMetrics() {
    if (this._metricsTimer) {
      clearInterval(this._metricsTimer);
      this._metricsTimer = null;
    }
  }

  // ─── Serialização ───────────────────────────────────────────────────

  toJSON() {
    return {
      state: this._state,
      epoch: this._epoch,
      isHub: this.isHub,
      uptime: this.uptime,
      promotedAt: this._promotedAt,
      promotedBy: this._promotedBy,
      metrics: this._metrics,
      capabilities: this.capabilities,
    };
  }
}

module.exports = { HubRole, HUB_STATES, VALID_TRANSITIONS };
