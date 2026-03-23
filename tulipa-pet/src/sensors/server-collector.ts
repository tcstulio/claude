/**
 * Server Sensor Collector (Linux)
 * Collects sensor data from a Linux server (like the 2070 RTX machine)
 */

import { execSync } from 'child_process';
import type { SensorData } from '../types.js';

function safeExec(cmd: string, fallback: string | null = null): string | null {
  try {
    return execSync(cmd, { timeout: 5000, encoding: 'utf-8' }).trim();
  } catch {
    return fallback;
  }
}

export async function collectServerSensors(): Promise<SensorData> {
  const sensors: SensorData = {};

  // CPU Usage
  const stat1 = safeExec("head -1 /proc/stat");
  if (stat1) {
    const parts = stat1.split(/\s+/).slice(1).map(Number);
    const idle = parts[3];
    const total = parts.reduce((a, b) => a + b, 0);
    sensors.cpuUsage = Math.round(((total - idle) / total) * 100);
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
  const diskRaw = safeExec("df -h / | tail -1 | awk '{print $5}'");
  if (diskRaw) {
    sensors.diskUsage = parseInt(diskRaw) || 0;
  }

  // GPU Temperature (NVIDIA 2070)
  const gpuTemp = safeExec('nvidia-smi --query-gpu=temperature.gpu --format=csv,noheader 2>/dev/null');
  if (gpuTemp) {
    sensors.gpuTemperature = parseInt(gpuTemp);
    // Map GPU temp as "fever" - ideal 30-70, critical > 85
    sensors.temperature = parseInt(gpuTemp);
  }

  // GPU Usage
  const gpuUsage = safeExec('nvidia-smi --query-gpu=utilization.gpu --format=csv,noheader 2>/dev/null');
  if (gpuUsage) {
    sensors.gpuUsage = parseInt(gpuUsage);
  }

  // GPU Memory
  const gpuMemTotal = safeExec('nvidia-smi --query-gpu=memory.total --format=csv,noheader 2>/dev/null');
  const gpuMemUsed = safeExec('nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null');
  if (gpuMemTotal && gpuMemUsed) {
    const total = parseInt(gpuMemTotal);
    const used = parseInt(gpuMemUsed);
    sensors.gpuMemoryUsage = Math.round((used / total) * 100);
  }

  // CPU Temperature
  const cpuTemp = safeExec('cat /sys/class/thermal/thermal_zone0/temp 2>/dev/null');
  if (cpuTemp) {
    sensors.cpuTemperature = Math.round(parseInt(cpuTemp) / 1000);
    if (!sensors.temperature) sensors.temperature = sensors.cpuTemperature;
  }

  // Uptime
  const uptimeRaw = safeExec('cat /proc/uptime');
  if (uptimeRaw) {
    sensors.uptimeHours = Math.round(parseFloat(uptimeRaw.split(' ')[0]) / 3600);
  }

  // Process count (zombie = "fleas")
  const zombies = safeExec("ps aux | awk '$8 ~ /Z/ {count++} END {print count+0}'");
  sensors.zombieProcesses = parseInt(zombies ?? '0') || 0;

  // Load average
  const loadAvg = safeExec('cat /proc/loadavg');
  if (loadAvg) {
    sensors.loadAverage = parseFloat(loadAvg.split(' ')[0]);
  }

  // Log errors (last hour)
  const errorCount = safeExec("journalctl --since '1 hour ago' -p err --no-pager 2>/dev/null | wc -l");
  if (errorCount) {
    sensors.errorRate = Math.min(50, parseInt(errorCount) || 0);
  }

  // Docker containers (if running)
  const dockerCount = safeExec('docker ps -q 2>/dev/null | wc -l');
  if (dockerCount) {
    sensors.runningContainers = parseInt(dockerCount) || 0;
  }

  // Network connections
  const connections = safeExec("ss -tun | tail -n +2 | wc -l");
  if (connections) {
    sensors.activeConnections = parseInt(connections) || 0;
  }

  // Failed SSH attempts (security)
  const failedSSH = safeExec("journalctl -u sshd --since '1 hour ago' --no-pager 2>/dev/null | grep -c 'Failed' 2>/dev/null");
  if (failedSSH) {
    sensors.failedLogins = parseInt(failedSSH) || 0;
  }

  // Hour of day
  sensors.hourOfDay = new Date().getHours();

  // Simulate battery as 100 for servers (always plugged in, but energy = resources available)
  const cpuFree = 100 - (sensors.cpuUsage || 0);
  sensors.battery = Math.round(cpuFree * 0.7 + 30); // Base 30, scales with free CPU

  return sensors;
}
