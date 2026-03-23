'use strict';

const { execSync } = require('child_process');
const os = require('os');
const fs = require('fs');

/**
 * PlatformDetector — auto-detecta plataforma, ferramentas e fontes de dados
 * disponíveis localmente no boot de cada nó Tulipa.
 *
 * Resultado é usado para popular NODE_CAPABILITIES automaticamente
 * e anunciar via ANNOUNCE para a rede.
 */

// ─── Detecção de plataforma ──────────────────────────────────────────

function isTermux() {
  return !!(process.env.TERMUX_VERSION || fs.existsSync('/data/data/com.termux'));
}

function detectPlatform() {
  if (process.platform === 'win32') return 'windows';
  if (process.platform === 'darwin') return 'macos';
  if (isTermux()) return 'android';
  return 'linux';
}

// ─── Verificação segura de comandos ──────────────────────────────────

function commandExists(cmd) {
  try {
    const check = process.platform === 'win32'
      ? `where ${cmd} 2>nul`
      : `command -v ${cmd} 2>/dev/null`;
    execSync(check, { stdio: 'pipe', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

function commandOutput(cmd) {
  try {
    return execSync(cmd, { stdio: 'pipe', timeout: 5000 }).toString().trim();
  } catch {
    return null;
  }
}

// ─── Detecção de ferramentas por plataforma ──────────────────────────

/** Tools que existem só em plataformas específicas */
const PLATFORM_TOOLS = {
  windows: [
    { cmd: 'powershell', capability: 'powershell' },
    { cmd: 'cmd',        capability: 'cmd' },
    { cmd: 'wsl',        capability: 'wsl' },
    { cmd: 'schtasks',   capability: 'task-scheduler' },
  ],
  linux: [
    { cmd: 'bash',       capability: 'bash' },
    { cmd: 'systemctl',  capability: 'systemd' },
    { cmd: 'crontab',    capability: 'cron' },
    { cmd: 'iptables',   capability: 'iptables' },
    { cmd: 'apt',        capability: 'apt' },
    { cmd: 'yum',        capability: 'yum' },
    { cmd: 'dnf',        capability: 'dnf' },
  ],
  android: [
    { cmd: 'termux-battery-status',  capability: 'termux-api' },
    { cmd: 'termux-location',        capability: 'gps-location' },
    { cmd: 'termux-camera-photo',    capability: 'camera' },
    { cmd: 'termux-sms-send',        capability: 'sms' },
    { cmd: 'termux-notification',    capability: 'termux-notification' },
    { cmd: 'termux-wifi-connectioninfo', capability: 'wifi-info' },
    { cmd: 'termux-sensor',          capability: 'sensors' },
    { cmd: 'bash',                   capability: 'bash' },
  ],
  macos: [
    { cmd: 'bash',       capability: 'bash' },
    { cmd: 'brew',       capability: 'brew' },
    { cmd: 'launchctl',  capability: 'launchctl' },
    { cmd: 'osascript',  capability: 'osascript' },
  ],
};

/** Tools cross-platform (detectadas em qualquer OS) */
const CROSS_PLATFORM_TOOLS = [
  { cmd: 'docker',       capability: 'docker' },
  { cmd: 'git',          capability: 'git' },
  { cmd: 'node',         capability: 'code-execution' },
  { cmd: 'python3',      capability: 'python', alt: 'python' },
  { cmd: 'ffmpeg',       capability: 'media-processing' },
  { cmd: 'cloudflared',  capability: 'tunnel' },
  { cmd: 'ssh',          capability: 'ssh' },
  { cmd: 'rsync',        capability: 'rsync' },
  { cmd: 'curl',         capability: 'http-client' },
  { cmd: 'nginx',        capability: 'web-server' },
  { cmd: 'pm2',          capability: 'process-manager' },
];

function detectTools(platform) {
  const tools = [];

  // Tools específicas da plataforma
  const platformTools = PLATFORM_TOOLS[platform] || [];
  for (const { cmd, capability } of platformTools) {
    if (commandExists(cmd)) {
      tools.push(capability);
    }
  }

  // Tools cross-platform
  for (const { cmd, capability, alt } of CROSS_PLATFORM_TOOLS) {
    if (commandExists(cmd) || (alt && commandExists(alt))) {
      tools.push(capability);
    }
  }

  return [...new Set(tools)];
}

// ─── Detecção de hardware ────────────────────────────────────────────

function detectHardware() {
  const cpus = os.cpus();
  const hw = {
    cores: cpus.length,
    arch: os.arch(),
    memoryGB: Math.round(os.totalmem() / 1024 / 1024 / 1024),
    gpu: false,
    gpuName: null,
  };

  // Detecta GPU NVIDIA
  const nvidiaSmi = commandOutput('nvidia-smi --query-gpu=name --format=csv,noheader');
  if (nvidiaSmi) {
    hw.gpu = true;
    hw.gpuName = nvidiaSmi.split('\n')[0].trim();
  }

  return hw;
}

// ─── Detecção de data sources ────────────────────────────────────────

/**
 * Data sources são fontes de dados que o nó pode fornecer.
 * Diferente de tools (que executam ações), data sources fornecem informação.
 */
const PLATFORM_DATA_SOURCES = {
  windows: [
    { name: 'event-log',     type: 'historical', scope: null },
    { name: 'wmi-metrics',   type: 'realtime',   scope: null },
  ],
  linux: [
    { name: 'proc-metrics',  type: 'realtime',   scope: null },
    { name: 'journal-log',   type: 'historical',  scope: null },
    { name: 'syslog',        type: 'historical',  scope: null },
  ],
  android: [
    { name: 'gps-location',  type: 'realtime',   scope: 'personal' },
    { name: 'battery',       type: 'realtime',   scope: null },
    { name: 'device-sensors', type: 'realtime',  scope: 'personal' },
    { name: 'wifi-info',     type: 'realtime',   scope: null },
  ],
  macos: [
    { name: 'system-profiler', type: 'realtime', scope: null },
  ],
};

/** Data sources detectadas dinamicamente */
const DYNAMIC_DATA_SOURCES = [
  { check: () => commandExists('nvidia-smi'), source: { name: 'gpu-metrics', type: 'realtime', scope: null } },
  { check: () => commandExists('docker'),     source: { name: 'container-metrics', type: 'realtime', scope: null } },
];

function detectDataSources(platform) {
  const sources = [...(PLATFORM_DATA_SOURCES[platform] || [])];

  for (const { check, source } of DYNAMIC_DATA_SOURCES) {
    try {
      if (check()) sources.push(source);
    } catch { /* ignora erros de detecção */ }
  }

  return sources;
}

// ─── API principal ───────────────────────────────────────────────────

/**
 * Detecta tudo sobre a plataforma local.
 * Chamado uma vez no boot do server.js.
 *
 * @returns {{
 *   platform: string,
 *   tools: string[],
 *   dataSources: Array<{name: string, type: string, scope: string|null}>,
 *   hardware: object,
 *   detectedAt: string
 * }}
 */
function detect() {
  const platform = detectPlatform();
  const tools = detectTools(platform);
  const dataSources = detectDataSources(platform);
  const hardware = detectHardware();

  // GPU adiciona capability extra
  if (hardware.gpu) {
    tools.push('gpu-compute');
  }

  const result = {
    platform,
    tools: [...new Set(tools)],
    dataSources,
    hardware,
    detectedAt: new Date().toISOString(),
  };

  console.log(`[platform] Detectado: ${platform} | ${result.tools.length} tools | ${dataSources.length} data sources | ${hardware.cores} cores, ${hardware.memoryGB}GB RAM${hardware.gpu ? `, GPU: ${hardware.gpuName}` : ''}`);

  return result;
}

module.exports = {
  detect,
  detectPlatform,
  detectTools,
  detectHardware,
  detectDataSources,
  commandExists,
  isTermux,
  PLATFORM_TOOLS,
  CROSS_PLATFORM_TOOLS,
  PLATFORM_DATA_SOURCES,
};
