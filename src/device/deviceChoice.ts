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

export interface WaitForDeviceOptions {
  fetchDevices: () => Promise<Device[]>;
  timeoutMs: number;
  intervalMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Stops waiting early, e.g. when the user cancels the progress notification. */
  isCancelled?: () => boolean;
}

/** Polls until a controllable device shows up, preferring a computer (the app we just launched). */
export async function waitForDevice(options: WaitForDeviceOptions): Promise<Device | undefined> {
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const attempts = Math.max(1, Math.ceil(options.timeoutMs / options.intervalMs));

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (options.isCancelled?.()) return undefined;
    const devices = (await options.fetchDevices()).filter(isControllable);
    const computer = devices.find((device) => device.type.toLowerCase() === 'computer');
    if (computer ?? devices[0]) return computer ?? devices[0];
    await sleep(options.intervalMs);
  }
  return undefined;
}
