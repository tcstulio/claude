'use strict';

const capabilities = require('../capabilities');

/**
 * Scope Guard — middleware Express que verifica se o requester
 * tem permissão para acessar uma capability/scope.
 *
 * Uso:
 *   app.get('/api/whatsapp/history', requireScope('messaging'), handler)
 *
 * O middleware espera que `req.grantedScopes` já esteja populado
 * (por um middleware de auth anterior que resolve os scopes do token).
 *
 * Se grantedScopes não existir, assume [] (sem permissão para private).
 */

/**
 * Factory: cria middleware que requer um scope específico.
 * @param {string} scope — scope necessário (ex: 'messaging', 'personal')
 * @returns {function} Express middleware
 */
function requireScope(scope) {
  return (req, res, next) => {
    const granted = req.grantedScopes || [];

    // Wildcard = acesso total
    if (granted.includes('*')) return next();

    if (!granted.includes(scope)) {
      return res.status(403).json({
        error: 'Scope insuficiente',
        required: scope,
        granted,
        hint: `Este endpoint requer scope "${scope}". Adicione ao token ou peça ao owner.`,
      });
    }
    next();
  };
}

/**
 * Factory: cria middleware que requer acesso a uma capability específica.
 * Resolve automaticamente o scope necessário.
 * @param {string} capabilityName
 * @returns {function} Express middleware
 */
function requireCapability(capabilityName) {
  const scope = capabilities.requiredScope(capabilityName);

  // Infra = sempre acessível
  if (!scope) {
    return (_req, _res, next) => next();
  }

  return requireScope(scope);
}

/**
 * Middleware que popula req.grantedScopes a partir do token.
 *
 * Para a v0.4.0, usa uma lógica simples:
 *   - Se o token é o master token (API_TOKEN) → scope '*' (tudo)
 *   - Se é um peer token → scopes definidos no peering
 *   - Sem token → [] (só infra)
 *
 * @param {object} options
 * @param {function} options.resolveToken — função que extrai o token do req
 * @param {string} options.masterToken — token master (API_TOKEN)
 * @param {object} [options.mesh] — MeshManager (para resolver scopes de peers)
 */
function resolveScopes(options = {}) {
  const { resolveToken, masterToken, mesh } = options;

  return (req, _res, next) => {
    const token = resolveToken ? resolveToken(req) : '';

    if (masterToken && token === masterToken) {
      // Master token = acesso total
      req.grantedScopes = ['*'];
    } else if (token && mesh) {
      // Tenta resolver scopes do peer pelo token
      const peers = mesh.registry.list();
      const peer = peers.find(p =>
        p.metadata?.token === token || p.metadata?.remoteToken === token
      );
      req.grantedScopes = peer?.metadata?.scopes || [];
      req.peer = peer || null;
    } else {
      req.grantedScopes = [];
    }

    next();
  };
}

module.exports = {
  requireScope,
  requireCapability,
  resolveScopes,
};
