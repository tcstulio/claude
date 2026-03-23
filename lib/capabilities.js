'use strict';

/**
 * Capabilities — catálogo tipado de capacidades de um nó Tulipa.
 *
 * Cada capability tem:
 *   - name: identificador único (ex: "whatsapp", "proxmox-vm")
 *   - category: "infra" (público, sem auth) ou "private" (requer scope)
 *   - dataScope: qual scope é necessário para acessar (null = público)
 *   - description: descrição curta
 *   - metadata: dados extras (versão, limites, etc.)
 *
 * Separação:
 *   - infra: serviços computacionais que o nó oferece (visível para qualquer peer)
 *   - private: dados sensíveis, conhecimento proprietário (requer permissão)
 */

/** @type {Record<string, 'infra' | 'private'>} */
const KNOWN_CAPABILITIES = {
  // ─── Infra (público) ──────────────────────────────────────
  'chat':                'infra',
  'code-execution':      'infra',
  'web-search':          'infra',
  'file-storage':        'infra',
  'compute':             'infra',
  'monitoring':          'infra',
  'deploy':              'infra',
  'proxmox-vm':          'infra',
  'proxmox-lxc':         'infra',
  'docker':              'infra',
  'ssh':                 'infra',
  'dns':                 'infra',
  'backup':              'infra',
  'relay':               'infra',
  'hub':                 'infra',

  // ─── Platform tools (infra — detectadas automaticamente) ───
  'powershell':          'infra',
  'cmd':                 'infra',
  'wsl':                 'infra',
  'task-scheduler':      'infra',
  'bash':                'infra',
  'systemd':             'infra',
  'cron':                'infra',
  'iptables':            'infra',
  'apt':                 'infra',
  'yum':                 'infra',
  'dnf':                 'infra',
  'termux-api':          'infra',
  'termux-notification': 'infra',
  'brew':                'infra',
  'launchctl':           'infra',
  'osascript':           'infra',
  'git':                 'infra',
  'python':              'infra',
  'media-processing':    'infra',
  'tunnel':              'infra',
  'rsync':               'infra',
  'http-client':         'infra',
  'web-server':          'infra',
  'process-manager':     'infra',
  'gpu-compute':         'infra',

  // ─── Platform data sources (infra — métricas públicas) ─────
  'battery':             'infra',
  'wifi-info':           'infra',
  'event-log':           'infra',
  'gpu-metrics':         'infra',
  'proc-metrics':        'infra',
  'container-metrics':   'infra',
  'journal-log':         'infra',
  'syslog':              'infra',
  'wmi-metrics':         'infra',
  'system-profiler':     'infra',

  // ─── Private (requer scope) ────────────────────────────────
  'whatsapp':            'private',
  'telegram':            'private',
  'email':               'private',
  'calendar':            'private',
  'contacts':            'private',
  'documents':           'private',
  'credentials':         'private',
  'financial':           'private',
  'health-data':         'private',
  'location':            'private',

  // ─── Platform data sources (private — dados pessoais) ──────
  'gps-location':        'private',
  'sensors':             'private',
  'device-sensors':      'private',
  'camera':              'private',
  'sms':                 'private',
};

/** Scopes de acesso para capabilities private */
const DATA_SCOPES = {
  'messaging':    ['whatsapp', 'telegram', 'email', 'sms'],
  'personal':     ['calendar', 'contacts', 'location', 'health-data', 'gps-location', 'sensors', 'device-sensors', 'camera'],
  'documents':    ['documents'],
  'credentials':  ['credentials'],
  'financial':    ['financial'],
};

/**
 * Classifica uma capability.
 * @param {string} name
 * @returns {'infra' | 'private'} — default 'private' para desconhecidas (seguro)
 */
function classify(name) {
  return KNOWN_CAPABILITIES[name] || 'private';
}

/**
 * Retorna o scope necessário para acessar uma capability private.
 * @param {string} name
 * @returns {string|null} — nome do scope ou null se é infra
 */
function requiredScope(name) {
  if (classify(name) === 'infra') return null;
  for (const [scope, caps] of Object.entries(DATA_SCOPES)) {
    if (caps.includes(name)) return scope;
  }
  return 'restricted'; // default scope para capabilities private sem scope definido
}

/**
 * Filtra capabilities por categoria.
 * @param {string[]} capabilities
 * @param {'infra' | 'private'} category
 * @returns {string[]}
 */
function filterByCategory(capabilities, category) {
  return capabilities.filter(c => classify(c) === category);
}

/**
 * Enriquece capabilities com metadata de classificação.
 * @param {string[]} capabilities
 * @returns {Array<{name: string, category: string, scope: string|null}>}
 */
function enrich(capabilities) {
  return capabilities.map(name => ({
    name,
    category: classify(name),
    scope: requiredScope(name),
  }));
}

/**
 * Verifica se um set de scopes autorizados permite acessar uma capability.
 * @param {string} capabilityName
 * @param {string[]} grantedScopes — scopes autorizados para o peer
 * @returns {boolean}
 */
function hasAccess(capabilityName, grantedScopes = []) {
  const category = classify(capabilityName);
  if (category === 'infra') return true; // infra é sempre público

  const scope = requiredScope(capabilityName);
  if (!scope) return true;

  return grantedScopes.includes(scope) || grantedScopes.includes('*');
}

/**
 * Filtra capabilities para mostrar apenas as que o peer tem permissão.
 * @param {string[]} capabilities — todas as capabilities do nó
 * @param {string[]} grantedScopes — scopes autorizados para quem está pedindo
 * @returns {string[]}
 */
function accessibleCapabilities(capabilities, grantedScopes = []) {
  return capabilities.filter(c => hasAccess(c, grantedScopes));
}

module.exports = {
  KNOWN_CAPABILITIES,
  DATA_SCOPES,
  classify,
  requiredScope,
  filterByCategory,
  enrich,
  hasAccess,
  accessibleCapabilities,
};
