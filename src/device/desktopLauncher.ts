import { spawn } from 'node:child_process';

export class DesktopLaunchError extends Error {
  constructor(command: string, cause: string) {
    super(`Could not start the Spotify desktop app with "${command}": ${cause}. Check the "spotifySidebar.desktopCommand" setting.`);
    this.name = 'DesktopLaunchError';
  }
}

/**
 * Starts the Spotify desktop app detached from VS Code, so closing VS Code leaves the music playing.
 * No shell is involved: `command` is executed directly and never interpreted.
 */
export function launchSpotifyDesktop(command: string): Promise<void> {
  const executable = command.trim();
  if (!executable) return Promise.reject(new DesktopLaunchError(command, 'the command is empty'));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { detached: true, stdio: 'ignore', shell: false });
    // "spawn" fires once the process exists; "error" fires instead when the executable is missing.
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', (error) => reject(new DesktopLaunchError(executable, error.message)));
  });
}
