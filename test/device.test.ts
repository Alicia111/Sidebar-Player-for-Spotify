import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Device } from '../src/api/types.ts';
import { DesktopLaunchError, launchSpotifyDesktop } from '../src/device/desktopLauncher.ts';
import { chooseDevice, waitForDevice } from '../src/device/deviceChoice.ts';

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
      return true;
    });
  });

  it('does not interpret shell syntax in the command', async () => {
    // With a shell this would run `true`; without one it is just a missing file name.
    await assert.rejects(launchSpotifyDesktop('true; echo injected'), DesktopLaunchError);
  });
});
