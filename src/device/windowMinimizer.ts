import { execFile } from 'node:child_process';

export type MinimizeOutcome = 'minimized' | 'notFound' | 'noDisplay' | 'unavailable';

const OUTCOME_BY_EXIT_CODE: Record<number, MinimizeOutcome> = { 0: 'minimized', 2: 'notFound', 3: 'noDisplay' };
// The script waits up to 20 s for the window; this only guards against a hung interpreter.
const SCRIPT_TIMEOUT_MS = 30_000;

export interface MinimizeResult {
  outcome: MinimizeOutcome;
  /** Script output, for the log. */
  detail: string;
}

/**
 * Runs the bundled minimizer script. Minimizing is cosmetic, so this never rejects:
 * a missing Python or X display is reported as an outcome instead.
 */
export function minimizeSpotifyWindow(scriptPath: string, pythonCommand = 'python3'): Promise<MinimizeResult> {
  return new Promise((resolve) => {
    // -I keeps Python from importing anything from the working directory or user site-packages.
    execFile(pythonCommand, ['-I', scriptPath], { timeout: SCRIPT_TIMEOUT_MS, shell: false }, (error, stdout, stderr) => {
      const detail = `${stdout}${stderr}`.trim();
      if (!error) {
        resolve({ outcome: 'minimized', detail });
        return;
      }
      const exitCode = typeof error.code === 'number' ? error.code : undefined;
      const outcome = exitCode === undefined ? 'unavailable' : OUTCOME_BY_EXIT_CODE[exitCode] ?? 'unavailable';
      resolve({ outcome, detail: detail || error.message });
    });
  });
}
