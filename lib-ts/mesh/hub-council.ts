// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// HubCouncil — consensus layer for hub promotion/demotion.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import type { HubRegistry } from "./hub-registry.js";
import type { HubRole } from "./hub-role.js";

export type ProposalType = "promote" | "demote";
export type ProposalStatus = "open" | "approved" | "rejected" | "expired" | "executed";
export type VoteValue = "approve" | "reject";

export interface Vote {
  vote: VoteValue;
  reason: string;
  timestamp: number;
}

export interface Proposal {
  id: string;
  type: ProposalType;
  targetNodeId: string;
  proposedBy: string;
  reason: string;
  epoch: number;
  votes: Map<string, Vote>;
  status: ProposalStatus;
  createdAt: number;
  decidedAt: number | null;
  meta: Record<string, unknown>;
}

export interface SerializedProposal extends Omit<Proposal, "votes"> {
  votes: Record<string, Vote>;
}

export const PROPOSAL_STATES: ProposalStatus[] = ["open", "approved", "rejected", "expired", "executed"];

export class HubCouncil extends EventEmitter {
  private _hubRegistry: HubRegistry;
  private _hubRole: HubRole;
  private _nodeId: string;
  private _quorumRatio: number;
  private _proposalTtl: number;
  private _minHubs: number;
  private _maxHubs: number;
  private _proposals = new Map<string, Proposal>();
  private _history: SerializedProposal[] = [];
  private _maxHistory = 50;
  private _cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: {
    hubRegistry: HubRegistry;
    hubRole: HubRole;
    nodeId: string;
    quorumRatio?: number;
    proposalTtl?: number;
    minHubs?: number;
    maxHubs?: number;
  }) {
    super();
    this._hubRegistry = options.hubRegistry;
    this._hubRole = options.hubRole;
    this._nodeId = options.nodeId;
    this._quorumRatio = options.quorumRatio ?? 0.51;
    this._proposalTtl = options.proposalTtl ?? 30000;
    this._minHubs = options.minHubs ?? 1;
    this._maxHubs = options.maxHubs ?? 10;
  }

  propose(type: ProposalType, targetNodeId: string, reason: string, meta: Record<string, unknown> = {}): SerializedProposal {
    if (type === "promote") {
      const active = this._hubRegistry.getActive();
      if (active.length >= this._maxHubs) throw new Error(`Max hubs (${this._maxHubs}) reached`);
      if (active.find(h => h.nodeId === targetNodeId)) throw new Error(`${targetNodeId} is already an active hub`);
    }
    if (type === "demote") {
      const active = this._hubRegistry.getActive();
      if (active.length <= this._minHubs) throw new Error(`Min hubs (${this._minHubs}) — cannot demote`);
      if (!active.find(h => h.nodeId === targetNodeId)) throw new Error(`${targetNodeId} is not an active hub`);
    }

    const proposal: Proposal = {
      id: `prop_${crypto.randomBytes(8).toString("hex")}`,
      type, targetNodeId, proposedBy: this._nodeId, reason,
      epoch: (this._hubRegistry as unknown as { _epoch: number })._epoch,
      votes: new Map(), status: "open", createdAt: Date.now(), decidedAt: null, meta,
    };
    proposal.votes.set(this._nodeId, { vote: "approve", reason: "proposer", timestamp: Date.now() });
    this._proposals.set(proposal.id, proposal);
    this._checkQuorum(proposal.id);
    this.emit("proposal-created", proposal);
    return this._serialize(proposal);
  }

  vote(proposalId: string, voterId: string, vote: VoteValue, reason?: string) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal) throw new Error(`Proposal ${proposalId} not found`);
    if (proposal.status !== "open") throw new Error(`Proposal already ${proposal.status}`);
    if (!this._hubRegistry.getActive().find(h => h.nodeId === voterId)) {
      throw new Error(`${voterId} is not an active hub — no voting rights`);
    }
    proposal.votes.set(voterId, { vote, reason: reason ?? "", timestamp: Date.now() });
    this.emit("vote-cast", { proposalId, voterId, vote, reason });
    return this._checkQuorum(proposalId);
  }

  receiveProposal(incoming: SerializedProposal) {
    if (this._proposals.has(incoming.id)) {
      const local = this._proposals.get(incoming.id)!;
      for (const [voterId, voteData] of Object.entries(incoming.votes ?? {})) {
        if (!local.votes.has(voterId)) local.votes.set(voterId, voteData);
      }
      return this._checkQuorum(incoming.id);
    }
    const newProposal: Proposal = { ...incoming, votes: new Map(Object.entries(incoming.votes ?? {})), status: "open" };
    this._proposals.set(incoming.id, newProposal);
    if (this._hubRole.isHub) {
      const decision = this._evaluate(newProposal);
      newProposal.votes.set(this._nodeId, { vote: decision.vote, reason: decision.reason, timestamp: Date.now() });
    }
    this.emit("proposal-received", newProposal);
    return this._checkQuorum(incoming.id);
  }

  private _evaluate(proposal: Proposal): { vote: VoteValue; reason: string } {
    if (proposal.type === "promote") {
      const active = this._hubRegistry.getActive();
      if (active.length < this._minHubs + 1) return { vote: "approve", reason: "network needs more hubs" };
      if ((proposal.meta?.confidence as number) > 0.7) return { vote: "approve", reason: `high confidence: ${proposal.meta.confidence}` };
      return { vote: "approve", reason: "default approve" };
    }
    if (proposal.type === "demote") {
      if (this._hubRegistry.getActive().length <= this._minHubs) return { vote: "reject", reason: "would leave network without enough hubs" };
      const target = this._hubRegistry.get(proposal.targetNodeId);
      if (target?.state === "dead" || target?.state === "suspect") return { vote: "approve", reason: `hub is ${target.state}` };
      return { vote: "approve", reason: "default approve" };
    }
    return { vote: "reject", reason: "unknown type" };
  }

  private _checkQuorum(proposalId: string) {
    const proposal = this._proposals.get(proposalId);
    if (!proposal || proposal.status !== "open") return null;
    if (Date.now() - proposal.createdAt > this._proposalTtl) {
      proposal.status = "expired"; proposal.decidedAt = Date.now();
      this._archive(proposal); this.emit("proposal-expired", proposal);
      return { status: "expired", proposalId };
    }
    const activeHubs = this._hubRegistry.getActive();
    const quorumNeeded = Math.max(1, Math.ceil(activeHubs.length * this._quorumRatio));
    let approves = 0, rejects = 0;
    for (const v of proposal.votes.values()) { if (v.vote === "approve") approves++; else if (v.vote === "reject") rejects++; }
    const result = { proposalId, approves, rejects, quorumNeeded, totalVoters: activeHubs.length, status: "pending" as string };
    if (approves >= quorumNeeded) {
      proposal.status = "approved"; proposal.decidedAt = Date.now(); result.status = "approved";
      this._archive(proposal); this.emit("proposal-approved", this._serialize(proposal));
    } else if (rejects >= quorumNeeded) {
      proposal.status = "rejected"; proposal.decidedAt = Date.now(); result.status = "rejected";
      this._archive(proposal); this.emit("proposal-rejected", this._serialize(proposal));
    }
    return result;
  }

  evaluateNetwork() {
    const activeHubs = this._hubRegistry.getActive();
    const allHubs = this._hubRegistry.list();
    const recommendations: Array<{ action: string; targetNodeId?: string; reason: string; auto?: boolean }> = [];
    for (const hub of allHubs) {
      if (hub.state === ("dead" as string)) recommendations.push({ action: "demote", targetNodeId: hub.nodeId, reason: `Hub ${hub.name} not responding (dead)`, auto: true });
    }
    if (activeHubs.length < this._minHubs) recommendations.push({ action: "need-promotion", reason: `Network has ${activeHubs.length} active hubs, minimum is ${this._minHubs}` });
    if (activeHubs.length > this._maxHubs) {
      const sorted = [...activeHubs].sort((a, b) => ((a.metrics?.loadAvg as number) ?? 0) - ((b.metrics?.loadAvg as number) ?? 0));
      const worst = sorted[sorted.length - 1];
      if (worst) recommendations.push({ action: "demote", targetNodeId: worst.nodeId, reason: `Excess hubs (${activeHubs.length}/${this._maxHubs}), ${worst.name} has highest load` });
    }
    return { activeHubs: activeHubs.length, totalHubs: allHubs.length, minHubs: this._minHubs, maxHubs: this._maxHubs, recommendations };
  }

  private _archive(proposal: Proposal): void {
    this._history.push(this._serialize(proposal));
    if (this._history.length > this._maxHistory) this._history.shift();
    setTimeout(() => this._proposals.delete(proposal.id), 60000);
  }

  private _serialize(proposal: Proposal): SerializedProposal {
    const votes: Record<string, Vote> = {};
    for (const [k, v] of proposal.votes) votes[k] = v;
    return { ...proposal, votes };
  }

  cleanup(): void {
    const now = Date.now();
    for (const [, proposal] of this._proposals) {
      if (proposal.status === "open" && now - proposal.createdAt > this._proposalTtl) {
        proposal.status = "expired"; proposal.decidedAt = now;
        this._archive(proposal); this.emit("proposal-expired", proposal);
      }
    }
  }

  startCleanup(interval?: number): void {
    if (this._cleanupTimer) return;
    this._cleanupTimer = setInterval(() => this.cleanup(), interval ?? 15000);
  }

  stopCleanup(): void {
    if (this._cleanupTimer) { clearInterval(this._cleanupTimer); this._cleanupTimer = null; }
  }

  toJSON() {
    const pending: SerializedProposal[] = [];
    for (const p of this._proposals.values()) { if (p.status === "open") pending.push(this._serialize(p)); }
    return { pendingProposals: pending, history: this._history.slice(-10), config: { quorumRatio: this._quorumRatio, proposalTtl: this._proposalTtl, minHubs: this._minHubs, maxHubs: this._maxHubs } };
  }
}
