// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CallMcpToolFn, FetchFn, AuthHeadersFn, RouterLike } from '../types.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface MonitorDeps {
  callMcpTool: CallMcpToolFn;
  proxyFetch: FetchFn;
  authHeaders: AuthHeadersFn;
  router: RouterLike;
  alertPhone: string;
  slowThreshold: number;
  monitorInterval: number;
  gatewayUrl: string;
  dataDir?: string;
}

export interface MonitorState {
  status: string;
  lastCheck: string | null;
  lastOk: string | null;
  lastError: string | null;
  errorMessage: string | null;
  responseTime: number | null;
  consecutiveFailures: number;
  alertSent: boolean;
}

// ─── MonitorService ──────────────────────────────────────────────────────────

export class MonitorService extends EventEmitter {
  private _deps: MonitorDeps;
  private _state: MonitorState;
  private _statePath: string;
  private _timer: ReturnType<typeof setInterval> | null = null;

  constructor(deps: MonitorDeps) {
    super();
    this._deps = deps;
    this._statePath = path.join(deps.dataDir || './data', 'monitor-state.json');
    this._state = this._loadState();
  }

  private _loadState(): MonitorState {
    const defaults: MonitorState = {
      status: 'unknown',
      lastCheck: null,
      lastOk: null,
      lastError: null,
      errorMessage: null,
      responseTime: null,
      consecutiveFailures: 0,
      alertSent: false,
    };
    try {
      if (fs.existsSync(this._statePath)) {
        const saved = JSON.parse(fs.readFileSync(this._statePath, 'utf-8'));
        return { ...defaults, ...saved };
      }
    } catch { /* usa defaults */ }
    return defaults;
  }

  private _saveState(): void {
    try {
      const dir = path.dirname(this._statePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this._statePath, JSON.stringify(this._state, null, 2));
    } catch { /* best effort */ }
  }

  getState(): MonitorState {
    return { ...this._state };
  }

  getConfig(): Record<string, unknown> {
    return {
      interval: this._deps.monitorInterval,
      alertPhone: this._deps.alertPhone
        ? `***${this._deps.alertPhone.slice(-4)}`
        : '(não configurado)',
      slowThreshold: this._deps.slowThreshold,
    };
  }

  start(): void {
    const { monitorInterval, alertPhone } = this._deps;
    if (!monitorInterval || monitorInterval < 10000) return;

    console.log(`[monitor] Watchdog ativo — check a cada ${monitorInterval / 1000}s`);
    if (alertPhone) {
      const channels = [...this._deps.router._transports.keys()].join(' → ');
      console.log(`[monitor] Alertas para ***${alertPhone.slice(-4)} via ${channels} (fallback automático)`);
    } else {
      console.log('[monitor] ALERT_PHONE não configurado — alertas somente no console');
    }

    setTimeout(() => {
      this.runHealthCheck();
      this._timer = setInterval(() => this.runHealthCheck(), monitorInterval);
    }, 10000);
  }

  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  private async _sendAlert(message: string): Promise<void> {
    if (!this._deps.alertPhone) {
      console.log(`[monitor] Alerta (sem ALERT_PHONE): ${message}`);
      return;
    }
    const result = await this._deps.router.send(this._deps.alertPhone, message);
    if (result.ok) {
      console.log(`[monitor] Alerta enviado via ${result.channel}`);
    } else if (result.queued) {
      console.log(`[monitor] Alerta enfileirado (${result.id})`);
    } else {
      console.error(`[monitor] Falha ao enviar alerta: ${JSON.stringify(result.errors)}`);
    }
  }

  async runHealthCheck(): Promise<void> {
    const start = Date.now();
    const s = this._state;
    s.lastCheck = new Date().toISOString();

    try {
      // 1. Testa health do Express/gateway
      const healthRes = await this._deps.proxyFetch(`${this._deps.gatewayUrl}/api/health`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!healthRes.ok) throw new Error(`Health retornou ${healthRes.status}`);
      await healthRes.json();

      // 2. Testa MCP
      const mcpRes = await this._deps.proxyFetch(`${this._deps.gatewayUrl}/mcp`, {
        method: 'POST',
        headers: this._deps.authHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'tools/call',
          id: 0,
          params: { name: 'get_status', arguments: {} },
        }),
        signal: AbortSignal.timeout(15000),
      });

      const elapsed = Date.now() - start;
      s.responseTime = elapsed;

      if (!mcpRes.ok) {
        const text = await mcpRes.text();
        const isHtml = text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html');
        throw new Error(isHtml ? `MCP offline (${mcpRes.status})` : `MCP erro ${mcpRes.status}: ${text.slice(0, 200)}`);
      }

      // 3. Verifica se está lento
      if (elapsed > this._deps.slowThreshold) {
        s.status = 'degraded';
        s.errorMessage = `Resposta lenta: ${elapsed}ms`;
        s.consecutiveFailures++;

        if (!s.alertSent && s.consecutiveFailures >= 2) {
          s.alertSent = true;
          await this._sendAlert(`Tulipa lenta — resposta em ${elapsed}ms (limite: ${this._deps.slowThreshold}ms)`);
        }
        this._saveState();
        this.emit('degraded', { elapsed });
        return;
      }

      // Tudo OK
      const wasDown = s.status === 'offline' || s.status === 'degraded';
      s.status = 'ok';
      s.lastOk = s.lastCheck;
      s.errorMessage = null;
      s.consecutiveFailures = 0;

      if (wasDown && s.alertSent) {
        s.alertSent = false;
        await this._sendAlert(`Tulipa voltou ao normal — resposta em ${elapsed}ms`);
      }

      this._saveState();
      this.emit('ok', { elapsed });

    } catch (err) {
      const elapsed = Date.now() - start;
      s.responseTime = elapsed;
      s.status = 'offline';
      s.lastError = s.lastCheck;
      s.errorMessage = (err as Error).message;
      s.consecutiveFailures++;

      console.error(`[monitor] Falha #${s.consecutiveFailures}: ${(err as Error).message}`);

      if (!s.alertSent && s.consecutiveFailures >= 2) {
        s.alertSent = true;
        await this._sendAlert(`Tulipa OFFLINE — ${(err as Error).message} (${s.consecutiveFailures} falhas consecutivas)`);
      }

      this._saveState();
      this.emit('offline', { error: (err as Error).message });
    }
  }
}

export default MonitorService;
