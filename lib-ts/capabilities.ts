// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// Capabilities — typed catalog of Tulipa node capabilities.

export type CapabilityCategory = "infra" | "private";

export interface EnrichedCapability {
  name: string;
  category: CapabilityCategory;
  scope: string | null;
}

export const KNOWN_CAPABILITIES: Record<string, CapabilityCategory> = {
  // ─── Infra (público) ──────────────────────────────────────
  "chat":                "infra",
  "code-execution":      "infra",
  "web-search":          "infra",
  "file-storage":        "infra",
  "compute":             "infra",
  "monitoring":          "infra",
  "deploy":              "infra",
  "proxmox-vm":          "infra",
  "proxmox-lxc":         "infra",
  "docker":              "infra",
  "ssh":                 "infra",
  "dns":                 "infra",
  "backup":              "infra",
  "relay":               "infra",
  "hub":                 "infra",

  // ─── Platform tools (infra — auto-detected) ───────────────
  "powershell":          "infra",
  "cmd":                 "infra",
  "wsl":                 "infra",
  "task-scheduler":      "infra",
  "bash":                "infra",
  "systemd":             "infra",
  "cron":                "infra",
  "iptables":            "infra",
  "apt":                 "infra",
  "yum":                 "infra",
  "dnf":                 "infra",
  "termux-api":          "infra",
  "termux-notification": "infra",
  "brew":                "infra",
  "launchctl":           "infra",
  "osascript":           "infra",
  "git":                 "infra",
  "python":              "infra",
  "media-processing":    "infra",
  "tunnel":              "infra",
  "rsync":               "infra",
  "http-client":         "infra",
  "web-server":          "infra",
  "process-manager":     "infra",
  "gpu-compute":         "infra",

  // ─── Platform data sources (infra — public metrics) ───────
  "battery":             "infra",
  "wifi-info":           "infra",
  "event-log":           "infra",
  "gpu-metrics":         "infra",
  "proc-metrics":        "infra",
  "container-metrics":   "infra",
  "journal-log":         "infra",
  "syslog":              "infra",
  "wmi-metrics":         "infra",
  "system-profiler":     "infra",

  // ─── Private (requires scope) ─────────────────────────────
  "whatsapp":            "private",
  "telegram":            "private",
  "email":               "private",
  "calendar":            "private",
  "contacts":            "private",
  "documents":           "private",
  "credentials":         "private",
  "financial":           "private",
  "health-data":         "private",
  "location":            "private",

  // ─── Platform data sources (private — personal data) ──────
  "gps-location":        "private",
  "sensors":             "private",
  "device-sensors":      "private",
  "camera":              "private",
  "sms":                 "private",
};

export const CAPABILITY_DATA_SCOPES: Record<string, string[]> = {
  "messaging":    ["whatsapp", "telegram", "email", "sms"],
  "personal":     ["calendar", "contacts", "location", "health-data", "gps-location", "sensors", "device-sensors", "camera"],
  "documents":    ["documents"],
  "credentials":  ["credentials"],
  "financial":    ["financial"],
};

export function classify(name: string): CapabilityCategory {
  return KNOWN_CAPABILITIES[name] ?? "private";
}

export function requiredScope(name: string): string | null {
  if (classify(name) === "infra") return null;
  for (const [scope, caps] of Object.entries(CAPABILITY_DATA_SCOPES)) {
    if (caps.includes(name)) return scope;
  }
  return "restricted";
}

export function filterByCategory(capabilities: string[], category: CapabilityCategory): string[] {
  return capabilities.filter(c => classify(c) === category);
}

export function enrich(capabilities: string[]): EnrichedCapability[] {
  return capabilities.map(name => ({
    name,
    category: classify(name),
    scope: requiredScope(name),
  }));
}

export function hasAccess(capabilityName: string, grantedScopes: string[] = []): boolean {
  if (classify(capabilityName) === "infra") return true;
  const scope = requiredScope(capabilityName);
  if (!scope) return true;
  return grantedScopes.includes(scope) || grantedScopes.includes("*");
}

export function accessibleCapabilities(capabilities: string[], grantedScopes: string[] = []): string[] {
  return capabilities.filter(c => hasAccess(c, grantedScopes));
}
