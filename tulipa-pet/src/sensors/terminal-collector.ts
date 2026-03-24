/**
 * Terminal Collector
 * Fetches tmux terminal state from Tulipa API's /api/terminal endpoints
 * and converts it into sensor-like data that affects the pet.
 *
 * What it provides:
 *   - terminalPanes: number of active panes
 *   - terminalActive: whether someone is actively in the terminal
 *   - terminalCommands: list of current commands running
 *   - terminalMood: positive/negative influence based on what's running
 */

export interface TerminalSensorData {
  terminalAvailable: boolean;
  terminalPanes: number;
  terminalActivePanes: number;
  terminalCommands: string[];
  terminalMoodBoost: number;   // -10 to +10 influence on pet mood
  terminalEnergyDrain: number; // 0-20 drain from many active processes
}

const TULIPA_API_URL = process.env.TULIPA_API_URL || 'http://localhost:3000';

// Commands that make the pet happy (productive/fun)
const POSITIVE_COMMANDS = new Set([
  'npm', 'node', 'python', 'python3', 'go', 'cargo', 'make',
  'git', 'vim', 'nvim', 'nano', 'code', 'docker',
]);

// Commands that indicate testing (extra happy)
const TEST_COMMANDS = new Set([
  'jest', 'mocha', 'pytest', 'vitest',
]);

// Commands that stress the system
const HEAVY_COMMANDS = new Set([
  'ffmpeg', 'webpack', 'esbuild', 'gcc', 'g++', 'rustc', 'javac',
  'tar', 'zip', 'gzip', 'rsync',
]);

export async function collectTerminalSensors(): Promise<TerminalSensorData> {
  const result: TerminalSensorData = {
    terminalAvailable: false,
    terminalPanes: 0,
    terminalActivePanes: 0,
    terminalCommands: [],
    terminalMoodBoost: 0,
    terminalEnergyDrain: 0,
  };

  try {
    const res = await fetch(`${TULIPA_API_URL}/api/terminal/panes`, {
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) return result;

    const data = await res.json() as {
      available: boolean;
      panes: Array<{
        currentCommand: string;
        active: boolean;
        pane: { id: string };
        session: string;
      }>;
    };

    result.terminalAvailable = data.available;
    if (!data.available || !data.panes) return result;

    result.terminalPanes = data.panes.length;
    result.terminalActivePanes = data.panes.filter(p => p.active).length;
    result.terminalCommands = data.panes.map(p => p.currentCommand).filter(Boolean);

    // Analyze commands for mood/energy effects
    let moodBoost = 0;
    let energyDrain = 0;

    for (const cmd of result.terminalCommands) {
      const baseCmd = cmd.split(/\s/)[0].toLowerCase();

      if (TEST_COMMANDS.has(baseCmd) || cmd.includes('test')) {
        moodBoost += 3; // Testing = very happy
      } else if (POSITIVE_COMMANDS.has(baseCmd)) {
        moodBoost += 1; // Productive work
      }

      if (HEAVY_COMMANDS.has(baseCmd)) {
        energyDrain += 3; // Heavy processing
      }
    }

    // Many panes = busy environment
    if (result.terminalPanes > 5) {
      energyDrain += (result.terminalPanes - 5) * 2;
    }

    // No active panes = nobody around
    if (result.terminalPanes === 0) {
      moodBoost -= 2; // Lonely
    }

    // Someone actively using terminal = social boost
    if (result.terminalActivePanes > 0) {
      moodBoost += 2;
    }

    result.terminalMoodBoost = Math.max(-10, Math.min(10, moodBoost));
    result.terminalEnergyDrain = Math.max(0, Math.min(20, energyDrain));

    return result;
  } catch {
    return result;
  }
}
