'use strict';

const { spawn } = require('child_process');

/**
 * SSHTaskRunner — executa comandos remotos via SSH mediado por tasks.
 *
 * Em vez de port forwarding ou túneis persistentes, cada operação
 * é uma task discreta: cria → executa → retorna resultado → encerra.
 *
 * Segurança:
 *   - Comandos passam por allowlist ou validação
 *   - Timeout rígido por execução
 *   - Output limitado (evita memory bomb)
 *   - Credenciais nunca expostas em logs
 */

const DEFAULT_TIMEOUT = 30000;       // 30s
const MAX_OUTPUT_BYTES = 1024 * 512; // 512KB
const BLOCKED_COMMANDS = [
  'rm -rf /',
  'mkfs',
  'dd if=/dev/',
  ':(){:|:&};:',
  'chmod -R 777 /',
  '> /dev/sda',
];

class SSHTaskRunner {
  /**
   * @param {object} options
   * @param {string} options.host — IP ou hostname
   * @param {string} [options.user] — usuário SSH (default: root)
   * @param {number} [options.port] — porta SSH (default: 22)
   * @param {string} [options.keyPath] — caminho da chave privada
   * @param {number} [options.timeout] — timeout em ms
   * @param {string[]} [options.allowedCommands] — allowlist (vazio = tudo permitido)
   */
  constructor(options = {}) {
    this.host = options.host;
    this.user = options.user || 'root';
    this.port = options.port || 22;
    this.keyPath = options.keyPath;
    this._timeout = options.timeout ?? DEFAULT_TIMEOUT;
    this._allowedCommands = options.allowedCommands || null;
  }

  /**
   * Executa um comando via SSH como task.
   *
   * @param {string} command — comando a executar
   * @param {object} [options]
   * @param {number} [options.timeout] — override de timeout
   * @returns {Promise<{ ok: boolean, stdout: string, stderr: string, exitCode: number, durationMs: number }>}
   */
  async execute(command, options = {}) {
    // Validação de segurança
    const validation = this._validateCommand(command);
    if (!validation.ok) {
      return { ok: false, stdout: '', stderr: validation.error, exitCode: -1, durationMs: 0 };
    }

    const timeout = options.timeout ?? this._timeout;
    const start = Date.now();

    return new Promise((resolve) => {
      const sshArgs = this._buildSSHArgs(command);
      const proc = spawn('ssh', sshArgs, {
        timeout,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let stderr = '';
      let killed = false;

      proc.stdout.on('data', (chunk) => {
        if (stdout.length < MAX_OUTPUT_BYTES) {
          stdout += chunk.toString();
        }
      });

      proc.stderr.on('data', (chunk) => {
        if (stderr.length < MAX_OUTPUT_BYTES) {
          stderr += chunk.toString();
        }
      });

      const timer = setTimeout(() => {
        killed = true;
        proc.kill('SIGKILL');
      }, timeout);

      proc.on('close', (exitCode) => {
        clearTimeout(timer);
        const durationMs = Date.now() - start;

        if (killed) {
          resolve({
            ok: false,
            stdout: stdout.trim(),
            stderr: `Timeout após ${timeout}ms`,
            exitCode: -1,
            durationMs,
          });
        } else {
          resolve({
            ok: exitCode === 0,
            stdout: stdout.trim(),
            stderr: stderr.trim(),
            exitCode: exitCode ?? -1,
            durationMs,
          });
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        resolve({
          ok: false,
          stdout: '',
          stderr: err.message,
          exitCode: -1,
          durationMs: Date.now() - start,
        });
      });
    });
  }

  /**
   * Executa múltiplos comandos em sequência.
   *
   * @param {string[]} commands
   * @param {object} [options] — { stopOnError: true }
   * @returns {Promise<Array>}
   */
  async executeMany(commands, options = {}) {
    const { stopOnError = true } = options;
    const results = [];

    for (const cmd of commands) {
      const result = await this.execute(cmd);
      results.push({ command: cmd, ...result });

      if (!result.ok && stopOnError) break;
    }

    return results;
  }

  /**
   * Testa conectividade SSH.
   * @returns {Promise<{ ok: boolean, latency: number }>}
   */
  async testConnection() {
    const start = Date.now();
    const result = await this.execute('echo ok', { timeout: 10000 });
    return {
      ok: result.ok && result.stdout.includes('ok'),
      latency: Date.now() - start,
    };
  }

  /**
   * @private
   */
  _buildSSHArgs(command) {
    const args = [
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=10',
      '-o', 'BatchMode=yes',
      '-p', String(this.port),
    ];

    if (this.keyPath) {
      args.push('-i', this.keyPath);
    }

    args.push(`${this.user}@${this.host}`, command);
    return args;
  }

  /**
   * @private
   */
  _validateCommand(command) {
    // Check blocklist
    for (const blocked of BLOCKED_COMMANDS) {
      if (command.includes(blocked)) {
        return { ok: false, error: `Comando bloqueado por segurança: contém "${blocked}"` };
      }
    }

    // Check allowlist (se configurada)
    if (this._allowedCommands) {
      const baseCmd = command.split(/\s+/)[0];
      if (!this._allowedCommands.includes(baseCmd)) {
        return { ok: false, error: `Comando "${baseCmd}" não está na allowlist` };
      }
    }

    return { ok: true };
  }

  /**
   * Serializa para JSON (sem expor credenciais).
   */
  toJSON() {
    return {
      host: this.host,
      user: this.user,
      port: this.port,
      hasKey: !!this.keyPath,
      timeout: this._timeout,
      hasAllowlist: !!this._allowedCommands,
    };
  }
}

module.exports = SSHTaskRunner;
