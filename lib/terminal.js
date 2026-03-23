'use strict';

const { execFile } = require('child_process');

/**
 * Terminal — captura estado dos painéis tmux.
 *
 * Usa variáveis tmux como pane_current_command e capture-pane
 * para criar snapshots do que está acontecendo nos terminais.
 *
 * Funcionalidades:
 *   - Listar sessões/janelas/painéis tmux
 *   - Capturar comando atual de cada painel (pane_current_command)
 *   - Capturar conteúdo visível do painel (screenshot em texto)
 *   - Capturar histórico de scroll do painel
 *   - Snapshot completo de todos os painéis
 */
class Terminal {
  constructor(options = {}) {
    this._tmuxAvailable = null; // null = não testado
    this._historySize = options.historySize || 100;
    this._snapshots = [];
  }

  // ─── Helpers ──────────────────────────────────────────────────────

  _exec(cmd, args = [], timeout = 5000) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });
  }

  async _checkTmux() {
    if (this._tmuxAvailable !== null) return this._tmuxAvailable;
    try {
      await this._exec('tmux', ['list-sessions']);
      this._tmuxAvailable = true;
    } catch {
      this._tmuxAvailable = false;
    }
    return this._tmuxAvailable;
  }

  // ─── Sessões e painéis ────────────────────────────────────────────

  /** Lista todas as sessões tmux */
  async listSessions() {
    if (!await this._checkTmux()) return [];
    try {
      const out = await this._exec('tmux', [
        'list-sessions', '-F',
        '#{session_id}|#{session_name}|#{session_windows}|#{session_attached}|#{session_created}'
      ]);
      return out.split('\n').filter(Boolean).map(line => {
        const [id, name, windows, attached, created] = line.split('|');
        return {
          id, name,
          windows: parseInt(windows) || 0,
          attached: attached === '1',
          created: new Date(parseInt(created) * 1000).toISOString(),
        };
      });
    } catch {
      return [];
    }
  }

  /** Lista todos os painéis com comando atual */
  async listPanes() {
    if (!await this._checkTmux()) return [];
    try {
      const out = await this._exec('tmux', [
        'list-panes', '-a', '-F',
        '#{session_name}|#{window_index}|#{window_name}|#{pane_index}|#{pane_id}|#{pane_current_command}|#{pane_pid}|#{pane_width}|#{pane_height}|#{pane_active}'
      ]);
      return out.split('\n').filter(Boolean).map(line => {
        const [session, winIdx, winName, paneIdx, paneId, command, pid, width, height, active] = line.split('|');
        return {
          session,
          window: { index: parseInt(winIdx), name: winName },
          pane: { index: parseInt(paneIdx), id: paneId },
          currentCommand: command,
          pid: parseInt(pid),
          size: { width: parseInt(width), height: parseInt(height) },
          active: active === '1',
        };
      });
    } catch {
      return [];
    }
  }

  // ─── Captura de conteúdo ──────────────────────────────────────────

  /**
   * Captura o conteúdo visível de um painel tmux.
   * @param {string} target - identificador do painel (ex: '%0', 'session:0.0')
   * @param {object} options
   * @param {number} options.scrollback - linhas de histórico (0 = só visível)
   */
  async capturePane(target, options = {}) {
    if (!await this._checkTmux()) return null;
    const scrollback = options.scrollback || 0;

    try {
      const args = ['capture-pane', '-p', '-t', target];
      if (scrollback > 0) {
        args.push('-S', `-${scrollback}`);
      }
      const content = await this._exec('tmux', args, 10000);
      return {
        target,
        capturedAt: new Date().toISOString(),
        lines: content.split('\n').length,
        content,
      };
    } catch (err) {
      return { target, error: err.message };
    }
  }

  /**
   * Captura o comando atual de um painel.
   * @param {string} target - identificador do painel
   */
  async getCurrentCommand(target) {
    if (!await this._checkTmux()) return null;
    try {
      const out = await this._exec('tmux', [
        'display-message', '-t', target, '-p',
        '#{pane_current_command}|#{pane_pid}|#{pane_current_path}'
      ]);
      const [command, pid, path] = out.split('|');
      return { command, pid: parseInt(pid), path };
    } catch (err) {
      return { error: err.message };
    }
  }

  // ─── Snapshot completo ────────────────────────────────────────────

  /**
   * Captura snapshot de todos os painéis ativos.
   * Inclui: sessões, painéis, comando atual e conteúdo visível.
   */
  async snapshot(options = {}) {
    const captureContent = options.captureContent !== false;
    const scrollback = options.scrollback || 0;

    if (!await this._checkTmux()) {
      return {
        available: false,
        timestamp: new Date().toISOString(),
        message: 'tmux não disponível neste ambiente',
      };
    }

    const sessions = await this.listSessions();
    const panes = await this.listPanes();

    const panesWithContent = [];
    for (const pane of panes) {
      const entry = { ...pane };
      if (captureContent) {
        const captured = await this.capturePane(pane.pane.id, { scrollback });
        entry.content = captured?.content || null;
        entry.contentLines = captured?.lines || 0;
      }
      panesWithContent.push(entry);
    }

    const snap = {
      available: true,
      timestamp: new Date().toISOString(),
      sessions,
      panes: panesWithContent,
      summary: {
        totalSessions: sessions.length,
        totalPanes: panes.length,
        activePanes: panes.filter(p => p.active).length,
        commands: panes.map(p => ({
          session: p.session,
          window: p.window.name,
          command: p.currentCommand,
          active: p.active,
        })),
      },
    };

    // Salva no histórico
    this._snapshots.push({
      timestamp: snap.timestamp,
      summary: snap.summary,
    });
    if (this._snapshots.length > this._historySize) {
      this._snapshots.shift();
    }

    return snap;
  }

  /** Histórico de snapshots (só sumário, sem conteúdo) */
  history(limit = 50) {
    return this._snapshots.slice(-limit);
  }

  /** Verifica se tmux está disponível */
  async isAvailable() {
    return this._checkTmux();
  }

  toJSON() {
    return {
      available: this._tmuxAvailable,
      snapshots: this._snapshots.length,
      lastSnapshot: this._snapshots[this._snapshots.length - 1] || null,
    };
  }
}

module.exports = Terminal;
