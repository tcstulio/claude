// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// HubAdvisor — LLM-assisted network topology advisor.

import { EventEmitter } from "node:events";
import type { HubRegistry, HubRegistryEntry } from "./hub-registry.js";
import type { TrustGraph } from "./trust.js";

export interface Recommendation {
  action: "promote" | "demote" | "none";
  targetNodeId: string;
  reason: string;
  confidence: number;
}

export interface NetworkSnapshot {
  activeHubs: HubRegistryEntry[];
  failedHubs: HubRegistryEntry[];
  candidates: Array<{ nodeId: string; name: string; endpoint: string | null; trust: number; uptime: number; capabilities: string[] }>;
  totalNodes: number;
  minHubs: number;
  maxHubs: number;
}

export interface AnalysisResult {
  recommendations: Recommendation[];
  snapshot: NetworkSnapshot;
  method: "llm" | "heuristic";
  timestamp: number;
}

interface MeshLike {
  registry?: { list(): Array<{ nodeId: string; name: string; status?: string; endpoint?: string; metadata?: Record<string, unknown>; capabilities?: string[] }> };
}

export class HubAdvisor extends EventEmitter {
  private _hubRegistry: HubRegistry;
  private _mesh: MeshLike | null;
  private _trust: TrustGraph | null;
  private _callMcpTool: ((tool: string, args: Record<string, unknown>) => Promise<{ response?: string }>) | null;
  private _analysisInterval: number;
  private _analysisTimer: ReturnType<typeof setInterval> | null = null;
  private _lastAnalysis: AnalysisResult | null = null;
  private _lastAnalysisAt: number | null = null;

  constructor(options: {
    hubRegistry: HubRegistry;
    mesh?: MeshLike;
    trust?: TrustGraph;
    callMcpTool?: (tool: string, args: Record<string, unknown>) => Promise<{ response?: string }>;
    analysisInterval?: number;
  }) {
    super();
    this._hubRegistry = options.hubRegistry;
    this._mesh = options.mesh ?? null;
    this._trust = options.trust ?? null;
    this._callMcpTool = options.callMcpTool ?? null;
    this._analysisInterval = options.analysisInterval ?? 5 * 60 * 1000;
  }

  async analyze(): Promise<AnalysisResult> {
    const snapshot = this._getSnapshot();
    let recommendations: Recommendation[];
    let method: "llm" | "heuristic";

    if (this._callMcpTool) {
      try {
        recommendations = await this._analyzeLLM(snapshot);
        method = "llm";
      } catch {
        recommendations = this._analyzeHeuristic(snapshot);
        method = "heuristic";
      }
    } else {
      recommendations = this._analyzeHeuristic(snapshot);
      method = "heuristic";
    }

    this._lastAnalysis = { recommendations, snapshot, method, timestamp: Date.now() };
    this._lastAnalysisAt = Date.now();
    this.emit("analysis-complete", this._lastAnalysis);
    return this._lastAnalysis;
  }

  private async _analyzeLLM(snapshot: NetworkSnapshot): Promise<Recommendation[]> {
    const prompt = this._buildPrompt(snapshot);
    const result = await this._callMcpTool!("send_prompt", { text: prompt });
    return this._parseRecommendations(result?.response ?? "");
  }

  private _buildPrompt(snapshot: NetworkSnapshot): string {
    return `Analyze the Tulipa network state and recommend hub actions.

## Current State
**Active hubs:** ${snapshot.activeHubs.length}
**Total nodes:** ${snapshot.totalNodes}
**Min hubs:** ${snapshot.minHubs} | **Max hubs:** ${snapshot.maxHubs}

### Hubs
${snapshot.activeHubs.map(h => `- **${h.name}** (${h.nodeId}): load=${(h.metrics?.loadAvg as number)?.toFixed(2) ?? "?"}, peers=${h.peerCount ?? 0}, state=${h.state}`).join("\n")}

### Failed Hubs
${snapshot.failedHubs.map(h => `- **${h.name}** (${h.nodeId}): state=${h.state}`).join("\n") || "(none)"}

### Candidates
${snapshot.candidates.map(c => `- **${c.name}** (${c.nodeId}): trust=${c.trust?.toFixed(2) ?? "?"}, endpoint=${c.endpoint ? "yes" : "no"}`).join("\n") || "(none)"}

Respond ONLY with JSON: { "recommendations": [{ "action": "promote"|"demote"|"none", "targetNodeId": "...", "reason": "...", "confidence": 0.0-1.0 }] }`;
  }

  private _parseRecommendations(text: string): Recommendation[] {
    try {
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) ?? text.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[1] ?? jsonMatch[0]);
      return (parsed.recommendations ?? []).filter((r: Recommendation) => r.action && r.targetNodeId && r.confidence >= 0);
    } catch { return []; }
  }

  private _analyzeHeuristic(snapshot: NetworkSnapshot): Recommendation[] {
    const recs: Recommendation[] = [];
    for (const hub of snapshot.failedHubs) {
      if (hub.state === ("dead" as string)) recs.push({ action: "demote", targetNodeId: hub.nodeId, reason: `Hub ${hub.name} not responding`, confidence: 0.95 });
    }
    if (snapshot.activeHubs.length < snapshot.minHubs && snapshot.candidates.length > 0) {
      const sorted = [...snapshot.candidates].sort((a, b) => {
        if (a.endpoint && !b.endpoint) return -1;
        if (!a.endpoint && b.endpoint) return 1;
        return (b.trust ?? 0) - (a.trust ?? 0);
      });
      const best = sorted[0];
      if (best) recs.push({ action: "promote", targetNodeId: best.nodeId, reason: `Network needs more hubs. ${best.name} is best candidate.`, confidence: best.endpoint ? 0.85 : 0.5 });
    }
    for (const hub of snapshot.activeHubs) {
      if (((hub.metrics?.loadAvg as number) ?? 0) > 2.0 && snapshot.candidates.length > 0) {
        const best = snapshot.candidates[0];
        if (best && !recs.find(r => r.targetNodeId === best.nodeId)) {
          recs.push({ action: "promote", targetNodeId: best.nodeId, reason: `Hub ${hub.name} overloaded, promote ${best.name} to balance`, confidence: 0.65 });
        }
        break;
      }
    }
    return recs;
  }

  private _getSnapshot(): NetworkSnapshot {
    const allHubs = this._hubRegistry.list();
    const activeHubs = allHubs.filter(h => h.state === "active");
    const failedHubs = allHubs.filter(h => h.state === ("dead" as string) || h.state === "suspect");
    const candidates: NetworkSnapshot["candidates"] = [];
    if (this._mesh?.registry) {
      const hubIds = new Set(allHubs.map(h => h.nodeId));
      for (const peer of this._mesh.registry.list()) {
        if (hubIds.has(peer.nodeId) || peer.status === "dead") continue;
        candidates.push({
          nodeId: peer.nodeId, name: peer.name,
          endpoint: peer.metadata?.endpoint as string ?? peer.endpoint ?? null,
          trust: this._trust?.getDirectTrust(peer.nodeId) ?? 0,
          uptime: (peer.metadata?.uptime as number) ?? 0,
          capabilities: peer.capabilities ?? [],
        });
      }
    }
    return { activeHubs, failedHubs, candidates, totalNodes: (this._mesh?.registry?.list()?.length ?? 0) + 1, minHubs: 1, maxHubs: 10 };
  }

  start(): void {
    if (this._analysisTimer) return;
    setTimeout(() => this.analyze().catch(() => {}), 30000);
    this._analysisTimer = setInterval(() => this.analyze().catch(() => {}), this._analysisInterval);
  }

  stop(): void {
    if (this._analysisTimer) { clearInterval(this._analysisTimer); this._analysisTimer = null; }
  }

  toJSON() {
    return { lastAnalysis: this._lastAnalysis, lastAnalysisAt: this._lastAnalysisAt, interval: this._analysisInterval, running: !!this._analysisTimer };
  }
}
