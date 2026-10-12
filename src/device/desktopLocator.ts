import * as path from 'node:path';

/** One way to start the Spotify desktop app; candidates are tried in order until one starts. */
export interface LaunchCandidate {
  command: string;
  args: string[];
  /** Skip this candidate unless this file or app bundle exists (for launchers like `open` that always exist). */
  requiredPath?: string;
}

export interface LocatorEnvironment {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  homeDir: string;
}

// Spotify honours --minimized only on Windows.
const WINDOWS_MINIMIZED_ARGS = ['--minimized'];
const MAC_OPEN_COMMAND = '/usr/bin/open';
// `open -g` keeps the launched app in the background; macOS has no "start minimized" for Spotify.
const MAC_BACKGROUND_ARGS = ['-g'];

/** The command the user configured, with the platform's minimize flag where Spotify supports one. */
export function customLaunchCandidate(command: string, platform: NodeJS.Platform, shouldMinimize: boolean): LaunchCandidate {
  return { command, args: platform === 'win32' && shouldMinimize ? [...WINDOWS_MINIMIZED_ARGS] : [] };
}

/** Where the official installers, package managers and stores put Spotify, most common first. */
export function listLaunchCandidates(environment: LocatorEnvironment, shouldMinimize: boolean): LaunchCandidate[] {
  switch (environment.platform) {
    case 'win32':
      return windowsCandidates(environment.env, shouldMinimize);
    case 'darwin':
      return macCandidates(environment.homeDir, shouldMinimize);
    default:
      return linuxCandidates(environment.homeDir);
  }
}

function linuxCandidates(homeDir: string): LaunchCandidate[] {
  return [
    'spotify', // deb/rpm/AUR packages, or anything else on PATH
    '/snap/bin/spotify',
    '/var/lib/flatpak/exports/bin/com.spotify.Client',
    path.posix.join(homeDir, '.local/share/flatpak/exports/bin/com.spotify.Client'),
  ].map((command) => ({ command, args: [] }));
}

function macCandidates(homeDir: string, shouldMinimize: boolean): LaunchCandidate[] {
  const bundles = ['/Applications/Spotify.app', path.posix.join(homeDir, 'Applications/Spotify.app')];
  // Going through `open` lets macOS start the bundle the normal way (Dock icon, single instance).
  return bundles.map((bundle) => ({
    command: MAC_OPEN_COMMAND,
    args: [...(shouldMinimize ? MAC_BACKGROUND_ARGS : []), bundle],
    requiredPath: bundle,
  }));
}

function windowsCandidates(env: Record<string, string | undefined>, shouldMinimize: boolean): LaunchCandidate[] {
  const commands = [
    // Installer from spotify.com.
    env.APPDATA && path.win32.join(env.APPDATA, 'Spotify', 'Spotify.exe'),
    // Microsoft Store install, reached through its app execution alias.
    env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'Spotify.exe'),
    'spotify',
  ].filter((command): command is string => Boolean(command));
  return commands.map((command) => ({ command, args: shouldMinimize ? [...WINDOWS_MINIMIZED_ARGS] : [] }));
}
