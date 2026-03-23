/**
 * File Watcher — Auto-reload para o pet.
 *
 * Monitora mudanças em src/ e:
 * - Arquivos .ts → rebuild (tsc) + restart do pet
 * - Arquivos em web/ → copia direto para dist/web/ (hot update)
 *
 * Usa fs.watch nativo (sem deps extras).
 */

import { watch, copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'fs';
import { join, relative, extname, dirname } from 'path';
import { execSync } from 'child_process';
import { EventEmitter } from 'events';

export interface FileWatcherOptions {
  srcDir: string;
  distDir: string;
  debounceMs?: number;
  autoBuild?: boolean;
}

export class FileWatcher extends EventEmitter {
  private srcDir: string;
  private distDir: string;
  private debounceMs: number;
  private autoBuild: boolean;
  private watchers: ReturnType<typeof watch>[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingChanges: Set<string> = new Set();

  constructor(options: FileWatcherOptions) {
    super();
    this.srcDir = options.srcDir;
    this.distDir = options.distDir;
    this.debounceMs = options.debounceMs ?? 2000;
    this.autoBuild = options.autoBuild ?? true;
  }

  start(): void {
    if (!existsSync(this.srcDir)) {
      console.log(`📂 FileWatcher: src dir not found (${this.srcDir}), skipping`);
      return;
    }

    this.watchDirectory(this.srcDir);
    console.log(`📂 FileWatcher started (watching ${this.srcDir})`);
  }

  stop(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    console.log('📂 FileWatcher stopped');
  }

  private watchDirectory(dir: string): void {
    try {
      const watcher = watch(dir, { recursive: false }, (eventType, filename) => {
        if (!filename) return;
        const fullPath = join(dir, filename);
        this.handleChange(fullPath);
      });
      this.watchers.push(watcher);

      // Watch subdirectories
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory() && entry !== 'node_modules' && entry !== 'dist') {
            this.watchDirectory(full);
          }
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.error(`📂 FileWatcher: error watching ${dir}:`, (err as Error).message);
    }
  }

  private handleChange(filePath: string): void {
    const rel = relative(this.srcDir, filePath);
    const ext = extname(filePath);

    // Ignore non-relevant files
    if (ext !== '.ts' && ext !== '.html' && ext !== '.css' && ext !== '.js') return;
    if (rel.includes('node_modules') || rel.includes('.git')) return;

    this.pendingChanges.add(rel);

    // Debounce to batch rapid changes
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.processChanges(), this.debounceMs);
  }

  private processChanges(): void {
    const changes = Array.from(this.pendingChanges);
    this.pendingChanges.clear();

    if (changes.length === 0) return;

    const webChanges = changes.filter(f => f.startsWith('web/'));
    const tsChanges = changes.filter(f => f.endsWith('.ts'));

    // Web assets: hot copy (no restart needed)
    for (const webFile of webChanges) {
      this.hotCopyWeb(webFile);
    }

    // TypeScript changes: rebuild + signal restart
    if (tsChanges.length > 0 && this.autoBuild) {
      this.rebuild(tsChanges);
    }
  }

  private hotCopyWeb(relPath: string): void {
    const src = join(this.srcDir, relPath);
    const dest = join(this.distDir, relPath);

    try {
      const destDir = dirname(dest);
      if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
      copyFileSync(src, dest);
      console.log(`📂 Hot copied: ${relPath}`);
      this.emit('hot-update', { file: relPath, type: 'web' });
    } catch (err) {
      console.error(`📂 Failed to copy ${relPath}:`, (err as Error).message);
    }
  }

  private rebuild(changedFiles: string[]): void {
    console.log(`📂 Rebuilding (${changedFiles.length} files changed: ${changedFiles.join(', ')})`);
    this.emit('build-start', { files: changedFiles });

    try {
      const projectRoot = join(this.srcDir, '..');
      execSync('npx tsc --noEmit 2>&1', { cwd: projectRoot, timeout: 30_000, encoding: 'utf-8' });

      // Type check passed, do the actual build
      execSync('npx tsc 2>&1', { cwd: projectRoot, timeout: 30_000, encoding: 'utf-8' });

      // Copy web assets after build
      this.syncWebAssets();

      console.log('📂 Build succeeded');
      this.emit('build-success', { files: changedFiles });

      // Signal that a restart is needed
      this.emit('restart-needed', { reason: 'rebuild', files: changedFiles });
    } catch (err) {
      const msg = (err as { stdout?: string; message: string }).stdout || (err as Error).message;
      console.error('📂 Build failed:', msg.slice(0, 500));
      this.emit('build-error', { error: msg, files: changedFiles });
    }
  }

  private syncWebAssets(): void {
    const webSrc = join(this.srcDir, 'web');
    const webDist = join(this.distDir, 'web');

    if (!existsSync(webSrc)) return;
    if (!existsSync(webDist)) mkdirSync(webDist, { recursive: true });

    try {
      for (const file of readdirSync(webSrc)) {
        copyFileSync(join(webSrc, file), join(webDist, file));
      }
    } catch { /* ignore */ }
  }
}
