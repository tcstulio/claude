// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// CanaryRunner — canary deployment testing in ephemeral containers.

import { EventEmitter } from "node:events";
import type { SSHTaskRunner } from "./ssh-task.js";

export type CanaryState = "pending" | "provisioning" | "testing" | "passed" | "failed" | "promoting" | "rejected" | "done";
export const CANARY_STATES: CanaryState[] = ["pending", "provisioning", "testing", "passed", "failed", "promoting", "rejected", "done"];

export interface CanaryRun {
  id: string; version: string; repo: string; branch: string; testCommands: string[];
  executor: { nodeId: string; name: string } | null; state: CanaryState;
  createdAt: string; updatedAt: string; results: Record<string, unknown> | null;
  containerId: string | null; approval: { approved: boolean; reason: string; at: string } | null;
  timeline: Array<{ state: CanaryState; at: string }>; script?: { containerName: string; commands: string[]; estimatedDurationMs: number };
}

interface MeshLike { registry: { get(id: string): { nodeId: string; name: string; status?: string } | null; list(filter?: Record<string, unknown>): Array<{ nodeId: string; name: string; status?: string }> }; trust?: { rankForDelegation(peers: unknown[], opts: Record<string, unknown>): Array<{ peer: { nodeId: string }; eligible: boolean }> } }

export class CanaryRunner extends EventEmitter {
  private _mesh: MeshLike | null;
  private _ledger: unknown;
  private _notify: (nodeId: string | null, msg: string) => Promise<void>;
  private _ownerNode: string | null;
  private _runs = new Map<string, CanaryRun>();

  constructor(options: { mesh?: MeshLike; ledger?: unknown; notify?: (nodeId: string | null, msg: string) => Promise<void>; ownerNode?: string }) {
    super();
    this._mesh = options.mesh ?? null;
    this._ledger = options.ledger ?? null;
    this._notify = options.notify ?? (async () => {});
    this._ownerNode = options.ownerNode ?? null;
  }

  async start(params: { version: string; repo: string; branch?: string; testCommands?: string[]; preferNode?: string }): Promise<CanaryRun> {
    const { version, repo, branch = "main", testCommands = ["npm test"], preferNode } = params;
    const runId = `canary_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const executor = this._selectExecutor(preferNode);
    const run: CanaryRun = {
      id: runId, version, repo, branch, testCommands, executor: executor ? { nodeId: executor.nodeId, name: executor.name } : null,
      state: "pending", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      results: null, containerId: null, approval: null, timeline: [{ state: "pending", at: new Date().toISOString() }],
    };
    this._runs.set(runId, run);
    this.emit("canary-created", run);
    if (!executor) { this._updateState(runId, "failed", { results: { error: "No compute node available" } }); return run; }
    run.script = this._generateScript(run);
    this._updateState(runId, "provisioning");
    return run;
  }

  async execute(runId: string, sshRunner: SSHTaskRunner): Promise<Record<string, unknown>> {
    const run = this._runs.get(runId);
    if (!run) throw new Error(`Canary run ${runId} not found`);
    this._updateState(runId, "testing");
    try {
      const results = await sshRunner.executeMany(run.script!.commands, { stopOnError: true });
      const allPassed = results.every(r => r.ok);
      run.results = { passed: allPassed, tests: results.map(r => ({ command: r.command, ok: r.ok, output: r.stdout?.slice(0, 1000), error: r.stderr?.slice(0, 500), durationMs: r.durationMs })), totalDurationMs: results.reduce((s, r) => s + (r.durationMs ?? 0), 0), executedAt: new Date().toISOString() };
      this._updateState(runId, allPassed ? "passed" : "failed");
      await this._notify(this._ownerNode, `Canary v${run.version} ${allPassed ? "PASSED" : "FAILED"}`);
      return run.results;
    } catch (err: unknown) { run.results = { passed: false, error: (err as Error).message }; this._updateState(runId, "failed"); return run.results; }
  }

  approve(runId: string, approved: boolean, reason = ""): CanaryRun {
    const run = this._runs.get(runId);
    if (!run) throw new Error(`Canary run ${runId} not found`);
    if (run.state !== "passed") throw new Error(`Run not in 'passed' state (current: ${run.state})`);
    run.approval = { approved, reason, at: new Date().toISOString() };
    this._updateState(runId, approved ? "promoting" : "rejected");
    this.emit(approved ? "canary-promoting" : "canary-rejected", run);
    return run;
  }

  complete(runId: string): CanaryRun | undefined { this._updateState(runId, "done"); return this._runs.get(runId); }
  getRun(runId: string): CanaryRun | null { return this._runs.get(runId) ?? null; }
  listRuns(filter: { state?: CanaryState; version?: string } = {}): CanaryRun[] {
    let runs = [...this._runs.values()];
    if (filter.state) runs = runs.filter(r => r.state === filter.state);
    if (filter.version) runs = runs.filter(r => r.version === filter.version);
    return runs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }

  private _selectExecutor(preferNode?: string) {
    if (preferNode) { const p = this._mesh?.registry.get(preferNode); if (p?.status === "online") return p; }
    const peers = this._mesh?.registry.list({ capability: "compute" }) ?? [];
    return peers.find(p => p.status === "online") ?? null;
  }

  private _generateScript(run: CanaryRun) {
    const cn = `canary-${run.id.slice(0, 12)}`;
    return { containerName: cn, commands: [`cd /tmp && rm -rf ${cn} && git clone --depth 1 -b ${run.branch} ${run.repo} ${cn}`, `cd /tmp/${cn} && npm install --production 2>&1 | tail -5`, ...run.testCommands.map(c => `cd /tmp/${cn} && ${c}`), `rm -rf /tmp/${cn}`], estimatedDurationMs: 120000 };
  }

  private _updateState(runId: string, newState: CanaryState, extra: Record<string, unknown> = {}): void {
    const run = this._runs.get(runId);
    if (!run) return;
    run.state = newState; run.updatedAt = new Date().toISOString();
    run.timeline.push({ state: newState, at: run.updatedAt });
    Object.assign(run, extra);
    this.emit("canary-state-change", { runId, state: newState, run });
  }
}
