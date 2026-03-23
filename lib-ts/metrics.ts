// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import os from 'node:os';
import { execFile } from 'node:child_process';

export interface MetricsOptions {
  historySize?: number;
  collectInterval?: number;
}

export interface Counters {
  mcpCalls: number;
  mcpErrors: number;
  messagesRouted: number;
  messagesFailed: number;
  tasksCompleted: number;
  tasksFailed: number;
  httpRequests: number;
}

export interface Peaks {
  cpuPercent: number;
  memoryRss: number;
  memoryHeapUsed: number;
  gpuPercent: number;
  gpuMemoryUsed: number;
}

export interface GpuInfo {
  index: number;
  name: string;
  utilization: number;
  memory: {
    used: number;
    total: number;
    usedPercent: number;
  };
  temperature: number;
}

export interface MemoryInfo {
  process: {
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
  system: {
    total: number;
    free: number;
    used: number;
    usedPercent: number;
  };
}

export interface CpuInfo {
  process: number;
  system: number;
  cores: number;
  model: string;
  loadAvg: number[];
}

export interface UptimeInfo {
  process: number;
  system: number;
  metricsRunning: number;
}

export interface MetricsSnapshot {
  timestamp: string;
  uptime: UptimeInfo;
  cpu: CpuInfo;
  memory: MemoryInfo;
  gpu: GpuInfo[];
  counters: Counters;
  peaks: Peaks;
}

export interface MetricsSummary {
  samples: number;
  period: { from: string; to: string };
  averages: { cpuProcess: number; memoryRss: number };
  peaks: Peaks;
  current: { cpu: CpuInfo; memory: MemoryInfo; gpu: GpuInfo[] };
  counters: Counters;
  uptime: UptimeInfo;
}

export interface MetricsJSON {
  current: MetricsSnapshot | null;
  summary: MetricsSummary | null;
  historySize: number;
}

export default class Metrics {
  private _historySize: number;
  private _collectInterval: number;
  private _history: MetricsSnapshot[];
  private _timer: ReturnType<typeof setInterval> | null;
  private _prevCpuUsage: NodeJS.CpuUsage;
  private _prevCpuTime: number;
  private _gpuAvailable: boolean | null;
  private _tokens: Counters;
  private _peaks: Peaks;
  private _startedAt: number;

  constructor(options: MetricsOptions = {}) {
    this._historySize = options.historySize || 360;
    this._collectInterval = options.collectInterval || 30000;
    this._history = [];
    this._timer = null;
    this._prevCpuUsage = process.cpuUsage();
    this._prevCpuTime = Date.now();
    this._gpuAvailable = null;
    this._tokens = {
      mcpCalls: 0, mcpErrors: 0, messagesRouted: 0,
      messagesFailed: 0, tasksCompleted: 0, tasksFailed: 0, httpRequests: 0,
    };
    this._peaks = {
      cpuPercent: 0, memoryRss: 0, memoryHeapUsed: 0,
      gpuPercent: 0, gpuMemoryUsed: 0,
    };
    this._startedAt = Date.now();
  }

  trackMcpCall(success: boolean = true): void {
    this._tokens.mcpCalls++;
    if (!success) this._tokens.mcpErrors++;
  }

  trackMessage(success: boolean = true): void {
    this._tokens.messagesRouted++;
    if (!success) this._tokens.messagesFailed++;
  }

  trackTask(success: boolean = true): void {
    this._tokens.tasksCompleted++;
    if (!success) this._tokens.tasksFailed++;
  }

  trackHttpRequest(): void {
    this._tokens.httpRequests++;
  }

  private _getCpuPercent(): number {
    const now = Date.now();
    const elapsed = (now - this._prevCpuTime) * 1000;
    const usage = process.cpuUsage(this._prevCpuUsage);
    const totalCpu = usage.user + usage.system;
    const percent = elapsed > 0 ? (totalCpu / elapsed) * 100 : 0;
    this._prevCpuUsage = process.cpuUsage();
    this._prevCpuTime = now;
    return Math.round(percent * 100) / 100;
  }

  private _getSystemCpu(): number {
    const cpus = os.cpus();
    let totalIdle = 0;
    let totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type as keyof typeof cpu.times];
      }
      totalIdle += cpu.times.idle;
    }
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    return Math.round((1 - idle / total) * 10000) / 100;
  }

  private _getMemory(): MemoryInfo {
    const mem = process.memoryUsage();
    const total = os.totalmem();
    const free = os.freemem();
    const used = total - free;
    const usedPercent = Math.round((used / total) * 10000) / 100;
    return {
      process: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers || 0,
      },
      system: { total, free, used, usedPercent },
    };
  }

  private _getGpu(): Promise<GpuInfo[] | null> {
    return new Promise((resolve) => {
      if (this._gpuAvailable === false) return resolve(null);
      execFile(
        'nvidia-smi',
        ['--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name', '--format=csv,noheader,nounits'],
        { timeout: 5000 },
        (err, stdout) => {
          if (err) {
            this._gpuAvailable = false;
            return resolve(null);
          }
          this._gpuAvailable = true;
          const lines = stdout.trim().split('\n');
          const gpus: GpuInfo[] = lines.map((line, i) => {
            const [utilization, memUsed, memTotal, temp, name] = line.split(',').map(s => s.trim());
            const memUsedNum = parseInt(memUsed) || 0;
            const memTotalNum = parseInt(memTotal) || 0;
            return {
              index: i,
              name: name || `GPU ${i}`,
              utilization: parseFloat(utilization) || 0,
              memory: {
                used: memUsedNum,
                total: memTotalNum,
                usedPercent: memTotalNum > 0 ? Math.round((memUsedNum / memTotalNum) * 10000) / 100 : 0,
              },
              temperature: parseInt(temp) || 0,
            };
          });
          resolve(gpus);
        },
      );
    });
  }

  async collect(): Promise<MetricsSnapshot> {
    const cpuProcess = this._getCpuPercent();
    const cpuSystem = this._getSystemCpu();
    const memory = this._getMemory();
    const gpu = await this._getGpu();

    if (cpuProcess > this._peaks.cpuPercent) this._peaks.cpuPercent = cpuProcess;
    if (memory.process.rss > this._peaks.memoryRss) this._peaks.memoryRss = memory.process.rss;
    if (memory.process.heapUsed > this._peaks.memoryHeapUsed) this._peaks.memoryHeapUsed = memory.process.heapUsed;
    if (gpu && gpu[0]) {
      if (gpu[0].utilization > this._peaks.gpuPercent) this._peaks.gpuPercent = gpu[0].utilization;
      if (gpu[0].memory.used > this._peaks.gpuMemoryUsed) this._peaks.gpuMemoryUsed = gpu[0].memory.used;
    }

    const snapshot: MetricsSnapshot = {
      timestamp: new Date().toISOString(),
      uptime: {
        process: Math.floor(process.uptime()),
        system: Math.floor(os.uptime()),
        metricsRunning: Math.floor((Date.now() - this._startedAt) / 1000),
      },
      cpu: {
        process: cpuProcess,
        system: cpuSystem,
        cores: os.cpus().length,
        model: os.cpus()[0]?.model || 'unknown',
        loadAvg: os.loadavg(),
      },
      memory,
      gpu: gpu || [],
      counters: { ...this._tokens },
      peaks: { ...this._peaks },
    };

    this._history.push(snapshot);
    if (this._history.length > this._historySize) this._history.shift();
    return snapshot;
  }

  summary(): MetricsSummary | null {
    if (this._history.length === 0) return null;
    const len = this._history.length;
    let cpuSum = 0;
    let memSum = 0;
    for (const s of this._history) {
      cpuSum += s.cpu.process;
      memSum += s.memory.process.rss;
    }
    const last = this._history[len - 1];
    return {
      samples: len,
      period: { from: this._history[0].timestamp, to: last.timestamp },
      averages: {
        cpuProcess: Math.round((cpuSum / len) * 100) / 100,
        memoryRss: Math.round(memSum / len),
      },
      peaks: { ...this._peaks },
      current: { cpu: last.cpu, memory: last.memory, gpu: last.gpu },
      counters: { ...this._tokens },
      uptime: last.uptime,
    };
  }

  history(limit: number = 60): MetricsSnapshot[] {
    return this._history.slice(-limit);
  }

  static formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  compact(): string {
    const last = this._history[this._history.length - 1];
    if (!last) return '(sem dados)';
    const mem = Metrics.formatBytes(last.memory.process.rss);
    const heap = Metrics.formatBytes(last.memory.process.heapUsed);
    const gpu = last.gpu.length > 0 ? ` | GPU: ${last.gpu[0].utilization}%` : '';
    return `CPU: ${last.cpu.process}% | Mem: ${mem} (heap: ${heap})${gpu} | Calls: ${this._tokens.mcpCalls} | Msgs: ${this._tokens.messagesRouted}`;
  }

  start(): void {
    if (this._timer) return;
    this.collect().catch(() => {});
    this._timer = setInterval(() => {
      this.collect().catch((err: Error) => {
        console.error(`[metrics] Erro na coleta: ${err.message}`);
      });
    }, this._collectInterval);
    console.log(`[metrics] Coleta a cada ${this._collectInterval / 1000}s (histórico: ${this._historySize} amostras)`);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON(): MetricsJSON {
    const last = this._history[this._history.length - 1];
    return {
      current: last || null,
      summary: this.summary(),
      historySize: this._history.length,
    };
  }
}
