// © 2026 Tulio Silva — Tulipa Platform. Proprietary and confidential.
// SSHTaskRunner — execute remote commands via SSH as discrete tasks.

import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT = 30000;
const MAX_OUTPUT_BYTES = 1024 * 512;
const BLOCKED_COMMANDS = ["rm -rf /", "mkfs", "dd if=/dev/", ":(){:|:&};:", "chmod -R 777 /", "> /dev/sda"];

export interface SSHResult { ok: boolean; stdout: string; stderr: string; exitCode: number; durationMs: number; }

export class SSHTaskRunner {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly keyPath: string | undefined;
  private _timeout: number;
  private _allowedCommands: string[] | null;

  constructor(options: { host: string; user?: string; port?: number; keyPath?: string; timeout?: number; allowedCommands?: string[] }) {
    this.host = options.host;
    this.user = options.user ?? "root";
    this.port = options.port ?? 22;
    this.keyPath = options.keyPath;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._allowedCommands = options.allowedCommands ?? null;
  }

  async execute(command: string, options: { timeout?: number } = {}): Promise<SSHResult> {
    const validation = this._validate(command);
    if (!validation.ok) return { ok: false, stdout: "", stderr: validation.error!, exitCode: -1, durationMs: 0 };
    const timeout = options.timeout ?? this._timeout;
    const start = Date.now();
    return new Promise(resolve => {
      const proc = spawn("ssh", this._buildArgs(command), { timeout, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "", stderr = "", killed = false;
      proc.stdout.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString(); });
      proc.stderr.on("data", (chunk: Buffer) => { if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString(); });
      const timer = setTimeout(() => { killed = true; proc.kill("SIGKILL"); }, timeout);
      proc.on("close", (exitCode) => { clearTimeout(timer); const d = Date.now() - start; resolve(killed ? { ok: false, stdout: stdout.trim(), stderr: `Timeout after ${timeout}ms`, exitCode: -1, durationMs: d } : { ok: exitCode === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: exitCode ?? -1, durationMs: d }); });
      proc.on("error", (err: Error) => { clearTimeout(timer); resolve({ ok: false, stdout: "", stderr: err.message, exitCode: -1, durationMs: Date.now() - start }); });
    });
  }

  async executeMany(commands: string[], options: { stopOnError?: boolean } = {}): Promise<Array<{ command: string } & SSHResult>> {
    const results: Array<{ command: string } & SSHResult> = [];
    for (const cmd of commands) { const r = await this.execute(cmd); results.push({ command: cmd, ...r }); if (!r.ok && (options.stopOnError ?? true)) break; }
    return results;
  }

  async testConnection(): Promise<{ ok: boolean; latency: number }> {
    const start = Date.now();
    const r = await this.execute("echo ok", { timeout: 10000 });
    return { ok: r.ok && r.stdout.includes("ok"), latency: Date.now() - start };
  }

  private _buildArgs(command: string): string[] {
    const args = ["-o", "StrictHostKeyChecking=accept-new", "-o", "ConnectTimeout=10", "-o", "BatchMode=yes", "-p", String(this.port)];
    if (this.keyPath) args.push("-i", this.keyPath);
    args.push(`${this.user}@${this.host}`, command);
    return args;
  }

  private _validate(command: string): { ok: boolean; error?: string } {
    for (const b of BLOCKED_COMMANDS) { if (command.includes(b)) return { ok: false, error: `Blocked command: contains "${b}"` }; }
    if (this._allowedCommands) { const base = command.split(/\s+/)[0]; if (!this._allowedCommands.includes(base)) return { ok: false, error: `Command "${base}" not in allowlist` }; }
    return { ok: true };
  }

  toJSON() { return { host: this.host, user: this.user, port: this.port, hasKey: !!this.keyPath, timeout: this._timeout, hasAllowlist: !!this._allowedCommands }; }
}
