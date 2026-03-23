'use strict';

const { EventEmitter } = require('events');
const fs = require('node:fs');
const path = require('node:path');

const BOOTSTRAP_CREDITS = 100;

/**
 * Ledger — registro local de TaskReceipts e saldo entre agentes.
 *
 * Estrutura em disco:
 *   data/ledger/
 *     receipts.json    — array de TaskReceipts
 *     balance.json     — { "agent_xyz": +50, "agent_abc": -20 }
 *     summary.json     — totais por skill, earned, spent
 */
class Ledger extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.nodeId - nosso agent ID
   * @param {string} [options.dataDir] - diretório de persistência (default: ./data/ledger)
   * @param {number} [options.bootstrapCredits] - créditos iniciais (default: 100)
   */
  constructor(options = {}) {
    super();
    this.nodeId = options.nodeId;
    this._dataDir = options.dataDir || path.resolve('data', 'ledger');
    this._bootstrapCredits = options.bootstrapCredits ?? BOOTSTRAP_CREDITS;

    this._receipts = [];
    this._balance = {};   // { agentId: number } — positivo = eles me devem, negativo = eu devo
    this._summary = {
      totalEarned: 0,
      totalSpent: 0,
      bySkill: {},        // { skill: { earned, spent, count } }
      byPeer: {},         // { agentId: { earned, spent, count, name } }
    };

    this._load();
  }

  /**
   * Adiciona um receipt ao ledger e atualiza saldo.
   *
   * @param {object} receipt - TaskReceipt (deve ter pelo menos fromSignature ou toSignature)
   * @returns {object} { balance, receipt }
   */
  addReceipt(receipt) {
    // Deduplicação por ID
    if (this._receipts.some(r => r.id === receipt.id)) {
      return { duplicate: true, receipt };
    }

    this._receipts.push(receipt);

    // Atualizar saldo
    const isEarner = receipt.to === this.nodeId;   // eu executei = ganhei
    const isSpender = receipt.from === this.nodeId; // eu pedi = gastei
    const credits = this._calculateCredits(receipt);

    if (isEarner) {
      // Eu executei — o peer me deve créditos
      this._balance[receipt.from] = (this._balance[receipt.from] || 0) + credits;
      this._summary.totalEarned += credits;
      this._updateSkillSummary(receipt.skill, 'earned', credits);
      this._updatePeerSummary(receipt.from, 'earned', credits);
    } else if (isSpender) {
      // Eu pedi — eu devo créditos ao peer
      this._balance[receipt.to] = (this._balance[receipt.to] || 0) - credits;
      this._summary.totalSpent += credits;
      this._updateSkillSummary(receipt.skill, 'spent', credits);
      this._updatePeerSummary(receipt.to, 'spent', credits);
    }

    this._persist();
    this.emit('receipt-added', { receipt, credits, earned: isEarner });

    return {
      receipt,
      credits,
      earned: isEarner,
      balance: this.getBalance(),
    };
  }

  /**
   * Calcula créditos de um receipt baseado nos recursos usados.
   * Fórmula simples: 1 crédito base + bonus por duração.
   */
  _calculateCredits(receipt) {
    const base = 1;
    const durationBonus = Math.floor((receipt.resourceUsed?.durationMs || 0) / 10000); // +1 por 10s
    return base + durationBonus;
  }

  _updateSkillSummary(skill, type, credits) {
    if (!this._summary.bySkill[skill]) {
      this._summary.bySkill[skill] = { earned: 0, spent: 0, count: 0 };
    }
    this._summary.bySkill[skill][type] += credits;
    this._summary.bySkill[skill].count++;
  }

  _updatePeerSummary(peerId, type, credits) {
    if (!this._summary.byPeer[peerId]) {
      this._summary.byPeer[peerId] = { earned: 0, spent: 0, count: 0 };
    }
    this._summary.byPeer[peerId][type] += credits;
    this._summary.byPeer[peerId].count++;
  }

  /**
   * Retorna o saldo total (earned - spent + bootstrap).
   */
  getBalance() {
    return {
      credits: this._bootstrapCredits + this._summary.totalEarned - this._summary.totalSpent,
      earned: this._summary.totalEarned,
      spent: this._summary.totalSpent,
      bootstrap: this._bootstrapCredits,
      byPeer: { ...this._balance },
    };
  }

  /**
   * Retorna receipts com filtros opcionais.
   */
  getReceipts(filters = {}) {
    let results = [...this._receipts];

    if (filters.peer) {
      results = results.filter(r => r.from === filters.peer || r.to === filters.peer);
    }
    if (filters.skill) {
      results = results.filter(r => r.skill === filters.skill);
    }
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      results = results.filter(r => new Date(r.timestamp).getTime() >= since);
    }
    if (filters.limit) {
      results = results.slice(-filters.limit);
    }

    return results;
  }

  /**
   * Retorna resumo do ledger.
   */
  getSummary() {
    return {
      nodeId: this.nodeId,
      balance: this.getBalance(),
      receipts: this._receipts.length,
      summary: { ...this._summary },
    };
  }

  /**
   * Retorna o saldo com um peer específico.
   */
  getPeerBalance(peerId) {
    return this._balance[peerId] || 0;
  }

  // --- Persistência ---

  _load() {
    try {
      const receiptsPath = path.join(this._dataDir, 'receipts.json');
      const balancePath = path.join(this._dataDir, 'balance.json');
      const summaryPath = path.join(this._dataDir, 'summary.json');

      if (fs.existsSync(receiptsPath)) {
        this._receipts = JSON.parse(fs.readFileSync(receiptsPath, 'utf8'));
      }
      if (fs.existsSync(balancePath)) {
        this._balance = JSON.parse(fs.readFileSync(balancePath, 'utf8'));
      }
      if (fs.existsSync(summaryPath)) {
        this._summary = { ...this._summary, ...JSON.parse(fs.readFileSync(summaryPath, 'utf8')) };
      }
    } catch {
      // Primeiro uso — começa vazio
    }
  }

  _persist() {
    try {
      if (!fs.existsSync(this._dataDir)) {
        fs.mkdirSync(this._dataDir, { recursive: true });
      }
      fs.writeFileSync(
        path.join(this._dataDir, 'receipts.json'),
        JSON.stringify(this._receipts, null, 2),
      );
      fs.writeFileSync(
        path.join(this._dataDir, 'balance.json'),
        JSON.stringify(this._balance, null, 2),
      );
      fs.writeFileSync(
        path.join(this._dataDir, 'summary.json'),
        JSON.stringify(this._summary, null, 2),
      );
    } catch (err) {
      console.error(`[ledger] Persist falhou: ${err.message}`);
    }
  }
}

module.exports = Ledger;
