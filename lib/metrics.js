'use strict';

const os = require('os');
const { execFile } = require('child_process');

/**
 * Metrics — coleta e rastreia uso de recursos do sistema.
 *
 * Métricas coletadas:
 *   - CPU: uso percentual (média dos cores)
 *   - Memória: RSS do processo, heap, total/free do sistema
 *   - GPU: uso e memória (via nvidia-smi, se disponível)
 *   - Tokens: contagem de chamadas MCP e tokens estimados
 *   - Uptime: do processo e do sistema
 *
 * Mantém histórico circular para análise de tendências.
 */
class Metrics {
  /**
   * @param {object} options
   * @param {number} options.historySize - máximo de snapshots no histórico (default 360 = 1h a cada 10s)
   * @param {number} options.collectInterval - ms entre coletas automáticas (default 30s)
   */
  constructor(options = {}) {
    this._historySize = options.historySize || 360;
    this._collectInterval = options.collectInterval || 30000;
    this._history = [];
    this._timer = null;
    this._prevCpuUsage = process.cpuUsage();
    this._prevCpuTime = Date.now();
    this._gpuAvailable = null; // null = não testado ainda

    // Contadores de economia
    this._tokens = {
      mcpCalls: 0,
      mcpErrors: 0,
      messagesRouted: 0,
      messagesFailed: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      httpRequests: 0,
    };

    // Pico de uso (watermarks)
    this._peaks = {
      cpuPercent: 0,
      memoryRss: 0,
      memoryHeapUsed: 0,
      gpuPercent: 0,
      gpuMemoryUsed: 0,
    };

    this._startedAt = Date.now();
  }

  // ─── Contadores ──────────────────────────────────────────────────

  /** Registra uma chamada MCP */
  trackMcpCall(success = true) {
    this._tokens.mcpCalls++;
    if (!success) this._tokens.mcpErrors++;
  }

  /** Registra mensagem roteada */
  trackMessage(success = true) {
    this._tokens.messagesRouted++;
    if (!success) this._tokens.messagesFailed++;
  }

  /** Registra task completada */
  trackTask(success = true) {
    this._tokens.tasksCompleted++;
    if (!success) this._tokens.tasksFailed++;
  }

  /** Registra request HTTP */
  trackHttpRequest() {
    this._tokens.httpRequests++;
  }

  // ─── Coleta de CPU ────────────────────────────────────────────────

  _getCpuPercent() {
    const now = Date.now();
    const elapsed = (now - this._prevCpuTime) * 1000; // microseconds
    const usage = process.cpuUsage(this._prevCpuUsage);
    const totalCpu = usage.user + usage.system;
    const percent = elapsed > 0 ? (totalCpu / elapsed) * 100 : 0;

    this._prevCpuUsage = process.cpuUsage();
    this._prevCpuTime = now;

    return Math.round(percent * 100) / 100;
  }

  _getSystemCpu() {
    const cpus = os.cpus();
    let totalIdle = 0, totalTick = 0;
    for (const cpu of cpus) {
      for (const type in cpu.times) {
        totalTick += cpu.times[type];
      }
      totalIdle += cpu.times.idle;
    }
    const idle = totalIdle / cpus.length;
    const total = totalTick / cpus.length;
    return Math.round((1 - idle / total) * 10000) / 100;
  }

  // ─── Coleta de Memória ────────────────────────────────────────────

  _getMemory() {
    const mem = process.memoryUsage();
    const sysMem = {
      total: os.totalmem(),
      free: os.freemem(),
    };
    sysMem.used = sysMem.total - sysMem.free;
    sysMem.usedPercent = Math.round((sysMem.used / sysMem.total) * 10000) / 100;

    return {
      process: {
        rss: mem.rss,
        heapTotal: mem.heapTotal,
        heapUsed: mem.heapUsed,
        external: mem.external,
        arrayBuffers: mem.arrayBuffers || 0,
      },
      system: sysMem,
    };
  }

  // ─── Coleta de GPU (nvidia-smi) ──────────────────────────────────

  _getGpu() {
    return new Promise((resolve) => {
      if (this._gpuAvailable === false) {
        return resolve(null);
      }

      execFile('nvidia-smi', [
        '--query-gpu=utilization.gpu,memory.used,memory.total,temperature.gpu,name',
        '--format=csv,noheader,nounits'
      ], { timeout: 5000 }, (err, stdout) => {
        if (err) {
          this._gpuAvailable = false;
          return resolve(null);
        }
        this._gpuAvailable = true;

        const lines = stdout.trim().split('\n');
        const gpus = lines.map((line, i) => {
          const [utilization, memUsed, memTotal, temp, name] = line.split(',').map(s => s.trim());
          return {
            index: i,
            name: name || `GPU ${i}`,
            utilization: parseFloat(utilization) || 0,
            memory: {
              used: parseInt(memUsed) || 0,
              total: parseInt(memTotal) || 0,
              usedPercent: memTotal > 0 ? Math.round((memUsed / memTotal) * 10000) / 100 : 0,
            },
            temperature: parseInt(temp) || 0,
          };
        });
        resolve(gpus);
      });
    });
  }

  // ─── Snapshot completo ────────────────────────────────────────────

  async collect() {
    const cpuProcess = this._getCpuPercent();
    const cpuSystem = this._getSystemCpu();
    const memory = this._getMemory();
    const gpu = await this._getGpu();

    // Atualiza picos
    if (cpuProcess > this._peaks.cpuPercent) this._peaks.cpuPercent = cpuProcess;
    if (memory.process.rss > this._peaks.memoryRss) this._peaks.memoryRss = memory.process.rss;
    if (memory.process.heapUsed > this._peaks.memoryHeapUsed) this._peaks.memoryHeapUsed = memory.process.heapUsed;
    if (gpu && gpu[0]) {
      if (gpu[0].utilization > this._peaks.gpuPercent) this._peaks.gpuPercent = gpu[0].utilization;
      if (gpu[0].memory.used > this._peaks.gpuMemoryUsed) this._peaks.gpuMemoryUsed = gpu[0].memory.used;
    }

    const snapshot = {
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

    // Adiciona ao histórico circular
    this._history.push(snapshot);
    if (this._history.length > this._historySize) {
      this._history.shift();
    }

    return snapshot;
  }

  // ─── Análise de tendências ────────────────────────────────────────

  /** Resumo com médias e picos do histórico */
  summary() {
    if (this._history.length === 0) return null;

    const len = this._history.length;
    let cpuSum = 0, memSum = 0;
    for (const s of this._history) {
      cpuSum += s.cpu.process;
      memSum += s.memory.process.rss;
    }

    const last = this._history[len - 1];
    return {
      samples: len,
      period: {
        from: this._history[0].timestamp,
        to: last.timestamp,
      },
      averages: {
        cpuProcess: Math.round((cpuSum / len) * 100) / 100,
        memoryRss: Math.round(memSum / len),
      },
      peaks: { ...this._peaks },
      current: {
        cpu: last.cpu,
        memory: last.memory,
        gpu: last.gpu,
      },
      counters: { ...this._tokens },
      uptime: last.uptime,
    };
  }

  /** Últimos N snapshots */
  history(limit = 60) {
    return this._history.slice(-limit);
  }

  // ─── Formatação legível ───────────────────────────────────────────

  static formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
  }

  /** Resumo compacto para logs/alertas */
  compact() {
    const last = this._history[this._history.length - 1];
    if (!last) return '(sem dados)';

    const mem = Metrics.formatBytes(last.memory.process.rss);
    const heap = Metrics.formatBytes(last.memory.process.heapUsed);
    const gpu = last.gpu.length > 0 ? ` | GPU: ${last.gpu[0].utilization}%` : '';
    return `CPU: ${last.cpu.process}% | Mem: ${mem} (heap: ${heap})${gpu} | Calls: ${this._tokens.mcpCalls} | Msgs: ${this._tokens.messagesRouted}`;
  }

  // ─── Lifecycle ────────────────────────────────────────────────────

  start() {
    if (this._timer) return;
    // Coleta imediata
    this.collect().catch(() => {});
    this._timer = setInterval(() => {
      this.collect().catch(err => {
        console.error(`[metrics] Erro na coleta: ${err.message}`);
      });
    }, this._collectInterval);
    console.log(`[metrics] Coleta a cada ${this._collectInterval / 1000}s (histórico: ${this._historySize} amostras)`);
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  toJSON() {
    const last = this._history[this._history.length - 1];
    return {
      current: last || null,
      summary: this.summary(),
      historySize: this._history.length,
    };
  }
}

module.exports = Metrics;
