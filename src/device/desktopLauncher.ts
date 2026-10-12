import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { LaunchCandidate } from './desktopLocator.ts';

const SETTING_HINT = 'Set "spotifySidebar.desktopCommand" to the Spotify executable.';

export class DesktopLaunchError extends Error {
  /** True when the executable does not exist, so the next install location is worth trying. */
  readonly isNotFound: boolean;

  constructor(message: string, isNotFound: boolean) {
    super(message);
    this.name = 'DesktopLaunchError';
    this.isNotFound = isNotFound;
  }
}

/**
 * Starts the Spotify desktop app detached from VS Code, so closing VS Code leaves the music playing.
 * No shell is involved: `command` is executed directly and never interpreted.
 */
export function launchSpotifyDesktop(command: string, args: readonly string[] = []): Promise<void> {
  const executable = command.trim();
  if (!executable) return Promise.reject(new DesktopLaunchError(`The Spotify desktop command is empty. ${SETTING_HINT}`, false));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', shell: false });
    // "spawn" fires once the process exists; "error" fires instead when the executable is missing.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      const isNotFound = error.code === 'ENOENT';
      reject(new DesktopLaunchError(`Could not start the Spotify desktop app with "${executable}": ${error.message}. ${SETTING_HINT}`, isNotFound));
    });
  });
}

export interface LaunchFirstOptions {
  fileExists?: (filePath: string) => boolean;
  launch?: (command: string, args: readonly string[]) => Promise<void>;
}

/** Tries each candidate until one starts; a missing executable moves on, any other failure stops. */
export async function launchFirstAvailable(candidates: readonly LaunchCandidate[], options: LaunchFirstOptions = {}): Promise<LaunchCandidate> {
  const fileExists = options.fileExists ?? existsSync;
  const launch = options.launch ?? launchSpotifyDesktop;

  for (const candidate of candidates) {
    if (candidate.requiredPath !== undefined && !fileExists(candidate.requiredPath)) continue;
    try {
      await launch(candidate.command, candidate.args);
      return candidate;
    } catch (error) {
      if (!(error instanceof DesktopLaunchError && error.isNotFound)) throw error;
    }
  }
  const tried = candidates.map((candidate) => candidate.requiredPath ?? candidate.command).join(', ');
  throw new DesktopLaunchError(`Could not find the Spotify desktop app (looked for: ${tried}). ${SETTING_HINT}`, true);
}
