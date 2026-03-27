'use strict';

/**
 * Token Federation — autenticação federada via hub.
 *
 * Quando um nó recebe um token que não conhece localmente,
 * pergunta ao hub (via /api/network/introspect) se o token é válido.
 *
 * Isso permite que um agente (ex: Claude Code) use o token do hub
 * para acessar qualquer peer da rede, sem precisar de um token separado
 * para cada nó.
 *
 * Fluxo:
 *   1. Request chega com Bearer token
 *   2. resolveScopes tenta resolver localmente (master ou peer)
 *   3. Se não encontrou → tokenFederation pergunta ao hub
 *   4. Hub responde com scopes → peer cacheia resultado
 *   5. Request segue com scopes federados
 */

// Cache de introspecção: token → { scopes, expiresAt, hubId }
const _introspectionCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const CACHE_NEGATIVE_TTL = 60 * 1000; // 1 min para rejeições (evita spam)
const MAX_CACHE_SIZE = 500;

/**
 * Limpa entradas expiradas do cache.
 */
function _cleanCache() {
  const now = Date.now();
  for (const [key, entry] of _introspectionCache) {
    if (now > entry.expiresAt) _introspectionCache.delete(key);
  }
}

/**
 * Middleware que tenta federar tokens não reconhecidos via hub.
 *
 * Deve ser usado DEPOIS de resolveScopes.
 * Se resolveScopes já encontrou scopes, este middleware não faz nada.
 *
 * @param {object} options
 * @param {function} options.getRequestToken — extrai token do req
 * @param {string} options.masterToken — token master local
 * @param {object} options.mesh — MeshManager
 * @param {function} options.fetch — fetch function
 * @param {string[]} [options.hubEndpoints] — endpoints dos hubs conhecidos
 */
function tokenFederation(options = {}) {
  const { getRequestToken, masterToken, mesh, fetch: fetchFn } = options;
  const _fetch = fetchFn || globalThis.fetch;

  return async (req, _res, next) => {
    // Se já tem scopes resolvidos (master, peer local), segue em frente
    if (req.grantedScopes && req.grantedScopes.length > 0) return next();

    const token = getRequestToken ? getRequestToken(req) : '';
    if (!token || token === masterToken) return next();

    // Verifica cache
    const cached = _introspectionCache.get(token);
    if (cached && Date.now() < cached.expiresAt) {
      if (cached.scopes && cached.scopes.length > 0) {
        req.grantedScopes = cached.scopes;
        req.federatedAuth = { hubId: cached.hubId, cached: true };
      }
      return next();
    }

    // Descobre hubs conhecidos (peers com endpoints)
    const hubs = _getHubEndpoints(mesh, options.hubEndpoints);
    if (hubs.length === 0) return next();

    // Pergunta a cada hub se o token é válido
    for (const hub of hubs) {
      try {
        const result = await _introspect(hub, token, _fetch);
        if (result && result.valid && result.scopes?.length > 0) {
          // Token reconhecido pelo hub!
          req.grantedScopes = result.scopes;
          req.federatedAuth = {
            hubId: hub.nodeId,
            hubName: hub.name,
            tokenName: result.name,
            cached: false,
          };

          // Cacheia resultado positivo
          _cacheResult(token, result.scopes, hub.nodeId, CACHE_TTL);
          return next();
        }
      } catch (err) {
        // Hub indisponível, tenta próximo
        continue;
      }
    }

    // Nenhum hub reconheceu — cacheia negativo (evita flood)
    _cacheResult(token, [], null, CACHE_NEGATIVE_TTL);
    return next();
  };
}

/**
 * Faz introspecção de um token no hub.
 */
async function _introspect(hub, token, fetchFn) {
  const url = `${hub.endpoint}/api/network/introspect`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) return null;
  return res.json();
}

/**
 * Retorna endpoints de hubs conhecidos.
 * Prioridade: Hub Registry > peers endorsed > estáticos.
 */
function _getHubEndpoints(mesh, staticEndpoints) {
  const hubs = [];
  const seen = new Set();

  // 1. Hub Registry dinâmico (fonte principal com Hub Council)
  if (mesh?.getHubEndpoints) {
    for (const h of mesh.getHubEndpoints()) {
      if (h.endpoint && !seen.has(h.endpoint)) {
        hubs.push(h);
        seen.add(h.endpoint);
      }
    }
  }

  // 2. Hubs dinâmicos (peers com endpoint e endorsed — fallback)
  if (mesh?.registry) {
    const peers = mesh.registry.list();
    for (const p of peers) {
      const ep = p.metadata?.endpoint;
      if (ep && p.metadata?.endorsed && !seen.has(ep)) {
        hubs.push({ endpoint: ep, nodeId: p.nodeId, name: p.name });
        seen.add(ep);
      }
    }
  }

  // 3. Hubs estáticos (configurados via env — último recurso)
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

/**
 * Cacheia resultado de introspecção.
 */
function _cacheResult(token, scopes, hubId, ttl) {
  if (_introspectionCache.size > MAX_CACHE_SIZE) _cleanCache();
  _introspectionCache.set(token, {
    scopes,
    hubId,
    expiresAt: Date.now() + ttl,
  });
}

/**
 * Endpoint handler: /api/network/introspect
 *
 * Recebe { token } e retorna { valid, scopes, name } se o token é conhecido.
 * Este endpoint NÃO requer auth (qualquer peer pode perguntar).
 * Mas só retorna scopes — nunca expõe o token em si.
 */
function introspectHandler(options = {}) {
  const { masterToken, mesh } = options;

  // Carrega api-tokens.yaml para resolver tokens do owner
  let _tokensData = null;
  let _tokensLoadedAt = 0;
  const TOKENS_RELOAD_INTERVAL = 30000; // 30s

  function _loadTokens() {
    const now = Date.now();
    if (_tokensData && now - _tokensLoadedAt < TOKENS_RELOAD_INTERVAL) return _tokensData;

    try {
      const fs = require('fs');
      const path = require('path');
      const home = process.env.HOME || process.env.USERPROFILE || '';
      const tokensPath = path.join(home, '.tulipa', 'api-tokens.yaml');
      if (fs.existsSync(tokensPath)) {
        // Parse simples do YAML de tokens (sem dependência externa)
        _tokensData = _parseTokensYaml(fs.readFileSync(tokensPath, 'utf8'));
        _tokensLoadedAt = now;
      }
    } catch {
      _tokensData = null;
    }
    return _tokensData;
  }

  /**
   * Parser mínimo para o formato api-tokens.yaml.
   * Extrai hash, name, scopes e revoked de cada token entry.
   */
  function _parseTokensYaml(content) {
    const tokens = [];
    // Divide em blocos por "  - " (início de cada token)
    const blocks = content.split(/\n\s+-\s+/).slice(1); // skip "tokens:"

    for (const block of blocks) {
      const entry = {};
      const lines = block.split('\n');
      let inScopes = false;

      for (const line of lines) {
        const trimmed = line.trim();

        if (inScopes && trimmed.startsWith('- ')) {
          if (!entry.scopes) entry.scopes = [];
          entry.scopes.push(trimmed.slice(2).trim());
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
      if (entry.hash) tokens.push(entry);
    }
    return { tokens };
  }

  return (req, res) => {
    const { token } = req.body || {};
    if (!token) {
      return res.status(400).json({ valid: false, error: 'Token required' });
    }

    // 1. Check master token
    if (masterToken && token === masterToken) {
      return res.json({
        valid: true,
        scopes: ['*'],
        name: 'master',
      });
    }

    // 2. Check peer tokens (mesh registry)
    if (mesh?.registry) {
      const peers = mesh.registry.list();
      const peer = peers.find(p =>
        p.metadata?.token === token || p.metadata?.remoteToken === token
      );
      if (peer) {
        return res.json({
          valid: true,
          scopes: peer.metadata?.scopes || ['read'],
          name: `peer:${peer.name}`,
          nodeId: peer.nodeId,
        });
      }
    }

    // 3. Check api-tokens.yaml (tokens do owner)
    const crypto = require('crypto');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const tokensData = _loadTokens();

    if (tokensData?.tokens) {
      const found = tokensData.tokens.find(t => t.hash === tokenHash && !t.revoked);
      if (found) {
        return res.json({
          valid: true,
          scopes: found.scopes || ['read'],
          name: found.name,
          tokenId: found.id,
        });
      }
    }

    // Não encontrado
    return res.json({ valid: false });
  };
}

/**
 * Limpa o cache (para testes).
 */
function clearCache() {
  _introspectionCache.clear();
}

module.exports = {
  tokenFederation,
  introspectHandler,
  clearCache,
  // Exporta para testes
  _introspectionCache,
};
