'use strict';

/**
 * Dashboard — visão consolidada da economia do nó Tulipa.
 *
 * Agrega dados do Ledger, TrustGraph e Registry para gerar:
 *   - Saldo e créditos
 *   - Top contribuidores (quem mais executou para nós)
 *   - Top consumidores (quem mais pediu de nós)
 *   - Skills mais usadas
 *   - Ranking de peers por economia + trust
 */

/**
 * Gera o dashboard completo.
 *
 * @param {object} deps
 * @param {object} deps.ledger — Ledger instance
 * @param {object} deps.trust — TrustGraph instance
 * @param {object} deps.registry — PeerRegistry instance
 * @param {string} deps.nodeId — nosso agent ID
 * @returns {object} dashboard data
 */
function generateDashboard(deps) {
  const { ledger, trust, registry, nodeId } = deps;

  const balance = ledger.getBalance();
  const summary = ledger.getSummary();
  const receipts = ledger.getReceipts();

  // ─── Top Contribuidores (quem executou tasks para nós) ──────────────
  const contributors = {};  // { peerId: { earned, count, name } }
  for (const r of receipts) {
    if (r.from === nodeId) {
      // Nós pedimos, eles executaram
      if (!contributors[r.to]) contributors[r.to] = { earned: 0, count: 0 };
      contributors[r.to].earned += 1;
      contributors[r.to].count += 1;
    }
  }

  const topContributors = Object.entries(contributors)
    .map(([peerId, data]) => {
      const peer = registry?.get(peerId);
      return {
        peerId,
        name: peer?.name || peerId,
        tasksExecuted: data.count,
        creditsEarned: data.earned,
        trust: trust?.getDirectTrust(peerId) ?? null,
      };
    })
    .sort((a, b) => b.creditsEarned - a.creditsEarned)
    .slice(0, 10);

  // ─── Top Consumidores (quem pediu tasks de nós) ─────────────────────
  const consumers = {};
  for (const r of receipts) {
    if (r.to === nodeId) {
      // Eles pediram, nós executamos
      if (!consumers[r.from]) consumers[r.from] = { spent: 0, count: 0 };
      consumers[r.from].spent += 1;
      consumers[r.from].count += 1;
    }
  }

  const topConsumers = Object.entries(consumers)
    .map(([peerId, data]) => {
      const peer = registry?.get(peerId);
      return {
        peerId,
        name: peer?.name || peerId,
        tasksRequested: data.count,
        creditsSpent: data.spent,
        trust: trust?.getDirectTrust(peerId) ?? null,
      };
    })
    .sort((a, b) => b.creditsSpent - a.creditsSpent)
    .slice(0, 10);

  // ─── Skills mais usadas ─────────────────────────────────────────────
  const skillStats = {};
  for (const r of receipts) {
    if (!skillStats[r.skill]) skillStats[r.skill] = { count: 0, earned: 0, spent: 0, avgDurationMs: 0, totalDurationMs: 0 };
    skillStats[r.skill].count += 1;
    skillStats[r.skill].totalDurationMs += r.resourceUsed?.durationMs || 0;
    if (r.to === nodeId) skillStats[r.skill].earned += 1;
    if (r.from === nodeId) skillStats[r.skill].spent += 1;
  }

  const topSkills = Object.entries(skillStats)
    .map(([skill, data]) => ({
      skill,
      count: data.count,
      earned: data.earned,
      spent: data.spent,
      avgDurationMs: data.count > 0 ? Math.round(data.totalDurationMs / data.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // ─── Resumo de peers com ranking econômico ──────────────────────────
  const peers = (registry?.list() || []).map(p => ({
    nodeId: p.nodeId,
    name: p.name,
    status: p.status,
    trust: trust?.getDirectTrust(p.nodeId) ?? null,
    balance: balance.byPeer[p.nodeId] || 0,
    receipts: receipts.filter(r => r.from === p.nodeId || r.to === p.nodeId).length,
  })).sort((a, b) => (b.trust || 0) - (a.trust || 0));

  return {
    nodeId,
    timestamp: new Date().toISOString(),
    economy: {
      credits: balance.credits,
      earned: balance.earned,
      spent: balance.spent,
      bootstrap: balance.bootstrap,
      netBalance: balance.earned - balance.spent,
    },
    activity: {
      totalReceipts: receipts.length,
      topContributors,
      topConsumers,
      topSkills,
    },
    network: {
      totalPeers: peers.length,
      onlinePeers: peers.filter(p => p.status === 'online').length,
      peers,
    },
  };
}

/**
 * Verifica um receipt como terceiro (disputa).
 * Um nó neutro pode verificar que ambas assinaturas são válidas
 * e que o hash bate com os campos.
 *
 * @param {object} receipt — TaskReceipt a verificar
 * @param {object} deps
 * @param {object} deps.registry — PeerRegistry (para buscar public keys)
 * @param {object} deps.receiptLib — módulo de receipt
 * @returns {object} { valid, dispute, details }
 */
function verifyAsThirdParty(rcpt, deps) {
  const { registry, receiptLib } = deps;

  // Buscar public keys dos envolvidos
  const fromPeer = registry?.get(rcpt.from);
  const toPeer = registry?.get(rcpt.to);

  const fromKey = fromPeer?.metadata?.publicKey;
  const toKey = toPeer?.metadata?.publicKey;

  const verification = receiptLib.verifyReceipt(rcpt, {
    fromPublicKey: fromKey,
    toPublicKey: toKey,
  });

  // Determinar se há disputa
  const hasDispute = !verification.valid || !verification.dualSigned;

  return {
    receiptId: rcpt.id,
    valid: verification.valid,
    dualSigned: verification.dualSigned,
    dispute: hasDispute,
    details: {
      errors: verification.errors,
      fromKeyFound: !!fromKey,
      toKeyFound: !!toKey,
      fromPeer: fromPeer ? { nodeId: rcpt.from, name: fromPeer.name } : null,
      toPeer: toPeer ? { nodeId: rcpt.to, name: toPeer.name } : null,
    },
    recommendation: hasDispute
      ? 'Receipt incompleto ou inválido — não deve ser contabilizado'
      : 'Receipt válido com dupla assinatura — pode ser contabilizado',
  };
}

module.exports = { generateDashboard, verifyAsThirdParty };
