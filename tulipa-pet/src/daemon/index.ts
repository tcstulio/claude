/**
 * Pet Daemon — O cérebro operacional do Tulipa Pet.
 *
 * Orquestra:
 * 1. ProcessMonitor → monitora serviços, alimenta sensores do pet
 * 2. FileWatcher → detecta mudanças no código, auto-rebuild + hot-update
 * 3. Self-healing → se detecta que caiu algo crítico, tenta reiniciar
 * 4. API → expõe estado dos processos via endpoints do pet
 *
 * O daemon roda junto com o pet (mesmo processo).
 * Ele é o elo entre o mundo real (processos, arquivos) e o mundo do pet (necessidades, humor).
 */

import { EventEmitter } from 'events';
import { execSync } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ProcessMonitor } from './process-monitor.js';
import type { PetSensorContribution, ProcessSnapshot } from './process-monitor.js';
import { FileWatcher } from './file-watcher.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..', '..');

export interface DaemonOptions {
  scanIntervalMs?: number;       // process scan interval (default 30s)
  watchFiles?: boolean;           // enable file watching (default true)
  selfHeal?: boolean;             // auto-restart crashed critical services (default true)
  selfHealCooldownMs?: number;    // min time between restart attempts (default 60s)
}

interface RestartRecord {
  service: string;
  at: number;
  success: boolean;
}

export class PetDaemon extends EventEmitter {
  readonly monitor: ProcessMonitor;
  readonly watcher: FileWatcher;
  private selfHeal: boolean;
  private selfHealCooldownMs: number;
  private restartHistory: RestartRecord[] = [];
  private lastSensorContribution: PetSensorContribution | null = null;

  constructor(options: DaemonOptions = {}) {
    super();

    this.selfHeal = options.selfHeal ?? true;
    this.selfHealCooldownMs = options.selfHealCooldownMs ?? 60_000;

    // Process Monitor
    this.monitor = new ProcessMonitor(options.scanIntervalMs ?? 30_000);

    // File Watcher
    this.watcher = new FileWatcher({
      srcDir: join(PROJECT_ROOT, 'src'),
      distDir: join(PROJECT_ROOT, 'dist'),
      debounceMs: 2000,
      autoBuild: options.watchFiles ?? true,
    });

    this.setupEvents();
  }

  private setupEvents(): void {
    // Process monitor events
    this.monitor.on('scan', (snapshot: ProcessSnapshot) => {
      this.lastSensorContribution = this.monitor.toPetSensors();
      this.emit('sensors-updated', this.lastSensorContribution);
    });

    this.monitor.on('status-change', (event: { service: string; from: string; to: string; critical: boolean }) => {
      const icon = event.to === 'running' ? '✅' : event.to === 'stopped' ? '🔴' : '⚠️';
      console.log(`${icon} ${event.service}: ${event.from} → ${event.to}`);
      this.emit('service-event', event);
    });

    this.monitor.on('critical-down', (event: { service: string }) => {
      console.log(`🚨 CRÍTICO: ${event.service} caiu!`);
      if (this.selfHeal) {
        this.attemptRestart(event.service);
      }
      this.emit('critical-alert', event);
    });

    // File watcher events
    this.watcher.on('hot-update', (event: { file: string }) => {
      console.log(`🔄 Hot update: ${event.file}`);
      this.emit('hot-update', event);
    });

    this.watcher.on('build-success', () => {
      this.emit('build-success');
    });

    this.watcher.on('build-error', (event: { error: string }) => {
      console.error(`❌ Build falhou`);
      this.emit('build-error', event);
    });

    this.watcher.on('restart-needed', (event: { reason: string; files: string[] }) => {
      console.log(`🔄 Restart necessário (${event.reason})`);
      this.emit('restart-needed', event);
    });
  }

  // ── Self-healing ─────────────────────────────────────────────

  private attemptRestart(serviceName: string): void {
    // Cooldown check
    const now = Date.now();
    const recentRestart = this.restartHistory.find(
      r => r.service === serviceName && (now - r.at) < this.selfHealCooldownMs
    );
    if (recentRestart) {
      console.log(`⏳ ${serviceName}: cooldown ativo, tentou reiniciar há ${Math.round((now - recentRestart.at) / 1000)}s`);
      return;
    }

    // Don't restart ourselves
    if (serviceName === 'tulipa-pet') return;

    // Restart commands per service
    const restartCommands: Record<string, string> = {
      'gateway': 'cd ~/tulipa/gateway && nohup node dist/index.js >> ~/.tulipa/logs/gateway.log 2>&1 &',
      'whatsapp-bridge': 'cd ~/tulipa && nohup node bin/tulipa.js whatsapp --self-chat >> ~/.tulipa/logs/whatsapp-bridge.log 2>&1 &',
      'cloudflared': 'nohup cloudflared tunnel run tulipa >> ~/.tulipa/logs/cloudflared.log 2>&1 &',
      'supervisor': 'cd ~/tulipa/supervisor && nohup node dist/index.js >> ~/.tulipa/logs/supervisor.log 2>&1 &',
      'tulipa-mesh': 'cd ~/tulipa-mesh && nohup node server.js >> ~/.tulipa/logs/tulipa-mesh.log 2>&1 &',
    };

    const cmd = restartCommands[serviceName];
    if (!cmd) {
      console.log(`🤷 ${serviceName}: não sei como reiniciar`);
      return;
    }

    console.log(`🔧 Tentando reiniciar ${serviceName}...`);
    let success = false;
    try {
      execSync(cmd, { timeout: 10_000, shell: '/bin/sh' });
      success = true;
      console.log(`✅ ${serviceName} reiniciado`);
    } catch (err) {
      console.error(`❌ Falha ao reiniciar ${serviceName}:`, (err as Error).message);
    }

    this.restartHistory.push({ service: serviceName, at: now, success });

    // Keep only last 50 records
    if (this.restartHistory.length > 50) {
      this.restartHistory = this.restartHistory.slice(-50);
    }

    this.emit('restart-attempt', { service: serviceName, success });
  }

  // ── Public API ───────────────────────────────────────────────

  start(): void {
    console.log('🤖 Pet Daemon starting...');
    this.monitor.start();
    this.watcher.start();
    console.log('🤖 Pet Daemon running');
  }

  stop(): void {
    this.monitor.stop();
    this.watcher.stop();
    console.log('🤖 Pet Daemon stopped');
  }

  /** Get the latest sensor contribution from process monitoring */
  getSensorContribution(): PetSensorContribution | null {
    return this.lastSensorContribution;
  }

  /** Get restart history */
  getRestartHistory(): RestartRecord[] {
    return [...this.restartHistory];
  }

  /** Get full process/service snapshot for the API */
  getProcessSnapshot(): Record<string, unknown> {
    const services: Record<string, unknown> = {};
    for (const [name, state] of this.monitor.getServiceStates()) {
      services[name] = {
        status: state.status,
        pid: state.pid,
        cpu: state.cpu,
        mem: state.mem,
        critical: state.definition.critical,
        category: state.definition.category,
        lastCheck: state.lastCheck,
        lastHealthy: state.lastHealthy,
        consecutiveFails: state.consecutiveFails,
      };
    }

    return {
      services,
      sensors: this.lastSensorContribution,
      restarts: this.restartHistory.slice(-10),
      uptime: process.uptime(),
      timestamp: Date.now(),
    };
  }
}

export { ProcessMonitor } from './process-monitor.js';
export type { PetSensorContribution, ProcessSnapshot, ServiceState } from './process-monitor.js';
export { FileWatcher } from './file-watcher.js';
