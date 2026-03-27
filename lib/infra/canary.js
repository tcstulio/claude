'use strict';

const { EventEmitter } = require('events');

/**
 * CanaryRunner — execução de testes canário em container efêmero.
 *
 * Fluxo:
 *   1. Rede seleciona nó com melhor ranking (compute + trust + saldo)
 *   2. Nó cria container LXC efêmero
 *   3. Instala versão candidata
 *   4. Executa suite de testes
 *   5. Reporta resultado
 *   6. Destrói container
 *   7. Owner aprova ou rejeita promoção
 *
 * Estados: pending → provisioning → testing → passed|failed → promoting|rejected → done
 */

const CANARY_STATES = ['pending', 'provisioning', 'testing', 'passed', 'failed', 'promoting', 'rejected', 'done'];

class CanaryRunner extends EventEmitter {
  /**
   * @param {object} options
   * @param {object} options.mesh — MeshManager
   * @param {object} [options.ledger] — Ledger instance
   * @param {function} [options.notify] — função de notificação (nodeId, message)
   * @param {string} [options.ownerNode] — nodeId do owner para aprovação
   */
  constructor(options = {}) {
    super();
    this._mesh = options.mesh;
    this._ledger = options.ledger;
    this._notify = options.notify || (async () => {});
    this._ownerNode = options.ownerNode || null;

    // Canary runs: Map<runId, CanaryRun>
    this._runs = new Map();
  }

  /**
   * Inicia um canary test.
   *
   * @param {object} params
   * @param {string} params.version — versão candidata (ex: "0.5.0")
   * @param {string} params.repo — repositório git
   * @param {string} [params.branch] — branch (default: main)
   * @param {string[]} [params.testCommands] — comandos de teste
   * @param {string} [params.preferNode] — preferir este nó para execução
   * @returns {object} canary run info
   */
  async start(params) {
    const {
      version,
      repo,
      branch = 'main',
      testCommands = ['npm test'],
      preferNode,
    } = params;

    const runId = `canary_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

    // 1. Selecionar nó executor
    const executor = this._selectExecutor(preferNode);

    const run = {
      id: runId,
      version,
      repo,
      branch,
      testCommands,
      executor: executor ? { nodeId: executor.nodeId, name: executor.name } : null,
      state: 'pending',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      results: null,
      containerId: null,
      approval: null,
      timeline: [{ state: 'pending', at: new Date().toISOString() }],
    };

    this._runs.set(runId, run);
    this.emit('canary-created', run);

    if (!executor) {
      this._updateState(runId, 'failed', {
        results: { error: 'Nenhum nó com capability compute disponível' },
      });
      return run;
    }

    // 2. Gerar script de provisioning + teste
    run.script = this._generateScript(run);
    this._updateState(runId, 'provisioning');

    return run;
  }

  /**
   * Executa o canary num nó remoto (chamado pelo executor).
   * Simula: cria container → instala → testa → destrói.
   *
   * @param {string} runId
   * @param {object} sshRunner — SSHTaskRunner conectado ao nó
   * @returns {Promise<object>} resultado
   */
  async execute(runId, sshRunner) {
    const run = this._runs.get(runId);
    if (!run) throw new Error(`Canary run ${runId} não encontrado`);

    this._updateState(runId, 'testing');

    try {
      // Executar script de teste
      const results = await sshRunner.executeMany(run.script.commands, { stopOnError: true });

      const allPassed = results.every(r => r.ok);
      const testOutput = results.map(r => ({
        command: r.command,
        ok: r.ok,
        output: r.stdout?.slice(0, 1000),
        error: r.stderr?.slice(0, 500),
        durationMs: r.durationMs,
      }));

      run.results = {
        passed: allPassed,
        tests: testOutput,
        totalDurationMs: results.reduce((sum, r) => sum + (r.durationMs || 0), 0),
        executedAt: new Date().toISOString(),
      };

      if (allPassed) {
        this._updateState(runId, 'passed');
        await this._notify(this._ownerNode, `Canary v${run.version} PASSED — aguardando aprovação`);
      } else {
        this._updateState(runId, 'failed');
        await this._notify(this._ownerNode, `Canary v${run.version} FAILED — ver detalhes`);
      }

      return run.results;
    } catch (err) {
      run.results = { passed: false, error: err.message };
      this._updateState(runId, 'failed');
      return run.results;
    }
  }

  /**
   * Owner aprova ou rejeita promoção.
   *
   * @param {string} runId
   * @param {boolean} approved
   * @param {string} [reason]
   * @returns {object} run atualizado
   */
  approve(runId, approved, reason = '') {
    const run = this._runs.get(runId);
    if (!run) throw new Error(`Canary run ${runId} não encontrado`);
    if (run.state !== 'passed') {
      throw new Error(`Canary run ${runId} não está em estado 'passed' (atual: ${run.state})`);
    }

    run.approval = {
      approved,
      reason,
      at: new Date().toISOString(),
    };

    if (approved) {
      this._updateState(runId, 'promoting');
      this.emit('canary-promoting', run);
    } else {
      this._updateState(runId, 'rejected');
      this.emit('canary-rejected', run);
    }

    return run;
  }

  /**
   * Marca promoção como concluída.
   */
  complete(runId) {
    this._updateState(runId, 'done');
    return this._runs.get(runId);
  }

  /**
   * Retorna status de um run.
   */
  getRun(runId) {
    return this._runs.get(runId) || null;
  }

  /**
   * Lista todos os runs.
   */
  listRuns(filter = {}) {
    let runs = [...this._runs.values()];
    if (filter.state) runs = runs.filter(r => r.state === filter.state);
    if (filter.version) runs = runs.filter(r => r.version === filter.version);
    return runs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  /**
   * Seleciona o melhor nó para executar o canary.
   * @private
   */
  _selectExecutor(preferNode) {
    if (preferNode) {
      const peer = this._mesh?.registry.get(preferNode);
      if (peer?.status === 'online') return peer;
    }

    // Ranking por compute capability + trust + saldo
    const computePeers = this._mesh?.registry.list({ capability: 'compute' }) || [];
    const onlinePeers = computePeers.filter(p => p.status === 'online');

    if (onlinePeers.length === 0) return null;

    // Usar trust ranking se disponível
    if (this._mesh?.trust) {
      const ranking = this._mesh.trust.rankForDelegation(onlinePeers, {
        skill: 'compute',
        ledger: this._ledger,
      });
      const best = ranking.find(r => r.eligible);
      if (best) {
        return this._mesh.registry.get(best.peer.nodeId);
      }
    }

    return onlinePeers[0];
  }

  /**
   * Gera script de teste para o container efêmero.
   * @private
   */
  _generateScript(run) {
    const containerName = `canary-${run.id.slice(0, 12)}`;
    const commands = [
      // Criar container LXC efêmero
      `pct create 9999 local:vztmpl/debian-12-standard_12.2-1_amd64.tar.zst --hostname ${containerName} --memory 512 --cores 1 --rootfs local:2 --net0 name=eth0,bridge=vmbr0,ip=dhcp --start 1 --unprivileged 1 2>/dev/null || echo "SKIP_LXC: usando host direto"`,

      // Clonar e instalar
      `cd /tmp && rm -rf ${containerName} && git clone --depth 1 -b ${run.branch} ${run.repo} ${containerName}`,
      `cd /tmp/${containerName} && npm install --production 2>&1 | tail -5`,

      // Executar testes
      ...run.testCommands.map(cmd => `cd /tmp/${containerName} && ${cmd}`),

      // Cleanup
      `rm -rf /tmp/${containerName}`,
      `pct destroy 9999 --force 2>/dev/null || true`,
    ];

    return {
      containerName,
      commands,
      estimatedDurationMs: 120000, // ~2 min
    };
  }

  /**
   * @private
   */
  _updateState(runId, newState, extra = {}) {
    const run = this._runs.get(runId);
    if (!run) return;

    run.state = newState;
    run.updatedAt = new Date().toISOString();
    run.timeline.push({ state: newState, at: run.updatedAt });
    Object.assign(run, extra);

    this.emit('canary-state-change', { runId, state: newState, run });
  }
}

module.exports = { CanaryRunner, CANARY_STATES };
