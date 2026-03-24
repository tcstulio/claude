// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// Ledger — local record of TaskReceipts and peer balances.

import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import type { TaskReceipt } from "./receipt.js";

export interface LedgerBalance {
  credits: number;
  earned: number;
  spent: number;
  bootstrap: number;
  byPeer: Record<string, number>;
}

export interface SkillSummary {
  earned: number;
  spent: number;
  count: number;
}

export interface PeerSummary {
  earned: number;
  spent: number;
  count: number;
}

export interface LedgerSummary {
  totalEarned: number;
  totalSpent: number;
  bySkill: Record<string, SkillSummary>;
  byPeer: Record<string, PeerSummary>;
}

export interface ReceiptFilters {
  peer?: string;
  skill?: string;
  since?: string;
  limit?: number;
}

const BOOTSTRAP_CREDITS = 100;

export class Ledger extends EventEmitter {
  readonly nodeId: string;
  private _dataDir: string;
  private _bootstrapCredits: number;
  private _receipts: TaskReceipt[] = [];
  private _balance: Record<string, number> = {};
  private _summary: LedgerSummary = {
    totalEarned: 0,
    totalSpent: 0,
    bySkill: {},
    byPeer: {},
  };

  constructor(options: { nodeId: string; dataDir?: string; bootstrapCredits?: number }) {
    super();
    this.nodeId = options.nodeId;
    this._dataDir = options.dataDir ?? path.resolve("data", "ledger");
    this._bootstrapCredits = options.bootstrapCredits ?? BOOTSTRAP_CREDITS;
    this._load();
  }

  addReceipt(receipt: TaskReceipt): { receipt: TaskReceipt; credits?: number; earned?: boolean; balance?: LedgerBalance; duplicate?: boolean } {
    if (this._receipts.some(r => r.id === receipt.id)) {
      return { duplicate: true, receipt };
    }

    this._receipts.push(receipt);

    const isEarner = receipt.to === this.nodeId;
    const isSpender = receipt.from === this.nodeId;
    const credits = this._calculateCredits(receipt);

    if (isEarner) {
      this._balance[receipt.from] = (this._balance[receipt.from] ?? 0) + credits;
      this._summary.totalEarned += credits;
      this._updateSkillSummary(receipt.skill, "earned", credits);
      this._updatePeerSummary(receipt.from, "earned", credits);
    } else if (isSpender) {
      this._balance[receipt.to] = (this._balance[receipt.to] ?? 0) - credits;
      this._summary.totalSpent += credits;
      this._updateSkillSummary(receipt.skill, "spent", credits);
      this._updatePeerSummary(receipt.to, "spent", credits);
    }

    this._persist();
    this.emit("receipt-added", { receipt, credits, earned: isEarner });

    return { receipt, credits, earned: isEarner, balance: this.getBalance() };
  }

  private _calculateCredits(receipt: TaskReceipt): number {
    const base = 1;
    const durationBonus = Math.floor((receipt.resourceUsed?.durationMs ?? 0) / 10000);
    return base + durationBonus;
  }

  private _updateSkillSummary(skill: string, type: "earned" | "spent", credits: number): void {
    if (!this._summary.bySkill[skill]) {
      this._summary.bySkill[skill] = { earned: 0, spent: 0, count: 0 };
    }
    this._summary.bySkill[skill][type] += credits;
    this._summary.bySkill[skill].count++;
  }

  private _updatePeerSummary(peerId: string, type: "earned" | "spent", credits: number): void {
    if (!this._summary.byPeer[peerId]) {
      this._summary.byPeer[peerId] = { earned: 0, spent: 0, count: 0 };
    }
    this._summary.byPeer[peerId][type] += credits;
    this._summary.byPeer[peerId].count++;
  }

  getBalance(): LedgerBalance {
    return {
      credits: this._bootstrapCredits + this._summary.totalEarned - this._summary.totalSpent,
      earned: this._summary.totalEarned,
      spent: this._summary.totalSpent,
      bootstrap: this._bootstrapCredits,
      byPeer: { ...this._balance },
    };
  }

  getReceipts(filters: ReceiptFilters = {}): TaskReceipt[] {
    let results = [...this._receipts];
    if (filters.peer) results = results.filter(r => r.from === filters.peer || r.to === filters.peer);
    if (filters.skill) results = results.filter(r => r.skill === filters.skill);
    if (filters.since) {
      const since = new Date(filters.since).getTime();
      results = results.filter(r => new Date(r.timestamp).getTime() >= since);
    }
    if (filters.limit) results = results.slice(-filters.limit);
    return results;
  }

  getSummary(): { nodeId: string; balance: LedgerBalance; receipts: number; summary: LedgerSummary } {
    return {
      nodeId: this.nodeId,
      balance: this.getBalance(),
      receipts: this._receipts.length,
      summary: { ...this._summary },
    };
  }

  getPeerBalance(peerId: string): number {
    return this._balance[peerId] ?? 0;
  }

  private _load(): void {
    try {
      const receiptsPath = path.join(this._dataDir, "receipts.json");
      const balancePath = path.join(this._dataDir, "balance.json");
      const summaryPath = path.join(this._dataDir, "summary.json");

      if (fs.existsSync(receiptsPath)) this._receipts = JSON.parse(fs.readFileSync(receiptsPath, "utf8"));
      if (fs.existsSync(balancePath)) this._balance = JSON.parse(fs.readFileSync(balancePath, "utf8"));
      if (fs.existsSync(summaryPath)) this._summary = { ...this._summary, ...JSON.parse(fs.readFileSync(summaryPath, "utf8")) };
    } catch {
      // First run — start empty
    }
  }

  private _persist(): void {
    try {
      if (!fs.existsSync(this._dataDir)) fs.mkdirSync(this._dataDir, { recursive: true });
      fs.writeFileSync(path.join(this._dataDir, "receipts.json"), JSON.stringify(this._receipts, null, 2));
      fs.writeFileSync(path.join(this._dataDir, "balance.json"), JSON.stringify(this._balance, null, 2));
      fs.writeFileSync(path.join(this._dataDir, "summary.json"), JSON.stringify(this._summary, null, 2));
    } catch (err: unknown) {
      console.error(`[ledger] Persist failed: ${(err as Error).message}`);
    }
  }
}
