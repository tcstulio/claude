// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

/**
 * Token Federation — federated auth via hub introspection.
 *
 * When a node receives an unrecognized token, it asks known hubs
 * (via /api/network/introspect) whether the token is valid.
 */

interface RequestLike {
  grantedScopes?: string[];
  federatedAuth?: {
    hubId: string;
    hubName?: string;
    tokenName?: string;
    cached: boolean;
  };
  body?: Record<string, unknown>;
  peer?: unknown;
}

interface ResponseLike {
  status(code: number): { json(body: unknown): void };
  json(body: unknown): void;
}

interface PeerRecord {
  nodeId: string;
  name?: string;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

interface MeshInterface {
  registry: {
    list(): PeerRecord[];
  };
  getHubEndpoints?(): Array<{ endpoint: string; nodeId: string; name: string }>;
}

interface HubEntry {
  endpoint: string;
  nodeId: string;
  name: string;
}

interface IntrospectionResult {
  valid: boolean;
  scopes?: string[];
  name?: string;
  nodeId?: string;
  tokenId?: string;
}

interface CacheEntry {
  scopes: string[];
  hubId: string | null;
  expiresAt: number;
}

interface TokenEntry {
  hash: string;
  name?: string;
  id?: string;
  scopes?: string[];
  revoked?: boolean;
  [key: string]: unknown;
}

// Cache de introspecção: token -> { scopes, expiresAt, hubId }
const _introspectionCache = new Map<string, CacheEntry>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_NEGATIVE_TTL = 60 * 1000; // 1 min for rejections
const MAX_CACHE_SIZE = 500;

function _cleanCache(): void {
  const now = Date.now();
  for (const [key, entry] of _introspectionCache) {
    if (now > entry.expiresAt) _introspectionCache.delete(key);
  }
}

interface TokenFederationOptions {
  getRequestToken?: (req: RequestLike & Record<string, unknown>) => string;
  masterToken?: string;
  mesh?: MeshInterface;
  fetch?: typeof globalThis.fetch;
  hubEndpoints?: string[];
}

/**
 * Middleware that attempts to federate unrecognized tokens via hub.
 *
 * Should be used AFTER resolveScopes.
 * If resolveScopes already found scopes, this middleware does nothing.
 */
export function tokenFederation(options: TokenFederationOptions = {}) {
  const { getRequestToken, masterToken, mesh } = options;
  const _fetch = options.fetch || globalThis.fetch;

  return async (
    req: RequestLike & Record<string, unknown>,
    _res: unknown,
    next: () => void,
  ): Promise<void> => {
    // If scopes already resolved (master, local peer), proceed
    if (req.grantedScopes && req.grantedScopes.length > 0) return next();

    const token = getRequestToken ? getRequestToken(req) : '';
    if (!token || token === masterToken) return next();

    // Check cache
    const cached = _introspectionCache.get(token);
    if (cached && Date.now() < cached.expiresAt) {
      if (cached.scopes && cached.scopes.length > 0) {
        req.grantedScopes = cached.scopes;
        req.federatedAuth = { hubId: cached.hubId!, cached: true };
      }
      return next();
    }

    // Discover known hubs
    const hubs = _getHubEndpoints(mesh, options.hubEndpoints);
    if (hubs.length === 0) return next();

    // Ask each hub if the token is valid
    for (const hub of hubs) {
      try {
        const result = await _introspect(hub, token, _fetch);
        if (result && result.valid && result.scopes && result.scopes.length > 0) {
          req.grantedScopes = result.scopes;
          req.federatedAuth = {
            hubId: hub.nodeId,
            hubName: hub.name,
            tokenName: result.name,
            cached: false,
          };

          _cacheResult(token, result.scopes, hub.nodeId, CACHE_TTL);
          return next();
        }
      } catch {
        // Hub unavailable, try next
        continue;
      }
    }

    // No hub recognized — cache negative result
    _cacheResult(token, [], null, CACHE_NEGATIVE_TTL);
    return next();
  };
}

async function _introspect(
  hub: HubEntry,
  token: string,
  fetchFn: typeof globalThis.fetch,
): Promise<IntrospectionResult | null> {
  const url = `${hub.endpoint}/api/network/introspect`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;
  return (await res.json()) as IntrospectionResult;
}

function _getHubEndpoints(
  mesh: MeshInterface | undefined,
  staticEndpoints: string[] | undefined,
): HubEntry[] {
  const hubs: HubEntry[] = [];
  const seen = new Set<string>();

  // 1. Hub Registry (dynamic, primary source with Hub Council)
  if (mesh?.getHubEndpoints) {
    for (const h of mesh.getHubEndpoints()) {
      if (h.endpoint && !seen.has(h.endpoint)) {
        hubs.push(h);
        seen.add(h.endpoint);
      }
    }
  }

  // 2. Dynamic hubs (peers with endpoint and endorsed — fallback)
  if (mesh?.registry) {
    const peers = mesh.registry.list();
    for (const p of peers) {
      const ep = p.metadata?.endpoint as string | undefined;
      if (ep && p.metadata?.endorsed && !seen.has(ep)) {
        hubs.push({ endpoint: ep, nodeId: p.nodeId, name: p.name || '' });
        seen.add(ep);
      }
    }
  }

  // 3. Static hubs (configured via env — last resort)
  if (staticEndpoints) {
    for (const ep of staticEndpoints) {
      if (!seen.has(ep)) {
        hubs.push({ endpoint: ep, nodeId: 'static', name: 'static-hub' });
        seen.add(ep);
      }
    }
  }

  return hubs;
}

function _cacheResult(
  token: string,
  scopes: string[],
  hubId: string | null,
  ttl: number,
): void {
  if (_introspectionCache.size > MAX_CACHE_SIZE) _cleanCache();
  _introspectionCache.set(token, {
    scopes,
    hubId,
    expiresAt: Date.now() + ttl,
  });
}

interface IntrospectHandlerOptions {
  masterToken?: string;
  mesh?: MeshInterface;
}

/**
 * Endpoint handler: /api/network/introspect
 *
 * Receives { token } and returns { valid, scopes, name } if the token is known.
 */
export function introspectHandler(options: IntrospectHandlerOptions = {}) {
  const { masterToken, mesh } = options;

  let _tokensData: { tokens: TokenEntry[] } | null = null;
  let _tokensLoadedAt = 0;
  const TOKENS_RELOAD_INTERVAL = 30000; // 30s

  function _loadTokens(): { tokens: TokenEntry[] } | null {
    const now = Date.now();
    if (_tokensData && now - _tokensLoadedAt < TOKENS_RELOAD_INTERVAL) {
      return _tokensData;
    }

    try {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const tokensPath = path.join(home, '.tulipa', 'api-tokens.yaml');
      if (fs.existsSync(tokensPath)) {
        _tokensData = _parseTokensYaml(fs.readFileSync(tokensPath, 'utf8'));
        _tokensLoadedAt = now;
      }
    } catch {
      _tokensData = null;
    }
    return _tokensData;
  }

  function _parseTokensYaml(content: string): { tokens: TokenEntry[] } {
    const tokens: TokenEntry[] = [];
    const blocks = content.split(/\n\s+-\s+/).slice(1);

    for (const block of blocks) {
      const entry: Record<string, unknown> = {};
      const lines = block.split('\n');
      let inScopes = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (inScopes && trimmed.startsWith('- ')) {
          if (!entry.scopes) entry.scopes = [];
          (entry.scopes as string[]).push(trimmed.slice(2).trim());
          continue;
        }
        inScopes = false;

        const kv = trimmed.match(/^(\w+):\s*(.*)$/);
        if (!kv) continue;
        const [, key, val] = kv;

        if (key === 'scopes') {
          inScopes = true;
          entry.scopes = [];
        } else if (key === 'revoked') {
          entry.revoked = val.trim() === 'true';
        } else {
          entry[key] = val.trim().replace(/^['"]|['"]$/g, '');
        }
      }
      if (entry.hash) tokens.push(entry as unknown as TokenEntry);
    }
    return { tokens };
  }

  return (
    req: RequestLike & Record<string, unknown>,
    res: ResponseLike,
  ): void => {
    const { token } = (req.body as { token?: string }) || {};
    if (!token) {
      res.status(400).json({ valid: false, error: 'Token required' });
      return;
    }

    // 1. Check master token
    if (masterToken && token === masterToken) {
      res.json({
        valid: true,
        scopes: ['*'],
        name: 'master',
      });
      return;
    }

    // 2. Check peer tokens (mesh registry)
    if (mesh?.registry) {
      const peers = mesh.registry.list();
      const peer = peers.find(
        (p) =>
          p.metadata?.token === token || p.metadata?.remoteToken === token,
      );
      if (peer) {
        res.json({
          valid: true,
          scopes: (peer.metadata?.scopes as string[]) || ['read'],
          name: `peer:${peer.name}`,
          nodeId: peer.nodeId,
        });
        return;
      }
    }

    // 3. Check api-tokens.yaml (owner tokens)
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokensData = _loadTokens();

    if (tokensData?.tokens) {
      const found = tokensData.tokens.find(
        (t) => t.hash === tokenHash && !t.revoked,
      );
      if (found) {
        res.json({
          valid: true,
          scopes: found.scopes || ['read'],
          name: found.name,
          tokenId: found.id,
        });
        return;
      }
    }

    // Not found
    res.json({ valid: false });
  };
}

/**
 * Clears the introspection cache (for testing).
 */
export function clearCache(): void {
  _introspectionCache.clear();
}

export { _introspectionCache };
