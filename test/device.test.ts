import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Device } from '../src/api/types.ts';
import { DesktopLaunchError, launchFirstAvailable, launchSpotifyDesktop } from '../src/device/desktopLauncher.ts';
import { customLaunchCandidate, listLaunchCandidates, type LaunchCandidate } from '../src/device/desktopLocator.ts';
import { chooseDevice, isLaunchedLocalDevice, isThisComputer, waitForDevice } from '../src/device/deviceChoice.ts';

function device(overrides: Partial<Device> & { id: string | null; name: string }): Device {
  return { type: 'Computer', is_active: false, is_restricted: false, volume_percent: 50, ...overrides };
}

const laptop = device({ id: 'laptop', name: 'Laptop' });
const phone = device({ id: 'phone', name: 'Phone', type: 'Smartphone' });

describe('chooseDevice', () => {
  it('uses the active device', () => {
    const activePhone = { ...phone, is_active: true };
    assert.deepEqual(chooseDevice([laptop, activePhone], 'laptop'), { kind: 'use', device: activePhone });
  });

  it('falls back to the last used device', () => {
    assert.deepEqual(chooseDevice([laptop, phone], 'phone'), { kind: 'use', device: phone });
  });

  it('uses the only device without asking', () => {
    assert.deepEqual(chooseDevice([laptop], undefined), { kind: 'use', device: laptop });
  });

  it('asks when several devices are equally likely', () => {
    assert.deepEqual(chooseDevice([laptop, phone], 'gone'), { kind: 'ask', devices: [laptop, phone] });
  });

  it('ignores restricted devices and devices without an id', () => {
    const restricted = device({ id: 'speaker', name: 'Speaker', is_restricted: true });
    const anonymous = device({ id: null, name: 'Anonymous' });
    assert.deepEqual(chooseDevice([restricted, anonymous], 'speaker'), { kind: 'none' });
  });
});

describe('waitForDevice', () => {
  it('polls until a device appears, preferring a computer', async () => {
    const responses: Device[][] = [[], [], [phone, laptop]];
    const sleeps: number[] = [];
    const found = await waitForDevice({
      fetchDevices: async () => responses.shift() ?? [],
      timeoutMs: 10_000,
      intervalMs: 1000,
      sleep: async (ms) => void sleeps.push(ms),
    });
    assert.equal(found, laptop);
    assert.deepEqual(sleeps, [1000, 1000]);
  });

  it('gives up after the timeout', async () => {
    let calls = 0;
    const found = await waitForDevice({
      fetchDevices: async () => (calls++, []),
      timeoutMs: 3000,
      intervalMs: 1000,
      sleep: async () => undefined,
    });
    assert.equal(found, undefined);
    assert.equal(calls, 3);
  });

  it('stops when cancelled', async () => {
    let calls = 0;
    const found = await waitForDevice({
      fetchDevices: async () => (calls++, []),
      timeoutMs: 10_000,
      intervalMs: 1000,
      sleep: async () => undefined,
      isCancelled: () => calls >= 1,
    });
    assert.equal(found, undefined);
    assert.equal(calls, 1);
  });
});

describe('launchSpotifyDesktop', () => {
  it('rejects an empty command', async () => {
    await assert.rejects(launchSpotifyDesktop('   '), DesktopLaunchError);
  });

  it('rejects a missing executable with a helpful error', async () => {
    await assert.rejects(launchSpotifyDesktop('/nonexistent/spotify-binary'), (error: unknown) => {
      assert.ok(error instanceof DesktopLaunchError);
      assert.match(error.message, /spotifySidebar\.desktopCommand/);
      assert.equal(error.isNotFound, true);
      return true;
    });
  });

  it('does not interpret shell syntax in the command', async () => {
    // With a shell this would run `true`; without one it is just a missing file name.
    await assert.rejects(launchSpotifyDesktop('true; echo injected'), DesktopLaunchError);
  });
});

describe('listLaunchCandidates', () => {
  it('searches PATH, Snap and both Flatpak scopes on Linux', () => {
    const commands = listLaunchCandidates({ platform: 'linux', env: {}, homeDir: '/home/neko' }, true).map((candidate) => candidate.command);
    assert.deepEqual(commands, [
      'spotify',
      '/snap/bin/spotify',
      '/var/lib/flatpak/exports/bin/com.spotify.Client',
      '/home/neko/.local/share/flatpak/exports/bin/com.spotify.Client',
    ]);
  });

  it('opens the app bundle through `open` on macOS, in the background when minimizing', () => {
    const candidates = listLaunchCandidates({ platform: 'darwin', env: {}, homeDir: '/Users/neko' }, true);
    assert.deepEqual(candidates, [
      { command: '/usr/bin/open', args: ['-g', '/Applications/Spotify.app'], requiredPath: '/Applications/Spotify.app' },
      { command: '/usr/bin/open', args: ['-g', '/Users/neko/Applications/Spotify.app'], requiredPath: '/Users/neko/Applications/Spotify.app' },
    ]);
  });

  it('tries the installer, then the Store alias, then PATH on Windows', () => {
    const env = { APPDATA: 'C:\\Users\\neko\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\neko\\AppData\\Local' };
    const candidates = listLaunchCandidates({ platform: 'win32', env, homeDir: 'C:\\Users\\neko' }, true);
    assert.deepEqual(candidates, [
      { command: 'C:\\Users\\neko\\AppData\\Roaming\\Spotify\\Spotify.exe', args: ['--minimized'] },
      { command: 'C:\\Users\\neko\\AppData\\Local\\Microsoft\\WindowsApps\\Spotify.exe', args: ['--minimized'] },
      { command: 'spotify', args: ['--minimized'] },
    ]);
  });

  it('skips Windows locations whose environment variables are missing', () => {
    const candidates = listLaunchCandidates({ platform: 'win32', env: {}, homeDir: 'C:\\Users\\neko' }, false);
    assert.deepEqual(candidates, [{ command: 'spotify', args: [] }]);
  });
});

describe('customLaunchCandidate', () => {
  it('adds --minimized only on Windows', () => {
    assert.deepEqual(customLaunchCandidate('C:\\Spotify.exe', 'win32', true), { command: 'C:\\Spotify.exe', args: ['--minimized'] });
    assert.deepEqual(customLaunchCandidate('/opt/spotify/spotify', 'linux', true), { command: '/opt/spotify/spotify', args: [] });
  });
});

describe('launchFirstAvailable', () => {
  const notFound = (command: string) => new DesktopLaunchError(`${command} is missing`, true);

  it('moves past missing executables and returns the one that started', async () => {
    const attempts: string[] = [];
    const candidates: LaunchCandidate[] = [{ command: 'spotify', args: [] }, { command: '/snap/bin/spotify', args: [] }];
    const launched = await launchFirstAvailable(candidates, {
      launch: async (command) => {
        attempts.push(command);
        if (command === 'spotify') throw notFound(command);
      },
    });
    assert.deepEqual(attempts, ['spotify', '/snap/bin/spotify']);
    assert.equal(launched.command, '/snap/bin/spotify');
  });

  it('skips candidates whose required bundle does not exist', async () => {
    const attempts: string[] = [];
    const candidates: LaunchCandidate[] = [
      { command: 'open', args: ['/Applications/Spotify.app'], requiredPath: '/Applications/Spotify.app' },
      { command: 'open', args: ['/Users/neko/Applications/Spotify.app'], requiredPath: '/Users/neko/Applications/Spotify.app' },
    ];
    await launchFirstAvailable(candidates, {
      fileExists: (filePath) => filePath.startsWith('/Users/'),
      launch: async (_command, args) => void attempts.push(args[0]),
    });
    assert.deepEqual(attempts, ['/Users/neko/Applications/Spotify.app']);
  });

  it('stops at a failure other than a missing executable', async () => {
    const candidates: LaunchCandidate[] = [{ command: 'spotify', args: [] }, { command: '/snap/bin/spotify', args: [] }];
    const permissionDenied = new DesktopLaunchError('EACCES', false);
    await assert.rejects(
      launchFirstAvailable(candidates, { launch: () => Promise.reject(permissionDenied) }),
      (error: unknown) => error === permissionDenied,
    );
  });

  it('lists every place it looked when nothing is installed', async () => {
    const candidates: LaunchCandidate[] = [
      { command: 'spotify', args: [] },
      { command: 'open', args: ['/Applications/Spotify.app'], requiredPath: '/Applications/Spotify.app' },
    ];
    await assert.rejects(
      launchFirstAvailable(candidates, { fileExists: () => false, launch: (command) => Promise.reject(notFound(command)) }),
      (error: unknown) => {
        assert.ok(error instanceof DesktopLaunchError);
        assert.match(error.message, /looked for: spotify, \/Applications\/Spotify\.app/);
        assert.match(error.message, /spotifySidebar\.desktopCommand/);
        return true;
      },
    );
  });
});

describe('isThisComputer', () => {
  it('matches the desktop device named after this host, however each OS formats it', () => {
    assert.equal(isThisComputer(device({ id: 'l', name: 'Nekolia-notebook' }), 'Nekolia-notebook'), true);
    assert.equal(isThisComputer(device({ id: 'm', name: "Alicia's MacBook Air" }), 'Alicias-MacBook-Air.local'), true);
    assert.equal(isThisComputer(device({ id: 'w', name: 'NEKOLIA-PC' }), 'nekolia-pc'), true);
  });

  it('rejects other computers and non-computers with the same name', () => {
    assert.equal(isThisComputer(device({ id: 'o', name: 'Office-PC' }), 'Nekolia-notebook'), false);
    assert.equal(isThisComputer(device({ id: 'p', name: 'Nekolia-notebook', type: 'Smartphone' }), 'Nekolia-notebook'), false);
  });
});

describe('isLaunchedLocalDevice', () => {
  const before = new Set(['phone', 'office']);

  it('falls back to a computer that was not online before the launch', () => {
    assert.equal(isLaunchedLocalDevice(device({ id: 'renamed', name: 'My Spotify' }), 'Nekolia-notebook', before), true);
  });

  it('ignores devices that were already online', () => {
    assert.equal(isLaunchedLocalDevice(device({ id: 'office', name: 'Office-PC' }), 'Nekolia-notebook', before), false);
    assert.equal(isLaunchedLocalDevice({ ...phone }, 'Nekolia-notebook', before), false);
  });
});

describe('waitForDevice with accept', () => {
  it('keeps waiting past an online phone until the accepted device appears', async () => {
    const responses: Device[][] = [[phone], [phone], [phone, laptop]];
    const found = await waitForDevice({
      fetchDevices: async () => responses.shift() ?? [],
      timeoutMs: 10_000,
      intervalMs: 1000,
      sleep: async () => undefined,
      accept: (candidate) => candidate.id === 'laptop',
    });
    assert.equal(found, laptop);
  });
});
