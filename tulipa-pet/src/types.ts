/**
 * Shared types for Tulipa Pet sensor system
 */

export type AgentType = 'android' | 'server' | 'desktop' | 'unknown';

export interface SensorLocation {
  lat: number;
  lon: number;
}

export interface SensorData {
  battery?: number;
  temperature?: number;
  cpuUsage?: number;
  memoryUsage?: number;
  diskUsage?: number;
  wifiSignal?: number;
  location?: SensorLocation;
  uptimeHours?: number;
  hourOfDay?: number;
  hasSensors?: string[];

  // Server-specific
  gpuTemperature?: number;
  gpuUsage?: number;
  gpuMemoryUsage?: number;
  cpuTemperature?: number;
  zombieProcesses?: number;
  loadAverage?: number;
  errorRate?: number;
  runningContainers?: number;
  activeConnections?: number;
  failedLogins?: number;

  // Tulipa network
  tulipa_online?: boolean;
  peersOnline?: number;
  activeTokens?: number;
  tasksCompleted?: number;
  tunnelUp?: boolean;
  lastInteraction?: number;

  // Economy counters (from /api/metrics/sensors)
  mcpCalls?: number;
  mcpErrors?: number;
  messagesRouted?: number;
  messagesFailed?: number;
  httpRequests?: number;
  tasksFailed?: number;

  // Peaks / watermarks
  peakCpuPercent?: number;
  peakMemoryRss?: number;
  peakGpuPercent?: number;

  // Process-level
  processRss?: number;
  processHeapUsed?: number;

  // Terminal (tmux)
  terminalAvailable?: boolean;
  terminalPanes?: number;
  terminalActivePanes?: number;
  terminalCommands?: string[];
  terminalMoodBoost?: number;
  terminalEnergyDrain?: number;
}

export interface McpContent {
  type?: string;
  text: string;
}

export interface McpResult {
  content?: McpContent[];
}

export interface McpResponse {
  jsonrpc: string;
  id: number;
  result?: McpResult;
  error?: { code: number; message: string };
}

export interface TulipaPeer {
  online: boolean;
  [key: string]: unknown;
}

export interface TulipaToken {
  active: boolean;
  [key: string]: unknown;
}

export interface TulipaTask {
  status: string;
  [key: string]: unknown;
}

export interface TulipaStatus {
  cloudflared?: string;
  tunnel?: string;
  [key: string]: unknown;
}

export interface TulipaHealthResponse {
  status?: string;
  [key: string]: unknown;
}

export interface WhatsAppMessage {
  timestamp?: string;
  date?: string;
  [key: string]: unknown;
}

export interface TermuxBatteryStatus {
  percentage?: number;
  temperature?: number;
  [key: string]: unknown;
}

export interface TermuxWifiInfo {
  rssi?: number;
  [key: string]: unknown;
}

export interface TermuxLocation {
  latitude?: number;
  longitude?: number;
  [key: string]: unknown;
}

export interface TermuxSensorList {
  sensors?: Array<{ name: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
