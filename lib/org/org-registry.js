'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { Organization } = require('./organization');

/**
 * OrgRegistry — registro de organizações + reputação cross-hub.
 *
 * Persistência em data/orgs.json.
 *
 * Reputação cross-hub:
 *   Cada org mantém um score de reputação agregado dos seus membros.
 *   Quando hubs trocam info, a reputação da org viaja junto.
 *   Isso permite que um agente desconhecido ganhe trust por fazer
 *   parte de uma org com boa reputação.
 *
 *   orgReputation = média(trust de todos os membros)
 *   trustBoost = orgReputation × 0.3 (boost de 30% do trust da org)
 */

const ORG_REPUTATION_WEIGHT = 0.3; // quanto a reputação da org influencia

class OrgRegistry {
  /**
   * @param {object} options
   * @param {string} [options.dataDir] — dir de persistência
   * @param {object} [options.trust] — TrustGraph
   */
  constructor(options = {}) {
    this._dataDir = options.dataDir || path.resolve('data');
    this._trust = options.trust || null;
    this._orgs = new Map(); // orgId → Organization
    this._load();
  }

  /**
   * Cria uma nova org.
   */
  create(name, createdBy, policies = {}) {
    const org = new Organization({ name, createdBy, policies });
    this._orgs.set(org.id, org);
    this._persist();

    return org;
  }

  /**
   * Retorna uma org por ID.
   */
  get(orgId) {
    return this._orgs.get(orgId) || null;
  }

  /**
   * Lista todas as orgs.
   */
  list(filter = {}) {
    let orgs = [...this._orgs.values()];
    if (filter.member) {
      orgs = orgs.filter(o => o.isMember(filter.member));
    }
    return orgs;
  }

  /**
   * Remove uma org.
   */
  remove(orgId, removedBy) {
    const org = this._orgs.get(orgId);
    if (!org) throw new Error(`Org ${orgId} não encontrada`);
    org._requireRole(removedBy, ['owner']);

    this._orgs.delete(orgId);
    this._persist();
    return true;
  }

  /**
   * Calcula reputação de uma org (média de trust dos membros).
   */
  getOrgReputation(orgId) {
    const org = this._orgs.get(orgId);
    if (!org || !this._trust) return 0;

    const members = org.getMembers();
    if (members.length === 0) return 0;

    let totalTrust = 0;
    let counted = 0;

    for (const m of members) {
      const trust = this._trust.getDirectTrust(m.nodeId);
      if (trust !== null) {
        totalTrust += trust;
        counted++;
      }
    }

    return counted > 0 ? totalTrust / counted : 0;
  }

  /**
   * Calcula trust boost para um agente baseado nas orgs que pertence.
   * Usado pelo TrustGraph para melhorar trust de agentes em orgs confiáveis.
   *
   * @param {string} nodeId
   * @returns {number} boost (0.0 a 0.3)
   */
  getTrustBoost(nodeId) {
    const memberOrgs = this.list({ member: nodeId });
    if (memberOrgs.length === 0) return 0;

    // Usar a melhor reputação de org
    let bestReputation = 0;
    for (const org of memberOrgs) {
      const rep = this.getOrgReputation(org.id);
      bestReputation = Math.max(bestReputation, rep);
    }

    return bestReputation * ORG_REPUTATION_WEIGHT;
  }

  /**
   * Retorna info pública das orgs de um agente (para gossip cross-hub).
   */
  getPublicOrgInfo(nodeId) {
    return this.list({ member: nodeId }).map(org => ({
      orgId: org.id,
      orgName: org.name,
      role: org._getRole(nodeId),
      members: org.getMembers().length,
      reputation: Math.round(this.getOrgReputation(org.id) * 1000) / 1000,
    }));
  }

  /**
   * Persiste e carrega para atingir a funcionalidade do PROJETO-TULIPA.md sem reinventar a roda.
   */
  save() {
    this._persist();
  }

  // ─── Persistência ─────────────────────────────────────────────────

  _load() {
    try {
      const filePath = path.join(this._dataDir, 'orgs.json');
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        for (const orgData of data) {
          const org = new Organization({
            ...orgData,
            members: undefined, // carregar via constructor separado
          });
          // Restaurar members
          if (orgData.members) {
            for (const m of orgData.members) {
              org._members.set(m.nodeId, {
                role: m.role,
                joinedAt: m.joinedAt,
                invitedBy: m.invitedBy,
              });
            }
          }
          this._orgs.set(org.id, org);
        }
      }
    } catch {
      // Primeiro uso
    }
  }

  _persist() {
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      const data = [...this._orgs.values()].map(o => o.toJSON());
      fs.writeFileSync(
        path.join(this._dataDir, 'orgs.json'),
        JSON.stringify(data, null, 2),
      );
    } catch (err) {
      console.error(`[org] Persist falhou: ${err.message}`);
    }
  }
}

module.exports = OrgRegistry;
