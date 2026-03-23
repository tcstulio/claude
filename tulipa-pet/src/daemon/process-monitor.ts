/**
 * Process Monitor — Olhos do pet sobre o sistema.
 *
 * Monitora processos do dispositivo, detecta serviços conhecidos,
 * verifica saúde, e traduz tudo em dados que alimentam as necessidades do pet.
 *
 * Saúde do pet reflete saúde real dos serviços.
 */

import { execSync } from 'child_process';
import { EventEmitter } from 'events';

// ── Types ──────────────────────────────────────────────────────

export interface ServiceDefinition {
  name: string;
  processPattern: string;          // grep pattern to find the process
  healthCheck?: HealthCheck;
  category: 'core' | 'network' | 'app' | 'infra';
  critical: boolean;               // if true, affects pet health heavily
}

interface HealthCheck {
  type: 'http' | 'port' | 'process';
  url?: string;
  port?: number;
  timeoutMs?: number;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  mem: number;
  uptime: string;
  command: string;
}

export type ServiceStatus = 'running' | 'stopped' | 'unhealthy' | 'unknown';

export interface ServiceState {
  definition: ServiceDefinition;
  status: ServiceStatus;
  pid?: number;
  cpu?: number;
  mem?: number;
  uptime?: string;
  lastCheck: number;
  lastHealthy: number;
  consecutiveFails: number;
  restartCount: number;
}

export interface ProcessSnapshot {
  services: Record<string, ServiceState>;
  totalProcesses: number;
  zombieProcesses: number;
  nodeProcesses: number;
  systemLoad: number;
  memoryUsedPercent: number;
  timestamp: number;
}

// ── Known Services ─────────────────────────────────────────────

const KNOWN_SERVICES: ServiceDefinition[] = [
  {
    name: 'gateway',
    processPattern: 'gateway/dist/index',
    healthCheck: { type: 'http', url: 'http://localhost:18800/api/health', timeoutMs: 5000 },
    category: 'core',
    critical: true,
  },
  {
    name: 'whatsapp-bridge',
    processPattern: 'tulipa.js whatsapp',
    healthCheck: { type: 'port', port: 18790, timeoutMs: 3000 },
    category: 'core',
    critical: true,
  },
  {
    name: 'cloudflared',
    processPattern: 'cloudflared tunnel',
    category: 'infra',
    critical: true,
  },
  {
    name: 'tulipa-pet',
    processPattern: 'tulipa-pet/dist/index',
    healthCheck: { type: 'http', url: 'http://localhost:3333/api/pet', timeoutMs: 3000 },
    category: 'app',
    critical: false,
  },
  {
    name: 'supervisor',
    processPattern: 'supervisor/dist/index',
    category: 'core',
    critical: true,
  },
  {
    name: 'tulipa-mesh',
    processPattern: 'tulipa-mesh/server.js',
    healthCheck: { type: 'http', url: 'http://localhost:3000/api/health', timeoutMs: 5000 },
    category: 'network',
    critical: false,
  },
  {
    name: 'sshd',
    processPattern: 'sshd',
    healthCheck: { type: 'port', port: 8022, timeoutMs: 3000 },
    category: 'infra',
    critical: false,
  },
];

// ── Helpers ────────────────────────────────────────────────────

function safeExec(cmd: string, timeoutMs = 5000): string | null {
  try {
    return execSync(cmd, { timeout: timeoutMs, encoding: 'utf-8' }).trim();
  } catch {
    return null;
  }
}

async function checkHttp(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function checkPort(port: number): boolean {
  const result = safeExec(`ss -tlnp 2>/dev/null | grep :${port} || netstat -tlnp 2>/dev/null | grep :${port}`);
  return !!result && result.length > 0;
}

// ── Process Monitor ────────────────────────────────────────────

export class ProcessMonitor extends EventEmitter {
  private services: Map<string, ServiceState> = new Map();
  private interval: ReturnType<typeof setInterval> | null = null;
  private scanIntervalMs: number;

  constructor(scanIntervalMs = 30_000) {
    super();
    this.scanIntervalMs = scanIntervalMs;

    // Initialize service states
    for (const def of KNOWN_SERVICES) {
      this.services.set(def.name, {
        definition: def,
        status: 'unknown',
        lastCheck: 0,
        lastHealthy: 0,
        consecutiveFails: 0,
        restartCount: 0,
      });
    }
  }

  start(): void {
    console.log(`👁️  Process Monitor started (scan every ${this.scanIntervalMs / 1000}s)`);
    this.scan();
    this.interval = setInterval(() => this.scan(), this.scanIntervalMs);
  }

  stop(): void {
    if (this.interval) clearInterval(this.interval);
    console.log('👁️  Process Monitor stopped');
  }

  async scan(): Promise<ProcessSnapshot> {
    const now = Date.now();

    // Get all processes
    const psOutput = safeExec('ps aux 2>/dev/null || ps -ef 2>/dev/null') || '';
    const lines = psOutput.split('\n').filter(l => l.trim());

    // Count totals
    const totalProcesses = Math.max(0, lines.length - 1); // minus header
    const zombieProcesses = lines.filter(l => / Z[ +]? /.test(l) || /defunct/.test(l)).length;
    const nodeProcesses = lines.filter(l => /node/.test(l)).length;

    // System load
    const loadRaw = safeExec('cat /proc/loadavg 2>/dev/null');
    const systemLoad = loadRaw ? parseFloat(loadRaw.split(' ')[0]) : 0;

    // Memory
    const memInfo = safeExec('cat /proc/meminfo 2>/dev/null');
    let memoryUsedPercent = 0;
    if (memInfo) {
      const total = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0');
      const available = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0');
      if (total > 0) memoryUsedPercent = Math.round(((total - available) / total) * 100);
    }

    // Check each known service
    for (const [name, state] of this.services) {
      const prevStatus = state.status;
      state.lastCheck = now;

      // Find process
      const processLine = lines.find(l => l.includes(state.definition.processPattern));

      if (processLine) {
        // Parse PID and resource usage
        const parts = processLine.trim().split(/\s+/);
        state.pid = parseInt(parts[1]) || parseInt(parts[0]) || undefined;
        state.cpu = parseFloat(parts[2]) || 0;
        state.mem = parseFloat(parts[3]) || 0;

        // Health check if available
        if (state.definition.healthCheck) {
          const healthy = await this.runHealthCheck(state.definition.healthCheck);
          state.status = healthy ? 'running' : 'unhealthy';
        } else {
          state.status = 'running';
        }

        if (state.status === 'running') {
          state.lastHealthy = now;
          state.consecutiveFails = 0;
        } else {
          state.consecutiveFails++;
        }
      } else {
        state.status = 'stopped';
        state.pid = undefined;
        state.cpu = undefined;
        state.mem = undefined;
        state.consecutiveFails++;
      }

      // Emit events on status changes
      if (prevStatus !== state.status) {
        this.emit('status-change', {
          service: name,
          from: prevStatus,
          to: state.status,
          critical: state.definition.critical,
        });

        if (state.status === 'stopped' && state.definition.critical) {
          this.emit('critical-down', { service: name, definition: state.definition });
        }
      }
    }

    const snapshot: ProcessSnapshot = {
      services: Object.fromEntries(this.services),
      totalProcesses,
      zombieProcesses,
      nodeProcesses,
      systemLoad,
      memoryUsedPercent,
      timestamp: now,
    };

    this.emit('scan', snapshot);
    return snapshot;
  }

  private async runHealthCheck(hc: HealthCheck): Promise<boolean> {
    switch (hc.type) {
      case 'http':
        return hc.url ? checkHttp(hc.url, hc.timeoutMs || 5000) : false;
      case 'port':
        return hc.port ? checkPort(hc.port) : false;
      case 'process':
        return true; // if we found the process, it's "healthy"
      default:
        return false;
    }
  }

  // ── Pet Sensor Translation ───────────────────────────────────
  // Traduz o estado dos processos em dados que o pet entende

  toPetSensors(): PetSensorContribution {
    const states = Array.from(this.services.values());
    const critical = states.filter(s => s.definition.critical);
    const criticalUp = critical.filter(s => s.status === 'running').length;
    const criticalTotal = critical.length;
    const allUp = states.filter(s => s.status === 'running').length;
    const allTotal = states.length;

    // Saúde: baseada em serviços críticos rodando
    const saude = criticalTotal > 0
      ? Math.round((criticalUp / criticalTotal) * 100)
      : 50;

    // Segurança: tunnel up + sem processos zumbis
    const tunnelState = this.services.get('cloudflared');
    const tunnelScore = tunnelState?.status === 'running' ? 40 : 0;
    const snapshot = this.getLastSnapshot();
    const zombieScore = snapshot
      ? Math.max(0, 30 - snapshot.zombieProcesses * 10)
      : 15;
    const seguranca = Math.min(100, tunnelScore + zombieScore + 30);

    // Limpeza: poucos processos zumbis, load baixo
    const loadScore = snapshot
      ? Math.max(0, 50 - Math.round(snapshot.systemLoad * 10))
      : 25;
    const limpeza = Math.min(100, loadScore + (50 - (snapshot?.zombieProcesses || 0) * 15));

    // Humor: tudo rodando = pet feliz
    const humor = allTotal > 0
      ? Math.round((allUp / allTotal) * 80) + 20
      : 50;

    return {
      saude,
      seguranca,
      limpeza,
      humor,
      servicesUp: allUp,
      servicesTotal: allTotal,
      criticalUp,
      criticalTotal,
      zombieProcesses: snapshot?.zombieProcesses || 0,
      systemLoad: snapshot?.systemLoad || 0,
      memoryUsedPercent: snapshot?.memoryUsedPercent || 0,
    };
  }

  getServiceStates(): Map<string, ServiceState> {
    return this.services;
  }

  getLastSnapshot(): ProcessSnapshot | null {
    const states = Object.fromEntries(this.services);
    if (!this.services.size) return null;
    const firstState = this.services.values().next().value;
    if (!firstState || firstState.lastCheck === 0) return null;
    return {
      services: states,
      totalProcesses: 0,
      zombieProcesses: 0,
      nodeProcesses: 0,
      systemLoad: 0,
      memoryUsedPercent: 0,
      timestamp: firstState.lastCheck,
    };
  }
}

export interface PetSensorContribution {
  saude: number;
  seguranca: number;
  limpeza: number;
  humor: number;
  servicesUp: number;
  servicesTotal: number;
  criticalUp: number;
  criticalTotal: number;
  zombieProcesses: number;
  systemLoad: number;
  memoryUsedPercent: number;
}
