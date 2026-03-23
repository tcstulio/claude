'use strict';

const { EventEmitter } = require('events');
const crypto = require('node:crypto');

/**
 * Organization — governança de grupos de agentes na rede Tulipa.
 *
 * Uma org agrupa agentes sob políticas comuns:
 *   - minTrust: trust mínimo para aceitar peers na org
 *   - maxHops: profundidade máxima de delegação
 *   - votingThreshold: % de members necessário para decisões
 *   - allowedScopes: quais data scopes a org pode acessar
 *
 * Roles:
 *   - owner: pode tudo (criar, convidar, expulsar, alterar políticas)
 *   - admin: pode convidar, alterar políticas (não pode expulsar owner)
 *   - member: participa, vota, delega tasks dentro da org
 */

const ROLES = ['owner', 'admin', 'member'];

const DEFAULT_POLICIES = {
  minTrust: 0.3,
  maxHops: 3,
  votingThreshold: 0.51, // maioria simples
  allowedScopes: ['*'],
  maxMembers: 100,
  requireApproval: true, // convites precisam de aprovação
};

class Organization extends EventEmitter {
  /**
   * @param {object} data
   * @param {string} data.id
   * @param {string} data.name
   * @param {string} data.createdBy — nodeId do criador
   * @param {object} [data.policies]
   */
  constructor(data = {}) {
    super();
    this.id = data.id || `org_${crypto.randomBytes(8).toString('hex')}`;
    this.name = data.name || 'Unnamed Organization';
    this.createdBy = data.createdBy;
    this.createdAt = data.createdAt || new Date().toISOString();
    this.policies = { ...DEFAULT_POLICIES, ...(data.policies || {}) };

    // Members: Map<nodeId, { role, joinedAt, invitedBy }>
    this._members = new Map();

    // Pending invites: Map<nodeId, { invitedBy, role, at }>
    this._invites = new Map();

    // Adicionar criador como owner
    if (this.createdBy) {
      this._members.set(this.createdBy, {
        role: 'owner',
        joinedAt: this.createdAt,
        invitedBy: null,
      });
    }

    // Carregar members existentes (para restore)
    if (data.members) {
      for (const [nodeId, info] of Object.entries(data.members)) {
        this._members.set(nodeId, info);
      }
    }
  }

  /**
   * Convida um agente para a org.
   *
   * @param {string} nodeId — agente a convidar
   * @param {string} invitedBy — quem está convidando
   * @param {string} [role] — role do convidado (default: member)
   * @returns {object} { invited, pending }
   */
  invite(nodeId, invitedBy, role = 'member') {
    this._requireRole(invitedBy, ['owner', 'admin']);

    if (this._members.has(nodeId)) {
      throw new Error(`${nodeId} já é membro da org ${this.name}`);
    }
    if (!ROLES.includes(role)) {
      throw new Error(`Role inválido: ${role}. Use: ${ROLES.join(', ')}`);
    }
    if (role === 'owner' && this._getRole(invitedBy) !== 'owner') {
      throw new Error('Apenas owners podem convidar novos owners');
    }
    if (this._members.size >= this.policies.maxMembers) {
      throw new Error(`Org ${this.name} atingiu limite de ${this.policies.maxMembers} members`);
    }

    if (this.policies.requireApproval) {
      this._invites.set(nodeId, {
        invitedBy,
        role,
        at: new Date().toISOString(),
      });
      this.emit('invite-sent', { orgId: this.id, nodeId, role, invitedBy });
      return { invited: true, pending: true };
    }

    // Sem aprovação necessária — adiciona direto
    return this._addMember(nodeId, role, invitedBy);
  }

  /**
   * Aceita um convite pendente.
   */
  acceptInvite(nodeId) {
    const invite = this._invites.get(nodeId);
    if (!invite) throw new Error(`Nenhum convite pendente para ${nodeId}`);

    this._invites.delete(nodeId);
    return this._addMember(nodeId, invite.role, invite.invitedBy);
  }

  /**
   * Recusa um convite pendente.
   */
  declineInvite(nodeId) {
    if (!this._invites.has(nodeId)) throw new Error(`Nenhum convite pendente para ${nodeId}`);
    this._invites.delete(nodeId);
    this.emit('invite-declined', { orgId: this.id, nodeId });
    return true;
  }

  /**
   * Remove um membro.
   */
  removeMember(nodeId, removedBy) {
    this._requireRole(removedBy, ['owner', 'admin']);
    const member = this._members.get(nodeId);
    if (!member) throw new Error(`${nodeId} não é membro`);

    if (member.role === 'owner' && this._getRole(removedBy) !== 'owner') {
      throw new Error('Apenas owners podem remover outros owners');
    }
    if (nodeId === removedBy) {
      throw new Error('Não pode remover a si mesmo — use leave()');
    }

    this._members.delete(nodeId);
    this.emit('member-removed', { orgId: this.id, nodeId, removedBy });
    return true;
  }

  /**
   * Membro sai voluntariamente.
   */
  leave(nodeId) {
    if (!this._members.has(nodeId)) throw new Error(`${nodeId} não é membro`);

    // Último owner não pode sair
    const owners = this.getMembers('owner');
    if (this._getRole(nodeId) === 'owner' && owners.length <= 1) {
      throw new Error('Último owner não pode sair — transfira ownership primeiro');
    }

    this._members.delete(nodeId);
    this.emit('member-left', { orgId: this.id, nodeId });
    return true;
  }

  /**
   * Altera políticas da org.
   */
  updatePolicies(changes, changedBy) {
    this._requireRole(changedBy, ['owner', 'admin']);
    this.policies = { ...this.policies, ...changes };
    this.emit('policies-updated', { orgId: this.id, changes, changedBy });
    return this.policies;
  }

  /**
   * Verifica se um agente pode delegar dentro da org.
   */
  canDelegate(fromNodeId, toNodeId, trust) {
    if (!this._members.has(fromNodeId)) return false;
    if (!this._members.has(toNodeId)) return false;
    return trust >= this.policies.minTrust;
  }

  /**
   * Retorna membros filtrados por role.
   */
  getMembers(role = null) {
    const members = [...this._members.entries()].map(([nodeId, info]) => ({
      nodeId,
      ...info,
    }));
    return role ? members.filter(m => m.role === role) : members;
  }

  /**
   * Retorna convites pendentes.
   */
  getPendingInvites() {
    return [...this._invites.entries()].map(([nodeId, info]) => ({
      nodeId,
      ...info,
    }));
  }

  isMember(nodeId) {
    return this._members.has(nodeId);
  }

  _getRole(nodeId) {
    return this._members.get(nodeId)?.role || null;
  }

  _requireRole(nodeId, roles) {
    const role = this._getRole(nodeId);
    if (!role || !roles.includes(role)) {
      throw new Error(`Permissão negada: ${nodeId} é ${role || 'não-membro'}, requer ${roles.join('/')}`);
    }
  }

  _addMember(nodeId, role, invitedBy) {
    this._members.set(nodeId, {
      role,
      joinedAt: new Date().toISOString(),
      invitedBy,
    });
    this.emit('member-joined', { orgId: this.id, nodeId, role });
    return { invited: true, pending: false, role };
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      createdBy: this.createdBy,
      createdAt: this.createdAt,
      policies: this.policies,
      members: this.getMembers(),
      pendingInvites: this.getPendingInvites(),
      stats: {
        total: this._members.size,
        owners: this.getMembers('owner').length,
        admins: this.getMembers('admin').length,
        members: this.getMembers('member').length,
      },
    };
  }
}

module.exports = { Organization, ROLES, DEFAULT_POLICIES };
