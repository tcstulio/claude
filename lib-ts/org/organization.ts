// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// Organization — governance for groups of agents.

import { EventEmitter } from "node:events";
import crypto from "node:crypto";

export type OrgRole = "owner" | "admin" | "member";
export const ROLES: OrgRole[] = ["owner", "admin", "member"];

export interface OrgPolicies {
  minTrust: number;
  maxHops: number;
  votingThreshold: number;
  allowedScopes: string[];
  maxMembers: number;
  requireApproval: boolean;
}

export const DEFAULT_POLICIES: OrgPolicies = {
  minTrust: 0.3, maxHops: 3, votingThreshold: 0.51,
  allowedScopes: ["*"], maxMembers: 100, requireApproval: true,
};

export interface MemberInfo { role: OrgRole; joinedAt: string; invitedBy: string | null; }
export interface InviteInfo { invitedBy: string; role: OrgRole; at: string; }

export class Organization extends EventEmitter {
  readonly id: string;
  readonly name: string;
  readonly createdBy: string;
  readonly createdAt: string;
  policies: OrgPolicies;
  _members = new Map<string, MemberInfo>();
  private _invites = new Map<string, InviteInfo>();

  constructor(data: { id?: string; name?: string; createdBy: string; createdAt?: string; policies?: Partial<OrgPolicies>; members?: Record<string, MemberInfo> } = { createdBy: "" }) {
    super();
    this.id = data.id ?? `org_${crypto.randomBytes(8).toString("hex")}`;
    this.name = data.name ?? "Unnamed Organization";
    this.createdBy = data.createdBy;
    this.createdAt = data.createdAt ?? new Date().toISOString();
    this.policies = { ...DEFAULT_POLICIES, ...(data.policies ?? {}) };
    if (this.createdBy) this._members.set(this.createdBy, { role: "owner", joinedAt: this.createdAt, invitedBy: null });
    if (data.members) for (const [nodeId, info] of Object.entries(data.members)) this._members.set(nodeId, info);
  }

  invite(nodeId: string, invitedBy: string, role: OrgRole = "member") {
    this._requireRole(invitedBy, ["owner", "admin"]);
    if (this._members.has(nodeId)) throw new Error(`${nodeId} is already a member`);
    if (!ROLES.includes(role)) throw new Error(`Invalid role: ${role}`);
    if (role === "owner" && this._getRole(invitedBy) !== "owner") throw new Error("Only owners can invite owners");
    if (this._members.size >= this.policies.maxMembers) throw new Error(`Max members (${this.policies.maxMembers}) reached`);
    if (this.policies.requireApproval) {
      this._invites.set(nodeId, { invitedBy, role, at: new Date().toISOString() });
      this.emit("invite-sent", { orgId: this.id, nodeId, role, invitedBy });
      return { invited: true, pending: true };
    }
    return this._addMember(nodeId, role, invitedBy);
  }

  acceptInvite(nodeId: string) {
    const invite = this._invites.get(nodeId);
    if (!invite) throw new Error(`No pending invite for ${nodeId}`);
    this._invites.delete(nodeId);
    return this._addMember(nodeId, invite.role, invite.invitedBy);
  }

  declineInvite(nodeId: string) {
    if (!this._invites.has(nodeId)) throw new Error(`No pending invite for ${nodeId}`);
    this._invites.delete(nodeId);
    this.emit("invite-declined", { orgId: this.id, nodeId });
    return true;
  }

  removeMember(nodeId: string, removedBy: string) {
    this._requireRole(removedBy, ["owner", "admin"]);
    const member = this._members.get(nodeId);
    if (!member) throw new Error(`${nodeId} is not a member`);
    if (member.role === "owner" && this._getRole(removedBy) !== "owner") throw new Error("Only owners can remove owners");
    if (nodeId === removedBy) throw new Error("Cannot remove yourself — use leave()");
    this._members.delete(nodeId);
    this.emit("member-removed", { orgId: this.id, nodeId, removedBy });
    return true;
  }

  leave(nodeId: string) {
    if (!this._members.has(nodeId)) throw new Error(`${nodeId} is not a member`);
    if (this._getRole(nodeId) === "owner" && this.getMembers("owner").length <= 1) throw new Error("Last owner cannot leave");
    this._members.delete(nodeId);
    this.emit("member-left", { orgId: this.id, nodeId });
    return true;
  }

  updatePolicies(changes: Partial<OrgPolicies>, changedBy: string): OrgPolicies {
    this._requireRole(changedBy, ["owner", "admin"]);
    this.policies = { ...this.policies, ...changes };
    this.emit("policies-updated", { orgId: this.id, changes, changedBy });
    return this.policies;
  }

  canDelegate(fromNodeId: string, toNodeId: string, trust: number): boolean {
    return this._members.has(fromNodeId) && this._members.has(toNodeId) && trust >= this.policies.minTrust;
  }

  getMembers(role?: OrgRole | null): Array<{ nodeId: string } & MemberInfo> {
    const members = [...this._members.entries()].map(([nodeId, info]) => ({ nodeId, ...info }));
    return role ? members.filter(m => m.role === role) : members;
  }

  getPendingInvites(): Array<{ nodeId: string } & InviteInfo> {
    return [...this._invites.entries()].map(([nodeId, info]) => ({ nodeId, ...info }));
  }

  isMember(nodeId: string): boolean { return this._members.has(nodeId); }
  _getRole(nodeId: string): OrgRole | null { return this._members.get(nodeId)?.role ?? null; }

  _requireRole(nodeId: string, roles: OrgRole[]): void {
    const role = this._getRole(nodeId);
    if (!role || !roles.includes(role)) throw new Error(`Permission denied: ${nodeId} is ${role ?? "non-member"}, requires ${roles.join("/")}`);
  }

  private _addMember(nodeId: string, role: OrgRole, invitedBy: string) {
    this._members.set(nodeId, { role, joinedAt: new Date().toISOString(), invitedBy });
    this.emit("member-joined", { orgId: this.id, nodeId, role });
    return { invited: true, pending: false, role };
  }

  toJSON() {
    return {
      id: this.id, name: this.name, createdBy: this.createdBy, createdAt: this.createdAt,
      policies: this.policies, members: this.getMembers(), pendingInvites: this.getPendingInvites(),
      stats: { total: this._members.size, owners: this.getMembers("owner").length, admins: this.getMembers("admin").length, members: this.getMembers("member").length },
    };
  }
}
