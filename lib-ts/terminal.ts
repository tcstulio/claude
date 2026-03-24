// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.

import { execFile } from 'node:child_process';

export interface TerminalOptions {
  historySize?: number;
}

export interface TmuxSession {
  id: string;
  name: string;
  windows: number;
  attached: boolean;
  created: string;
}

export interface TmuxPane {
  session: string;
  window: { index: number; name: string };
  pane: { index: number; id: string };
  currentCommand: string;
  pid: number;
  size: { width: number; height: number };
  active: boolean;
}

export interface CaptureResult {
  target: string;
  capturedAt?: string;
  lines?: number;
  content?: string;
  error?: string;
}

export interface CurrentCommandResult {
  command?: string;
  pid?: number;
  path?: string;
  error?: string;
}

export interface CaptureOptions {
  scrollback?: number;
}

export interface SnapshotOptions {
  captureContent?: boolean;
  scrollback?: number;
}

export interface PaneWithContent extends TmuxPane {
  content?: string | null;
  contentLines?: number;
}

export interface CommandSummary {
  session: string;
  window: string;
  command: string;
  active: boolean;
}

export interface Snapshot {
  available: boolean;
  timestamp: string;
  message?: string;
  sessions?: TmuxSession[];
  panes?: PaneWithContent[];
  summary?: {
    totalSessions: number;
    totalPanes: number;
    activePanes: number;
    commands: CommandSummary[];
  };
}

export interface SnapshotHistoryEntry {
  timestamp: string;
  summary: Snapshot['summary'];
}

export interface TerminalJSON {
  available: boolean | null;
  snapshots: number;
  lastSnapshot: SnapshotHistoryEntry | null;
}

export default class Terminal {
  private _tmuxAvailable: boolean | null;
  private _historySize: number;
  private _snapshots: SnapshotHistoryEntry[];

  constructor(options: TerminalOptions = {}) {
    this._tmuxAvailable = null;
    this._historySize = options.historySize || 100;
    this._snapshots = [];
  }

  private _exec(cmd: string, args: string[] = [], timeout: number = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, { timeout }, (err, stdout) => {
        if (err) return reject(err);
        resolve(stdout.trim());
      });
    });
  }

  private async _checkTmux(): Promise<boolean> {
    if (this._tmuxAvailable !== null) return this._tmuxAvailable;
    try {
      await this._exec('tmux', ['list-sessions']);
      this._tmuxAvailable = true;
    } catch {
      this._tmuxAvailable = false;
    }
    return this._tmuxAvailable;
  }

  async listSessions(): Promise<TmuxSession[]> {
    if (!await this._checkTmux()) return [];
    try {
      const out = await this._exec('tmux', [
        'list-sessions', '-F',
        '#{session_id}|#{session_name}|#{session_windows}|#{session_attached}|#{session_created}',
      ]);
      return out.split('\n').filter(Boolean).map(line => {
        const [id, name, windows, attached, created] = line.split('|');
        return {
          id,
          name,
          windows: parseInt(windows) || 0,
          attached: attached === '1',
          created: new Date(parseInt(created) * 1000).toISOString(),
        };
      });
    } catch {
      return [];
    }
  }

  async listPanes(): Promise<TmuxPane[]> {
    if (!await this._checkTmux()) return [];
    try {
      const out = await this._exec('tmux', [
        'list-panes', '-a', '-F',
        '#{session_name}|#{window_index}|#{window_name}|#{pane_index}|#{pane_id}|#{pane_current_command}|#{pane_pid}|#{pane_width}|#{pane_height}|#{pane_active}',
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

  async capturePane(target: string, options: CaptureOptions = {}): Promise<CaptureResult> {
    if (!await this._checkTmux()) return { target, error: 'tmux not available' };
    const scrollback = options.scrollback || 0;
    try {
      const args = ['capture-pane', '-p', '-t', target];
      if (scrollback > 0) args.push('-S', `-${scrollback}`);
      const content = await this._exec('tmux', args, 10000);
      return {
        target,
        capturedAt: new Date().toISOString(),
        lines: content.split('\n').length,
        content,
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { target, error: message };
    }
  }

  async getCurrentCommand(target: string): Promise<CurrentCommandResult | null> {
    if (!await this._checkTmux()) return null;
    try {
      const out = await this._exec('tmux', [
        'display-message', '-t', target, '-p',
        '#{pane_current_command}|#{pane_pid}|#{pane_current_path}',
      ]);
      const [command, pid, path] = out.split('|');
      return { command, pid: parseInt(pid), path };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return { error: message };
    }
  }

  async snapshot(options: SnapshotOptions = {}): Promise<Snapshot> {
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
    const panesWithContent: PaneWithContent[] = [];

    for (const pane of panes) {
      const entry: PaneWithContent = { ...pane };
      if (captureContent) {
        const captured = await this.capturePane(pane.pane.id, { scrollback });
        entry.content = captured?.content || null;
        entry.contentLines = captured?.lines || 0;
      }
      panesWithContent.push(entry);
    }

    const snap: Snapshot = {
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

    this._snapshots.push({ timestamp: snap.timestamp, summary: snap.summary });
    if (this._snapshots.length > this._historySize) this._snapshots.shift();

    return snap;
  }

  history(limit: number = 50): SnapshotHistoryEntry[] {
    return this._snapshots.slice(-limit);
  }

  async isAvailable(): Promise<boolean> {
    return this._checkTmux();
  }

  toJSON(): TerminalJSON {
    return {
      available: this._tmuxAvailable,
      snapshots: this._snapshots.length,
      lastSnapshot: this._snapshots[this._snapshots.length - 1] || null,
    };
  }
}
