// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

interface Receipt {
  id: string;
  from: string;
  to: string;
  skill: string;
  resourceUsed?: {
    durationMs?: number;
  };
}

interface Balance {
  credits: number;
  earned: number;
  spent: number;
  bootstrap: number;
  byPeer: Record<string, number>;
}

interface Ledger {
  getBalance(): Balance;
  getSummary(): unknown;
  getReceipts(): Receipt[];
}

interface TrustManager {
  getDirectTrust(peerId: string): number | null;
}

interface PeerRecord {
  nodeId: string;
  name: string;
  status: string;
  metadata?: {
    publicKey?: string;
  };
}

interface Registry {
  get(peerId: string): PeerRecord | undefined;
  list(): PeerRecord[];
}

interface ReceiptLib {
  verifyReceipt(rcpt: Receipt, keys: { fromPublicKey?: string; toPublicKey?: string }): ReceiptVerification;
}

interface ReceiptVerification {
  valid: boolean;
  dualSigned: boolean;
  errors: string[];
}

interface DashboardDeps {
  ledger: Ledger;
  trust?: TrustManager;
  registry?: Registry;
  nodeId: string;
}

interface VerifyDeps {
  registry?: Registry;
  receiptLib: ReceiptLib;
}

interface ContributorEntry {
  peerId: string;
  name: string;
  tasksExecuted: number;
  creditsEarned: number;
  trust: number | null;
}

interface ConsumerEntry {
  peerId: string;
  name: string;
  tasksRequested: number;
  creditsSpent: number;
  trust: number | null;
}

interface SkillEntry {
  skill: string;
  count: number;
  earned: number;
  spent: number;
  avgDurationMs: number;
}

interface PeerEntry {
  nodeId: string;
  name: string;
  status: string;
  trust: number | null;
  balance: number;
  receipts: number;
}

interface Dashboard {
  nodeId: string;
  timestamp: string;
  economy: {
    credits: number;
    earned: number;
    spent: number;
    bootstrap: number;
    netBalance: number;
  };
  activity: {
    totalReceipts: number;
    topContributors: ContributorEntry[];
    topConsumers: ConsumerEntry[];
    topSkills: SkillEntry[];
  };
  network: {
    totalPeers: number;
    onlinePeers: number;
    peers: PeerEntry[];
  };
}

interface VerificationResult {
  receiptId: string;
  valid: boolean;
  dualSigned: boolean;
  dispute: boolean;
  details: {
    errors: string[];
    fromKeyFound: boolean;
    toKeyFound: boolean;
    fromPeer: { nodeId: string; name: string } | null;
    toPeer: { nodeId: string; name: string } | null;
  };
  recommendation: string;
}

interface ContributorAccum {
  earned: number;
  count: number;
}

interface ConsumerAccum {
  spent: number;
  count: number;
}

interface SkillAccum {
  count: number;
  earned: number;
  spent: number;
  avgDurationMs: number;
  totalDurationMs: number;
}

export function generateDashboard(deps: DashboardDeps): Dashboard {
  const { ledger, trust, registry, nodeId } = deps;
  const balance = ledger.getBalance();
  const _summary = ledger.getSummary();
  const receipts = ledger.getReceipts();

  const contributors: Record<string, ContributorAccum> = {};
  for (const r of receipts) {
    if (r.from === nodeId) {
      if (!contributors[r.to]) contributors[r.to] = { earned: 0, count: 0 };
      contributors[r.to].earned += 1;
      contributors[r.to].count += 1;
    }
  }

  const topContributors: ContributorEntry[] = Object.entries(contributors)
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

  const consumers: Record<string, ConsumerAccum> = {};
  for (const r of receipts) {
    if (r.to === nodeId) {
      if (!consumers[r.from]) consumers[r.from] = { spent: 0, count: 0 };
      consumers[r.from].spent += 1;
      consumers[r.from].count += 1;
    }
  }

  const topConsumers: ConsumerEntry[] = Object.entries(consumers)
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

  const skillStats: Record<string, SkillAccum> = {};
  for (const r of receipts) {
    if (!skillStats[r.skill]) skillStats[r.skill] = { count: 0, earned: 0, spent: 0, avgDurationMs: 0, totalDurationMs: 0 };
    skillStats[r.skill].count += 1;
    skillStats[r.skill].totalDurationMs += r.resourceUsed?.durationMs || 0;
    if (r.to === nodeId) skillStats[r.skill].earned += 1;
    if (r.from === nodeId) skillStats[r.skill].spent += 1;
  }

  const topSkills: SkillEntry[] = Object.entries(skillStats)
    .map(([skill, data]) => ({
      skill,
      count: data.count,
      earned: data.earned,
      spent: data.spent,
      avgDurationMs: data.count > 0 ? Math.round(data.totalDurationMs / data.count) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  const peers: PeerEntry[] = (registry?.list() || []).map(p => ({
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

export function verifyAsThirdParty(rcpt: Receipt, deps: VerifyDeps): VerificationResult {
  const { registry, receiptLib } = deps;
  const fromPeer = registry?.get(rcpt.from);
  const toPeer = registry?.get(rcpt.to);
  const fromKey = fromPeer?.metadata?.publicKey;
  const toKey = toPeer?.metadata?.publicKey;
  const verification = receiptLib.verifyReceipt(rcpt, { fromPublicKey: fromKey, toPublicKey: toKey });
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
