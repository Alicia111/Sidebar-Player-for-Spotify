import { setTimeout as delay } from 'node:timers/promises';
import type { Device } from '../api/types.ts';

export type DeviceChoice =
  | { kind: 'use'; device: Device }
  | { kind: 'ask'; devices: Device[] }
  | { kind: 'none' };

export function isControllable(device: Device): boolean {
  return device.id !== null && !device.is_restricted;
}

/**
 * Picks a device without bothering the user when the answer is obvious:
 * the active one, then the last one used, then the only one available.
 */
export function chooseDevice(devices: Device[], lastDeviceId: string | undefined): DeviceChoice {
  const controllable = devices.filter(isControllable);
  if (controllable.length === 0) return { kind: 'none' };

  const active = controllable.find((device) => device.is_active);
  if (active) return { kind: 'use', device: active };

  const lastUsed = controllable.find((device) => device.id === lastDeviceId);
  if (lastUsed) return { kind: 'use', device: lastUsed };

  if (controllable.length === 1) return { kind: 'use', device: controllable[0] };
  return { kind: 'ask', devices: controllable };
}

/**
 * Spotify names the desktop app's device after the computer, but the format differs from the hostname
 * ("Alicia's MacBook Air" vs "Alicias-MacBook-Air.local"), so names are compared loosely.
 */
export function isThisComputer(device: Device, hostname: string): boolean {
  return device.type.toLowerCase() === 'computer' && normalizeDeviceName(device.name) === normalizeDeviceName(hostname);
}

/** After launching the local app: this computer by name, or else a computer that was not online before the launch. */
export function isLaunchedLocalDevice(device: Device, hostname: string, idsBeforeLaunch: ReadonlySet<string>): boolean {
  if (isThisComputer(device, hostname)) return true;
  return device.type.toLowerCase() === 'computer' && device.id !== null && !idsBeforeLaunch.has(device.id);
}

function normalizeDeviceName(name: string): string {
  return name.toLowerCase().replace(/\.local$/, '').replace(/[^\p{L}\p{N}]/gu, '');
}

export interface WaitForDeviceOptions {
  fetchDevices: () => Promise<Device[]>;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Stops waiting early, e.g. when the user cancels the progress notification. */
  isCancelled?: () => boolean;
  /** Only this device will do, e.g. the local app while a phone is already online. */
  accept?: (device: Device) => boolean;
}

/** Polls until a controllable device shows up: one `accept` approves, or else preferably a computer. */
export async function waitForDevice(options: WaitForDeviceOptions): Promise<Device | undefined> {
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.intervalMs));

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.isCancelled?.()) return undefined;
    const devices = (await options.fetchDevices()).filter(isControllable);
    const found = options.accept ? devices.find(options.accept) : preferComputer(devices);
    if (found) return found;
    await sleep(options.intervalMs);
  }
  return undefined;
}

function preferComputer(devices: Device[]): Device | undefined {
  return devices.find((device) => device.type.toLowerCase() === 'computer') ?? devices[0];
}
