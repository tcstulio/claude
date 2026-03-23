/**
 * Sensor Collector Factory
 * Auto-detects the environment and returns the appropriate collectors
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import { collectAndroidSensors } from './android-collector.js';
import { collectServerSensors } from './server-collector.js';
import { collectTulipaSensors } from './tulipa-collector.js';
import type { AgentType, SensorData } from '../types.js';

export type { AgentType, SensorData } from '../types.js';

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
  const localSensors = envType === 'android'
    ? await collectAndroidSensors()
    : await collectServerSensors();

  const tulipaSensors = await collectTulipaSensors();

  return { ...localSensors, ...tulipaSensors };
}
