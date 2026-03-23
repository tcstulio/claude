/**
 * API Collector
 * Fetches sensor data from the Tulipa API's /api/metrics/sensors endpoint
 * instead of collecting locally (eliminates duplicate nvidia-smi, /proc reads, etc.)
 *
 * Falls back to server-collector.ts if the API is unreachable.
 */

import type { SensorData } from '../types.js';
import { collectServerSensors } from './server-collector.js';

const TULIPA_API_URL = process.env.TULIPA_API_URL || 'http://localhost:3000';
const API_TIMEOUT = 5000;

let _consecutiveFailures = 0;
let _lastFallbackLog = 0;

export async function collectApiSensors(): Promise<SensorData> {
  try {
    const res = await fetch(`${TULIPA_API_URL}/api/metrics/sensors`, {
      signal: AbortSignal.timeout(API_TIMEOUT),
    });

    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const data = await res.json() as SensorData;
    _consecutiveFailures = 0;
    return data;
  } catch (err) {
    _consecutiveFailures++;

    // Log fallback, but not more than once per minute
    const now = Date.now();
    if (now - _lastFallbackLog > 60_000) {
      console.warn(
        `[api-collector] API indisponível (${(err as Error).message}), ` +
        `usando fallback local (falhas: ${_consecutiveFailures})`
      );
      _lastFallbackLog = now;
    }

    // Fallback to local collection
    return collectServerSensors();
  }
}

/**
 * Check if the API is reachable.
 */
export async function isApiAvailable(): Promise<boolean> {
  try {
    const res = await fetch(`${TULIPA_API_URL}/api/health`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
