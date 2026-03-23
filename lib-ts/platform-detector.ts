// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// PlatformDetector — auto-detect platform, tools, and data sources at boot.

import { execSync } from "node:child_process";
import os from "node:os";
import fs from "node:fs";

export type Platform = "windows" | "linux" | "android" | "macos";
export type DataSourceType = "realtime" | "historical" | "computed";

export interface DataSource {
  name: string;
  type: DataSourceType;
  scope: string | null;
}

export interface HardwareInfo {
  cores: number;
  arch: string;
  memoryGB: number;
  gpu: boolean;
  gpuName: string | null;
}

export interface PlatformDetection {
  platform: Platform;
  tools: string[];
  dataSources: DataSource[];
  hardware: HardwareInfo;
  detectedAt: string;
}

interface ToolEntry {
  cmd: string;
  capability: string;
  alt?: string;
}

export function isTermux(): boolean {
  return !!(process.env.TERMUX_VERSION || fs.existsSync("/data/data/com.termux"));
}

export function detectPlatform(): Platform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  if (isTermux()) return "android";
  return "linux";
}

export function commandExists(cmd: string): boolean {
  try {
    const check = process.platform === "win32" ? `where ${cmd} 2>nul` : `command -v ${cmd} 2>/dev/null`;
    execSync(check, { stdio: "pipe", timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: "pipe", timeout: 5000 }).toString().trim();
  } catch {
    return null;
  }
}

export const PLATFORM_TOOLS: Record<Platform, ToolEntry[]> = {
  windows: [
    { cmd: "powershell", capability: "powershell" },
    { cmd: "cmd", capability: "cmd" },
    { cmd: "wsl", capability: "wsl" },
    { cmd: "schtasks", capability: "task-scheduler" },
  ],
  linux: [
    { cmd: "bash", capability: "bash" },
    { cmd: "systemctl", capability: "systemd" },
    { cmd: "crontab", capability: "cron" },
    { cmd: "iptables", capability: "iptables" },
    { cmd: "apt", capability: "apt" },
    { cmd: "yum", capability: "yum" },
    { cmd: "dnf", capability: "dnf" },
  ],
  android: [
    { cmd: "termux-battery-status", capability: "termux-api" },
    { cmd: "termux-location", capability: "gps-location" },
    { cmd: "termux-camera-photo", capability: "camera" },
    { cmd: "termux-sms-send", capability: "sms" },
    { cmd: "termux-notification", capability: "termux-notification" },
    { cmd: "termux-wifi-connectioninfo", capability: "wifi-info" },
    { cmd: "termux-sensor", capability: "sensors" },
    { cmd: "bash", capability: "bash" },
  ],
  macos: [
    { cmd: "bash", capability: "bash" },
    { cmd: "brew", capability: "brew" },
    { cmd: "launchctl", capability: "launchctl" },
    { cmd: "osascript", capability: "osascript" },
  ],
};

export const CROSS_PLATFORM_TOOLS: ToolEntry[] = [
  { cmd: "docker", capability: "docker" },
  { cmd: "git", capability: "git" },
  { cmd: "node", capability: "code-execution" },
  { cmd: "python3", capability: "python", alt: "python" },
  { cmd: "ffmpeg", capability: "media-processing" },
  { cmd: "cloudflared", capability: "tunnel" },
  { cmd: "ssh", capability: "ssh" },
  { cmd: "rsync", capability: "rsync" },
  { cmd: "curl", capability: "http-client" },
  { cmd: "nginx", capability: "web-server" },
  { cmd: "pm2", capability: "process-manager" },
];

export function detectTools(platform: Platform): string[] {
  const tools: string[] = [];
  for (const { cmd, capability } of PLATFORM_TOOLS[platform] ?? []) {
    if (commandExists(cmd)) tools.push(capability);
  }
  for (const { cmd, capability, alt } of CROSS_PLATFORM_TOOLS) {
    if (commandExists(cmd) || (alt && commandExists(alt))) tools.push(capability);
  }
  return [...new Set(tools)];
}

export function detectHardware(): HardwareInfo {
  const cpus = os.cpus();
  const hw: HardwareInfo = {
    cores: cpus.length,
    arch: os.arch(),
    memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    gpu: false,
    gpuName: null,
  };

  const nvidiaSmi = commandOutput("nvidia-smi --query-gpu=name --format=csv,noheader");
  if (nvidiaSmi) {
    hw.gpu = true;
    hw.gpuName = nvidiaSmi.split("\n")[0].trim();
  }

  return hw;
}

export const PLATFORM_DATA_SOURCES: Record<Platform, DataSource[]> = {
  windows: [
    { name: "event-log", type: "historical", scope: null },
    { name: "wmi-metrics", type: "realtime", scope: null },
  ],
  linux: [
    { name: "proc-metrics", type: "realtime", scope: null },
    { name: "journal-log", type: "historical", scope: null },
    { name: "syslog", type: "historical", scope: null },
  ],
  android: [
    { name: "gps-location", type: "realtime", scope: "personal" },
    { name: "battery", type: "realtime", scope: null },
    { name: "device-sensors", type: "realtime", scope: "personal" },
    { name: "wifi-info", type: "realtime", scope: null },
  ],
  macos: [
    { name: "system-profiler", type: "realtime", scope: null },
  ],
};

export function detectDataSources(platform: Platform): DataSource[] {
  const sources = [...(PLATFORM_DATA_SOURCES[platform] ?? [])];
  if (commandExists("nvidia-smi")) sources.push({ name: "gpu-metrics", type: "realtime", scope: null });
  if (commandExists("docker")) sources.push({ name: "container-metrics", type: "realtime", scope: null });
  return sources;
}

export function detect(): PlatformDetection {
  const platform = detectPlatform();
  const tools = detectTools(platform);
  const dataSources = detectDataSources(platform);
  const hardware = detectHardware();

  if (hardware.gpu) tools.push("gpu-compute");

  const result: PlatformDetection = {
    platform,
    tools: [...new Set(tools)],
    dataSources,
    hardware,
    detectedAt: new Date().toISOString(),
  };

  console.log(
    `[platform] Detected: ${platform} | ${result.tools.length} tools | ${dataSources.length} data sources | ${hardware.cores} cores, ${hardware.memoryGB}GB RAM${hardware.gpu ? `, GPU: ${hardware.gpuName}` : ""}`,
  );

  return result;
}
