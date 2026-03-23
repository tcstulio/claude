'use strict';

const { EventEmitter } = require('events');

/**
 * HubAdvisor — módulo que usa LLM para analisar a rede e recomendar
 * promoções/demoções de hubs.
 *
 * O advisor é consultivo — ele gera recomendações mas o HubCouncil
 * decide via votação se aceita ou não.
 *
 * Pode funcionar sem LLM (usa heurísticas simples como fallback).
 */

class HubAdvisor extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.hubRegistry — HubRegistry
   * @param {object} options.mesh — MeshManager (para acessar peers)
   * @param {object} options.trust — TrustGraph
   * @param {function} [options.callMcpTool] — para chamar LLM via MCP
   * @param {number} [options.analysisInterval=300000] — intervalo (5 min)
   */
  constructor(options = {}) {
    super();
    this._hubRegistry = options.hubRegistry;
    this._mesh = options.mesh;
    this._trust = options.trust;
    this._callMcpTool = options.callMcpTool || null;
    this._analysisInterval = options.analysisInterval || 5 * 60 * 1000;
    this._analysisTimer = null;
    this._lastAnalysis = null;
    this._lastAnalysisAt = null;
  }

  // ─── Análise ────────────────────────────────────────────────────────

  /**
   * Executa análise completa da rede.
   * Tenta usar LLM; se não disponível, usa heurísticas.
   * @returns {object} { recommendations, snapshot, method }
   */
  async analyze() {
    const snapshot = this._getNetworkSnapshot();

    let recommendations;
    let method;

    // Tenta LLM primeiro
    if (this._callMcpTool) {
      try {
        recommendations = await this._analyzeLLM(snapshot);
        method = 'llm';
      } catch (err) {
        console.log(`[hub-advisor] LLM indisponível: ${err.message}. Usando heurísticas.`);
        recommendations = this._analyzeHeuristic(snapshot);
        method = 'heuristic';
      }
    } else {
      recommendations = this._analyzeHeuristic(snapshot);
      method = 'heuristic';
    }

    this._lastAnalysis = { recommendations, snapshot, method, timestamp: Date.now() };
    this._lastAnalysisAt = Date.now();
    this.emit('analysis-complete', this._lastAnalysis);
    return this._lastAnalysis;
  }

  // ─── LLM Analysis ──────────────────────────────────────────────────

  async _analyzeLLM(snapshot) {
    const prompt = this._buildPrompt(snapshot);

    const result = await this._callMcpTool('send_prompt', {
      text: prompt,
    });

    return this._parseRecommendations(result?.response || '');
  }

  _buildPrompt(snapshot) {
    return `Analise o estado da rede Tulipa e recomende ações para os hubs.

## Estado Atual

**Hubs ativos:** ${snapshot.activeHubs.length}
**Total de nós:** ${snapshot.totalNodes}
**Mínimo de hubs desejado:** ${snapshot.minHubs}
**Máximo de hubs:** ${snapshot.maxHubs}

### Hubs
${snapshot.activeHubs.map(h => `- **${h.name}** (${h.nodeId}): load=${h.metrics?.loadAvg?.toFixed(2) || '?'}, peers=${h.peerCount || 0}, uptime=${this._formatUptime(h.metrics?.uptime)}, estado=${h.state}`).join('\n')}

### Candidatos (nós que poderiam ser hub)
${snapshot.candidates.map(c => `- **${c.name}** (${c.nodeId}): trust=${c.trust?.toFixed(2) || '?'}, endpoint=${c.endpoint ? 'sim' : 'não'}, uptime=${this._formatUptime(c.uptime)}`).join('\n') || '(nenhum candidato)'}

### Hubs suspeitos/mortos
${snapshot.failedHubs.map(h => `- **${h.name}** (${h.nodeId}): estado=${h.state}, último heartbeat=${new Date(h.lastHeartbeat).toISOString()}`).join('\n') || '(nenhum)'}

## Regras
- Rede precisa de pelo menos ${snapshot.minHubs} hubs e no máximo ${snapshot.maxHubs}
- Promover nós com endpoint público, alta trust e boa disponibilidade
- Demover hubs mortos ou com carga muito alta
- Considerar distribuição geográfica e balanceamento de carga

## Formato de resposta
Responda APENAS com JSON:
\`\`\`json
{
  "recommendations": [
    {
      "action": "promote" | "demote" | "none",
      "targetNodeId": "...",
      "reason": "...",
      "confidence": 0.0 a 1.0
    }
  ],
  "summary": "resumo em 1 frase"
}
\`\`\``;
  }

  _parseRecommendations(text) {
    try {
      // Tenta extrair JSON da resposta
      const jsonMatch = text.match(/```json\s*([\s\S]*?)```/) || text.match(/\{[\s\S]*"recommendations"[\s\S]*\}/);
      if (!jsonMatch) return [];

      const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
      return (parsed.recommendations || []).filter(r =>
        r.action && r.targetNodeId && r.confidence >= 0
      );
    } catch {
      return [];
    }
  }

  // ─── Heuristic Analysis ─────────────────────────────────────────────

  /**
   * Análise baseada em regras simples (fallback sem LLM).
   */
  _analyzeHeuristic(snapshot) {
    const recommendations = [];

    // 1. Demover hubs mortos
    for (const hub of snapshot.failedHubs) {
      if (hub.state === 'dead') {
        recommendations.push({
          action: 'demote',
          targetNodeId: hub.nodeId,
          reason: `Hub ${hub.name} não responde`,
          confidence: 0.95,
        });
      }
    }

    // 2. Se poucos hubs, promover melhor candidato
    if (snapshot.activeHubs.length < snapshot.minHubs && snapshot.candidates.length > 0) {
      // Ordena candidatos por trust (desc) e endpoint (tem primeiro)
      const sorted = [...snapshot.candidates].sort((a, b) => {
        if (a.endpoint && !b.endpoint) return -1;
        if (!a.endpoint && b.endpoint) return 1;
        return (b.trust || 0) - (a.trust || 0);
      });

      const best = sorted[0];
      if (best) {
        recommendations.push({
          action: 'promote',
          targetNodeId: best.nodeId,
          reason: `Rede precisa de mais hubs. ${best.name} tem ${best.endpoint ? 'endpoint público' : 'potencial'} e trust ${(best.trust || 0).toFixed(2)}`,
          confidence: best.endpoint ? 0.85 : 0.5,
        });
      }
    }

    // 3. Se hub sobrecarregado e candidatos disponíveis, promover para balancear
    for (const hub of snapshot.activeHubs) {
      if ((hub.metrics?.loadAvg || 0) > 2.0 && snapshot.candidates.length > 0) {
        const best = snapshot.candidates[0];
        if (best && !recommendations.find(r => r.targetNodeId === best.nodeId)) {
          recommendations.push({
            action: 'promote',
            targetNodeId: best.nodeId,
            reason: `Hub ${hub.name} sobrecarregado (load ${hub.metrics.loadAvg.toFixed(2)}), promover ${best.name} para balancear`,
            confidence: 0.65,
          });
        }
        break; // Só uma promoção por vez
      }
    }

    return recommendations;
  }

  // ─── Network Snapshot ───────────────────────────────────────────────

  _getNetworkSnapshot() {
    const allHubs = this._hubRegistry.list();
    const activeHubs = allHubs.filter(h => h.state === 'active');
    const failedHubs = allHubs.filter(h => h.state === 'dead' || h.state === 'suspect');

    // Peers que poderiam ser promovidos a hub
    const candidates = [];
    if (this._mesh?.registry) {
      const peers = this._mesh.registry.list();
      const hubIds = new Set(allHubs.map(h => h.nodeId));

      for (const peer of peers) {
        if (hubIds.has(peer.nodeId)) continue; // Já é hub
        if (peer.status === 'dead') continue;

        const trustScore = this._trust?.getTrust(peer.nodeId) || 0;
        candidates.push({
          nodeId: peer.nodeId,
          name: peer.name,
          endpoint: peer.metadata?.endpoint || peer.endpoint || null,
          trust: trustScore,
          uptime: peer.metadata?.uptime || 0,
          capabilities: peer.capabilities || [],
        });
      }
    }

    return {
      activeHubs,
      failedHubs,
      candidates,
      totalNodes: (this._mesh?.registry?.list()?.length || 0) + 1, // +1 para self
      minHubs: this._hubRegistry?._minHubs || 1,
      maxHubs: this._hubRegistry?._maxHubs || 10,
    };
  }

  _formatUptime(ms) {
    if (!ms) return '?';
    const hours = Math.floor(ms / 3600000);
    if (hours > 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
    return `${hours}h`;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────

  start() {
    if (this._analysisTimer) return;
    // Primeira análise após 30s (dar tempo para discovery)
    setTimeout(() => this.analyze().catch(() => {}), 30000);
    this._analysisTimer = setInterval(
      () => this.analyze().catch(() => {}),
      this._analysisInterval,
    );
  }

  stop() {
    if (this._analysisTimer) {
      clearInterval(this._analysisTimer);
      this._analysisTimer = null;
    }
  }

  // ─── Serialização ───────────────────────────────────────────────────

  toJSON() {
    return {
      lastAnalysis: this._lastAnalysis,
      lastAnalysisAt: this._lastAnalysisAt,
      interval: this._analysisInterval,
      running: !!this._analysisTimer,
    };
  }
}

module.exports = { HubAdvisor };
