// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

/**
 * Scope Guard — framework-agnostic scope/capability verification.
 *
 * Provides functions to check whether a request has the required scope
 * or capability to access a given resource.
 */

/** Known capabilities and their categories. */
const KNOWN_CAPABILITIES: Record<string, 'infra' | 'private'> = {
  chat:             'infra',
  'code-execution': 'infra',
  'web-search':     'infra',
  'file-storage':   'infra',
  compute:          'infra',
  monitoring:       'infra',
  deploy:           'infra',
  'proxmox-vm':     'infra',
  'proxmox-lxc':    'infra',
  docker:           'infra',
  ssh:              'infra',
  relay:            'infra',
  backup:           'infra',
  whatsapp:         'private',
  messaging:        'private',
  personal:         'private',
  knowledge:        'private',
};

/**
 * Returns the required scope for a capability, or null if it is public (infra).
 */
function requiredScope(capabilityName: string): string | null {
  const category = KNOWN_CAPABILITIES[capabilityName];
  if (!category || category === 'infra') return null;
  return capabilityName;
}

interface RequestLike {
  grantedScopes?: string[];
  peer?: PeerRecord | null;
  federatedAuth?: Record<string, unknown>;
  body?: Record<string, unknown>;
}

interface PeerRecord {
  nodeId: string;
  name?: string;
  metadata?: Record<string, unknown>;
}

interface MeshInterface {
  registry: {
    list(): PeerRecord[];
  };
}

interface ScopeCheckResult {
  allowed: boolean;
  error?: string;
  required?: string;
  granted?: string[];
  hint?: string;
}

/**
 * Checks whether a request has the required scope.
 */
export function checkScope(scope: string, grantedScopes: string[]): ScopeCheckResult {
  if (grantedScopes.includes('*')) return { allowed: true };
  if (grantedScopes.includes(scope)) return { allowed: true };

  return {
    allowed: false,
    error: 'Scope insuficiente',
    required: scope,
    granted: grantedScopes,
    hint: `Este endpoint requer scope "${scope}". Adicione ao token ou peça ao owner.`,
  };
}

/**
 * Checks whether a request has access to a specific capability.
 * Resolves the required scope automatically.
 */
export function checkCapability(
  capabilityName: string,
  grantedScopes: string[],
): ScopeCheckResult {
  const scope = requiredScope(capabilityName);

  // Infra capabilities are always accessible
  if (!scope) return { allowed: true };

  return checkScope(scope, grantedScopes);
}

/**
 * Factory: creates a middleware that requires a specific scope.
 */
export function requireScope(scope: string) {
  return (
    req: RequestLike & Record<string, unknown>,
    res: { status(code: number): { json(body: unknown): void } },
    next: () => void,
  ): void => {
    const granted = (req.grantedScopes as string[]) || [];

    if (granted.includes('*')) return next();

    if (!granted.includes(scope)) {
      res.status(403).json({
        error: 'Scope insuficiente',
        required: scope,
        granted,
        hint: `Este endpoint requer scope "${scope}". Adicione ao token ou peça ao owner.`,
      });
      return;
    }
    next();
  };
}

/**
 * Factory: creates a middleware that requires access to a capability.
 */
export function requireCapability(capabilityName: string) {
  const scope = requiredScope(capabilityName);

  if (!scope) {
    return (
      _req: RequestLike & Record<string, unknown>,
      _res: { status(code: number): { json(body: unknown): void } },
      next: () => void,
    ): void => {
      next();
    };
  }

  return requireScope(scope);
}

interface ResolveScopesOptions {
  resolveToken?: (req: RequestLike & Record<string, unknown>) => string;
  masterToken?: string;
  mesh?: MeshInterface;
}

/**
 * Factory: creates a middleware that populates req.grantedScopes from the token.
 */
export function resolveScopes(options: ResolveScopesOptions = {}) {
  const { resolveToken, masterToken, mesh } = options;

  return (
    req: RequestLike & Record<string, unknown>,
    _res: unknown,
    next: () => void,
  ): void => {
    const token = resolveToken ? resolveToken(req) : '';

    if (masterToken && token === masterToken) {
      req.grantedScopes = ['*'];
    } else if (token && mesh) {
      const peers = mesh.registry.list();
      const peer = peers.find(
        (p) =>
          p.metadata?.token === token || p.metadata?.remoteToken === token,
      );
      req.grantedScopes = (peer?.metadata?.scopes as string[]) || [];
      req.peer = peer || null;
    } else {
      req.grantedScopes = [];
    }

    next();
  };
}
