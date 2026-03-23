// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// OrgRegistry — organization registry with cross-hub reputation.

import fs from "node:fs";
import path from "node:path";
import { Organization } from "./organization.js";
import type { OrgPolicies, MemberInfo } from "./organization.js";
import type { TrustGraph } from "./trust.js";

const ORG_REPUTATION_WEIGHT = 0.3;

export class OrgRegistry {
  private _dataDir: string;
  private _trust: TrustGraph | null;
  private _orgs = new Map<string, Organization>();

  constructor(options: { dataDir?: string; trust?: TrustGraph } = {}) {
    this._dataDir = options.dataDir ?? path.resolve("data");
    this._trust = options.trust ?? null;
    this._load();
  }

  create(name: string, createdBy: string, policies: Partial<OrgPolicies> = {}): Organization {
    const org = new Organization({ name, createdBy, policies });
    this._orgs.set(org.id, org);
    this._persist();
    return org;
  }

  get(orgId: string): Organization | null { return this._orgs.get(orgId) ?? null; }

  list(filter: { member?: string } = {}): Organization[] {
    let orgs = [...this._orgs.values()];
    if (filter.member) orgs = orgs.filter(o => o.isMember(filter.member!));
    return orgs;
  }

  remove(orgId: string, removedBy: string): boolean {
    const org = this._orgs.get(orgId);
    if (!org) throw new Error(`Org ${orgId} not found`);
    org._requireRole(removedBy, ["owner"]);
    this._orgs.delete(orgId);
    this._persist();
    return true;
  }

  getOrgReputation(orgId: string): number {
    const org = this._orgs.get(orgId);
    if (!org || !this._trust) return 0;
    const members = org.getMembers();
    if (members.length === 0) return 0;
    let totalTrust = 0, counted = 0;
    for (const m of members) {
      const trust = this._trust.getDirectTrust(m.nodeId);
      if (trust !== null) { totalTrust += trust; counted++; }
    }
    return counted > 0 ? totalTrust / counted : 0;
  }

  getTrustBoost(nodeId: string): number {
    const memberOrgs = this.list({ member: nodeId });
    if (memberOrgs.length === 0) return 0;
    let best = 0;
    for (const org of memberOrgs) best = Math.max(best, this.getOrgReputation(org.id));
    return best * ORG_REPUTATION_WEIGHT;
  }

  getPublicOrgInfo(nodeId: string): Array<{ orgId: string; orgName: string; role: string | null; members: number; reputation: number }> {
    return this.list({ member: nodeId }).map(org => ({
      orgId: org.id, orgName: org.name, role: org._getRole(nodeId),
      members: org.getMembers().length, reputation: Math.round(this.getOrgReputation(org.id) * 1000) / 1000,
    }));
  }

  save(): void { this._persist(); }

  private _load(): void {
    try {
      const filePath = path.join(this._dataDir, "orgs.json");
      if (fs.existsSync(filePath)) {
        const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as Array<{ id: string; name: string; createdBy: string; createdAt: string; policies: Partial<OrgPolicies>; members?: Array<{ nodeId: string } & MemberInfo> }>;
        for (const orgData of data) {
          const org = new Organization({ ...orgData, members: undefined });
          if (orgData.members) {
            for (const m of orgData.members) org._members.set(m.nodeId, { role: m.role, joinedAt: m.joinedAt, invitedBy: m.invitedBy });
          }
          this._orgs.set(org.id, org);
        }
      }
    } catch { /* first run */ }
  }

  private _persist(): void {
    try {
      if (!fs.existsSync(this._dataDir)) fs.mkdirSync(this._dataDir, { recursive: true });
      const data = [...this._orgs.values()].map(o => o.toJSON());
      fs.writeFileSync(path.join(this._dataDir, "orgs.json"), JSON.stringify(data, null, 2));
    } catch (err: unknown) { console.error(`[org] Persist failed: ${(err as Error).message}`); }
  }
}
