/**
 * Android Sensor Collector (Termux)
 * Collects real sensor data from Android device via Termux API
 */

import { execSync } from 'child_process';
import type {
  SensorData,
  TermuxBatteryStatus,
  TermuxWifiInfo,
  TermuxLocation,
  TermuxSensorList,
} from '../types.js';

function safeExec(cmd: string, fallback: string | null = null): string | null {
  try {
    return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return fallback;
  }
}

function safeJSON<T extends Record<string, unknown>>(cmd: string, fallback: T = {} as T): T {
  const raw = safeExec(cmd);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export async function collectAndroidSensors(): Promise<SensorData> {
  const sensors: SensorData = {};

  // Battery (energia / temperature)
  const battery = safeJSON<TermuxBatteryStatus>('termux-battery-status');
  if (battery.percentage !== undefined) {
    sensors.battery = battery.percentage;
  }
  if (battery.temperature !== undefined) {
    sensors.temperature = battery.temperature;
  }

  // CPU Usage
  const cpuRaw = safeExec("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'");
  if (cpuRaw) {
    sensors.cpuUsage = parseFloat(cpuRaw) || 0;
  } else {
    // Fallback: read /proc/stat
    const stat1 = safeExec("cat /proc/stat | head -1");
    if (stat1) {
      const parts = stat1.split(/\s+/).slice(1).map(Number);
      const idle = parts[3];
      const total = parts.reduce((a, b) => a + b, 0);
      sensors.cpuUsage = Math.round(((total - idle) / total) * 100);
    }
  }

  // Memory Usage
  const memInfo = safeExec('cat /proc/meminfo');
  if (memInfo) {
    const total = parseInt(memInfo.match(/MemTotal:\s+(\d+)/)?.[1] || '0');
    const available = parseInt(memInfo.match(/MemAvailable:\s+(\d+)/)?.[1] || '0');
    if (total > 0) {
      sensors.memoryUsage = Math.round(((total - available) / total) * 100);
    }
  }

  // Disk Usage
  const diskRaw = safeExec("df -h /data 2>/dev/null | tail -1 | awk '{print $5}'");
  if (diskRaw) {
    sensors.diskUsage = parseInt(diskRaw) || 0;
  }

  // WiFi Signal
  const wifi = safeJSON<TermuxWifiInfo>('termux-wifi-connectioninfo');
  if (wifi.rssi !== undefined) {
    // RSSI typically -30 (excellent) to -90 (terrible), map to 0-100
    sensors.wifiSignal = Math.max(0, Math.min(100, (wifi.rssi + 90) * (100 / 60)));
  }

  // GPS / Location (for "adventure" detection)
  // Only check occasionally as it uses battery
  const location = safeJSON<TermuxLocation>('termux-location -p network -r once 2>/dev/null');
  if (location.latitude) {
    sensors.location = {
      lat: location.latitude,
      lon: location.longitude!,
    };
  }

  // Uptime
  const uptimeRaw = safeExec('cat /proc/uptime');
  if (uptimeRaw) {
    sensors.uptimeHours = Math.round(parseFloat(uptimeRaw.split(' ')[0]) / 3600);
  }

  // Hour of day (circadian rhythm)
  sensors.hourOfDay = new Date().getHours();

  // Sensor data (accelerometer, light)
  const sensorList = safeJSON<TermuxSensorList>('termux-sensor -l 2>/dev/null');
  if (sensorList?.sensors) {
    // Check if device has light/accelerometer sensors
    sensors.hasSensors = sensorList.sensors.map(s => s.name);
  }

  return sensors;
}
