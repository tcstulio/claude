'use strict';

const { EventEmitter } = require('events');
const crypto = require('crypto');

/**
 * HubCouncil — camada de consenso para promoção/demoção de hubs.
 *
 * Funciona assim:
 *   1. Alguém (LLM advisor, admin, ou auto-failover) cria uma Proposal
 *   2. Proposal é broadcast para todos os hubs ativos
 *   3. Cada hub vota (approve/reject) com uma razão
 *   4. Quando quorum é atingido, a proposta é executada
 *   5. Se timeout (30s), proposta expira
 *
 * O council não tem líder fixo — qualquer hub pode propor.
 * É um consenso simples por maioria, não Raft/Paxos completo.
 */

const PROPOSAL_STATES = ['open', 'approved', 'rejected', 'expired', 'executed'];

class HubCouncil extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.hubRegistry — HubRegistry instance
   * @param {object} options.hubRole — HubRole instance (deste nó)
   * @param {string} options.nodeId — ID deste nó
   * @param {number} [options.quorumRatio=0.51] — ratio para quorum
   * @param {number} [options.proposalTtl=30000] — timeout de proposta (ms)
   * @param {number} [options.minHubs=1] — mínimo de hubs na rede
   * @param {number} [options.maxHubs=10] — máximo de hubs
   */
  constructor(options = {}) {
    super();
    this._hubRegistry = options.hubRegistry;
    this._hubRole = options.hubRole;
    this._nodeId = options.nodeId;
    this._quorumRatio = options.quorumRatio || 0.51;
    this._proposalTtl = options.proposalTtl || 30000;
    this._minHubs = options.minHubs || 1;
    this._maxHubs = options.maxHubs || 10;

    this._proposals = new Map(); // proposalId → Proposal
    this._history = [];          // últimas N decisões
    this._maxHistory = 50;
    this._cleanupTimer = null;
  }

  // ─── Proposals ──────────────────────────────────────────────────────

  /**
   * Cria uma nova proposta de promoção ou demoção.
   * @param {'promote'|'demote'} type
   * @param {string} targetNodeId — nó alvo
   * @param {string} reason — justificativa
   * @param {object} [meta] — metadata adicional (ex: LLM confidence)
   * @returns {object} proposal criada
   */
  propose(type, targetNodeId, reason, meta = {}) {
    // Validações
    if (type === 'promote') {
      const activeHubs = this._hubRegistry.getActive();
      if (activeHubs.length >= this._maxHubs) {
        throw new Error(`Máximo de hubs (${this._maxHubs}) atingido`);
      }
      if (activeHubs.find(h => h.nodeId === targetNodeId)) {
        throw new Error(`${targetNodeId} já é hub ativo`);
      }
    }

    if (type === 'demote') {
      const activeHubs = this._hubRegistry.getActive();
      if (activeHubs.length <= this._minHubs) {
        throw new Error(`Mínimo de hubs (${this._minHubs}) — não pode demover`);
      }
      if (!activeHubs.find(h => h.nodeId === targetNodeId)) {
        throw new Error(`${targetNodeId} não é hub ativo`);
      }
    }

    const proposal = {
      id: `prop_${crypto.randomBytes(8).toString('hex')}`,
      type,
      targetNodeId,
      proposedBy: this._nodeId,
      reason,
      epoch: this._hubRegistry._epoch,
      votes: new Map(),
      status: 'open',
      createdAt: Date.now(),
      decidedAt: null,
      meta,
    };

    // Auto-voto: quem propõe, aprova
    proposal.votes.set(this._nodeId, {
      vote: 'approve',
      reason: 'proposer',
      timestamp: Date.now(),
    });

    this._proposals.set(proposal.id, proposal);

    // Verifica quorum imediatamente (caso single hub)
    this._checkQuorum(proposal.id);

    this.emit('proposal-created', proposal);
    return this._serializeProposal(proposal);
  }

  /**
   * Registra voto em uma proposta.
   * @param {string} proposalId
   * @param {string} voterId — quem está votando
   * @param {'approve'|'reject'} vote
   * @param {string} [reason]
   * @returns {object} resultado do voto
   */
  vote(proposalId, voterId, vote, reason) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposta ${proposalId} não encontrada`);
    if (proposal.status !== 'open') throw new Error(`Proposta já ${proposal.status}`);

    // Só hubs ativos podem votar
    const activeHubs = this._hubRegistry.getActive();
    if (!activeHubs.find(h => h.nodeId === voterId)) {
      throw new Error(`${voterId} não é hub ativo — sem direito a voto`);
    }

    proposal.votes.set(voterId, {
      vote,
      reason: reason || '',
      timestamp: Date.now(),
    });

    this.emit('vote-cast', { proposalId, voterId, vote, reason });

    // Verifica quorum após cada voto
    return this._checkQuorum(proposalId);
  }

  /**
   * Recebe proposta de outro hub (via HUB_ELECTION message).
   */
  receiveProposal(proposal) {
    // Se já conhecemos essa proposta, é um voto
    if (this._proposals.has(proposal.id)) {
      // Merge votos
      const local = this._proposals.get(proposal.id);
      for (const [voterId, voteData] of Object.entries(proposal.votes || {})) {
        if (!local.votes.has(voterId)) {
          local.votes.set(voterId, voteData);
        }
      }
      return this._checkQuorum(proposal.id);
    }

    // Nova proposta — registra
    const newProposal = {
      ...proposal,
      votes: new Map(Object.entries(proposal.votes || {})),
      status: 'open',
    };
    this._proposals.set(proposal.id, newProposal);

    // Auto-voto deste hub (se for hub ativo)
    if (this._hubRole.isHub) {
      const decision = this._evaluateProposal(newProposal);
      newProposal.votes.set(this._nodeId, {
        vote: decision.vote,
        reason: decision.reason,
        timestamp: Date.now(),
      });
    }

    this.emit('proposal-received', newProposal);
    return this._checkQuorum(proposal.id);
  }

  // ─── Decision Logic ─────────────────────────────────────────────────

  /**
   * Avalia uma proposta automaticamente (para auto-voto).
   * Retorna { vote: 'approve'|'reject', reason }.
   */
  _evaluateProposal(proposal) {
    if (proposal.type === 'promote') {
      // Aprova promoção se: rede precisa de mais hubs OU confidence alto
      const activeHubs = this._hubRegistry.getActive();
      if (activeHubs.length < this._minHubs + 1) {
        return { vote: 'approve', reason: 'rede precisa de mais hubs' };
      }
      if (proposal.meta?.confidence > 0.7) {
        return { vote: 'approve', reason: `alta confiança: ${proposal.meta.confidence}` };
      }
      return { vote: 'approve', reason: 'default approve' };
    }

    if (proposal.type === 'demote') {
      const activeHubs = this._hubRegistry.getActive();
      if (activeHubs.length <= this._minHubs) {
        return { vote: 'reject', reason: 'rede ficaria sem hubs suficientes' };
      }
      // Se o hub está morto, aprova demoção
      const target = this._hubRegistry.get(proposal.targetNodeId);
      if (target?.state === 'dead' || target?.state === 'suspect') {
        return { vote: 'approve', reason: `hub está ${target.state}` };
      }
      return { vote: 'approve', reason: 'default approve' };
    }

    return { vote: 'reject', reason: 'tipo desconhecido' };
  }

  /**
   * Verifica se quorum foi atingido e executa se aprovado.
   */
  _checkQuorum(proposalId) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal || proposal.status !== 'open') return null;

    // Check timeout
    if (Date.now() - proposal.createdAt > this._proposalTtl) {
      proposal.status = 'expired';
      proposal.decidedAt = Date.now();
      this._archiveProposal(proposal);
      this.emit('proposal-expired', proposal);
      return { status: 'expired', proposalId };
    }

    const activeHubs = this._hubRegistry.getActive();
    const quorumNeeded = Math.max(1, Math.ceil(activeHubs.length * this._quorumRatio));

    let approves = 0;
    let rejects = 0;
    for (const [, v] of proposal.votes) {
      if (v.vote === 'approve') approves++;
      else if (v.vote === 'reject') rejects++;
    }

    const result = {
      proposalId,
      approves,
      rejects,
      quorumNeeded,
      totalVoters: activeHubs.length,
    };

    if (approves >= quorumNeeded) {
      proposal.status = 'approved';
      proposal.decidedAt = Date.now();
      result.status = 'approved';
      this._archiveProposal(proposal);
      this.emit('proposal-approved', this._serializeProposal(proposal));
      return result;
    }

    if (rejects >= quorumNeeded) {
      proposal.status = 'rejected';
      proposal.decidedAt = Date.now();
      result.status = 'rejected';
      this._archiveProposal(proposal);
      this.emit('proposal-rejected', this._serializeProposal(proposal));
      return result;
    }

    result.status = 'pending';
    return result;
  }

  /**
   * Avalia se a rede precisa de ajustes (chamado periodicamente).
   * Retorna recomendações.
   */
  evaluateNetwork() {
    const activeHubs = this._hubRegistry.getActive();
    const allHubs = this._hubRegistry.list();
    const recommendations = [];

    // Hubs mortos — propor demoção
    for (const hub of allHubs) {
      if (hub.state === 'dead') {
        recommendations.push({
          action: 'demote',
          targetNodeId: hub.nodeId,
          reason: `Hub ${hub.name} não responde (dead)`,
          auto: true,
        });
      }
    }

    // Poucos hubs — precisa promover
    if (activeHubs.length < this._minHubs) {
      recommendations.push({
        action: 'need-promotion',
        reason: `Rede tem ${activeHubs.length} hubs ativos, mínimo é ${this._minHubs}`,
      });
    }

    // Muitos hubs — talvez demover
    if (activeHubs.length > this._maxHubs) {
      // Pega hub com pior métricas
      const sorted = [...activeHubs].sort((a, b) =>
        (a.metrics?.loadAvg || 0) - (b.metrics?.loadAvg || 0)
      );
      const worst = sorted[sorted.length - 1];
      if (worst) {
        recommendations.push({
          action: 'demote',
          targetNodeId: worst.nodeId,
          reason: `Excesso de hubs (${activeHubs.length}/${this._maxHubs}), ${worst.name} tem maior carga`,
        });
      }
    }

    return {
      activeHubs: activeHubs.length,
      totalHubs: allHubs.length,
      minHubs: this._minHubs,
      maxHubs: this._maxHubs,
      recommendations,
    };
  }

  // ─── Helpers ────────────────────────────────────────────────────────

  _archiveProposal(proposal) {
    this._history.push(this._serializeProposal(proposal));
    if (this._history.length > this._maxHistory) {
      this._history.shift();
    }
    // Remove da lista ativa após 1 min
    setTimeout(() => this._proposals.delete(proposal.id), 60000);
  }

  _serializeProposal(proposal) {
    const votes = {};
    for (const [k, v] of proposal.votes) {
      votes[k] = v;
    }
    return { ...proposal, votes };
  }

  /** Limpa propostas expiradas */
  cleanup() {
    const now = Date.now();
    for (const [id, proposal] of this._proposals) {
      if (proposal.status === 'open' && now - proposal.createdAt > this._proposalTtl) {
        proposal.status = 'expired';
        proposal.decidedAt = now;
        this._archiveProposal(proposal);
        this.emit('proposal-expired', proposal);
      }
    }
  }

  /** Inicia cleanup periódico */
  startCleanup(interval) {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this.cleanup(), interval || 15000);
  }

  stopCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // ─── Serialização ───────────────────────────────────────────────────

  toJSON() {
    const pending = [];
    for (const p of this._proposals.values()) {
      if (p.status === 'open') pending.push(this._serializeProposal(p));
    }

    return {
      pendingProposals: pending,
      history: this._history.slice(-10), // últimas 10 decisões
      config: {
        quorumRatio: this._quorumRatio,
        proposalTtl: this._proposalTtl,
        minHubs: this._minHubs,
        maxHubs: this._maxHubs,
      },
    };
  }
}

module.exports = { HubCouncil, PROPOSAL_STATES };
