/**
 * Sensor Collector Factory
 * Auto-detects the environment and returns the appropriate collectors.
 *
 * Priority for server/desktop:
 *   1. Tulipa API (/api/metrics/sensors) — single source of truth
 *   2. Local collection (server-collector.ts) — fallback if API down
 *
 * Android always uses its own collector (Termux APIs).
 * Terminal sensors are collected separately from /api/terminal/panes.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { collectAndroidSensors } from './android-collector.js';
import { collectServerSensors } from './server-collector.js';
import { collectApiSensors, isApiAvailable } from './api-collector.js';
import { collectTulipaSensors } from './tulipa-collector.js';
import { collectTerminalSensors } from './terminal-collector.js';
import type { AgentType, SensorData } from '../types.js';

export type { AgentType, SensorData } from '../types.js';

let _useApi: boolean | null = null; // null = not tested yet

export function detectEnvironment(): AgentType {
  // Check if running on Termux (Android)
  if (process.env.TERMUX_VERSION || existsSync('/data/data/com.termux')) {
    return 'android';
  }

  // Check for NVIDIA GPU (server 2070)
  try {
    execSync('nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null', { encoding: 'utf-8' });
    return 'server';
  } catch {
    // no GPU
  }

  // Check if it's a server (systemd, many CPUs, etc.)
  try {
    const cpuCount = parseInt(execSync('nproc', { encoding: 'utf-8' }).trim());
    if (cpuCount >= 4) return 'server';
  } catch {
    // ignore
  }

  return 'desktop';
}

export async function collectAllSensors(envType: AgentType): Promise<SensorData> {
  // Android always uses local Termux APIs
  if (envType === 'android') {
    const localSensors = await collectAndroidSensors();
    const tulipaSensors = await collectTulipaSensors();
    return { ...localSensors, ...tulipaSensors };
  }

  // Server/Desktop: try Tulipa API first (has richer data + no duplicate nvidia-smi)
  if (_useApi === null) {
    _useApi = await isApiAvailable();
    if (_useApi) {
      console.log('[sensors] Usando Tulipa API como fonte de métricas');
    } else {
      console.log('[sensors] Tulipa API não disponível, usando coleta local');
    }
  }

  const localSensors = _useApi
    ? await collectApiSensors()
    : await collectServerSensors();

  // Tulipa network sensors (MCP calls — peers, tokens, tasks, WhatsApp)
  const tulipaSensors = await collectTulipaSensors();

  // Terminal sensors (tmux state — mood/energy influence)
  const terminalSensors = await collectTerminalSensors();

  return { ...localSensors, ...tulipaSensors, ...terminalSensors };
}

/**
 * Force re-check API availability (e.g., after Tulipa API starts/stops)
 */
export function resetApiDetection(): void {
  _useApi = null;
}
