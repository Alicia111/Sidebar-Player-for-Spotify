import * as vscode from 'vscode';
import { describeError, deviceIconId, type SpotifyActions } from '../actions.ts';
import type { SpotifyApi } from '../api/endpoints.ts';
import type { Device } from '../api/types.ts';

export type DeviceTreeNode = { kind: 'device'; device: Device } | { kind: 'message'; text: string; tooltip?: string };

export class DeviceTreeProvider implements vscode.TreeDataProvider<DeviceTreeNode>, vscode.Disposable {
  private readonly api: SpotifyApi;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [];

  readonly onDidChangeTreeData = this.changeEmitter.event;

  constructor(api: SpotifyApi, actions: SpotifyActions) {
    this.api = api;
    this.disposables.push(actions.onDidChangeDevices(() => this.refresh()));
  }

  refresh(): void {
    this.changeEmitter.fire();
  }

  getTreeItem(node: DeviceTreeNode): vscode.TreeItem {
    if (node.kind === 'message') {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon('info');
      item.tooltip = node.tooltip;
      return item;
    }
    const { device } = node;
    const item = new vscode.TreeItem(device.name);
    item.id = device.id ?? device.name;
    item.iconPath = new vscode.ThemeIcon(deviceIconId(device), device.is_active ? new vscode.ThemeColor('charts.green') : undefined);
    item.description = [device.is_active ? 'active' : device.type, device.volume_percent !== null ? `${device.volume_percent}%` : undefined]
      .filter(Boolean)
      .join(' · ');
    item.tooltip = device.is_restricted ? `${device.name} (cannot be controlled through the Web API)` : `Play on ${device.name}`;
    item.contextValue = device.is_restricted || device.is_active ? 'device-unavailable' : 'device';
    if (!device.is_restricted && !device.is_active) {
      item.command = { command: 'spotifySidebar.transferToDevice', title: 'Play on This Device', arguments: [node] };
    }
    return item;
  }

  async getChildren(node?: DeviceTreeNode): Promise<DeviceTreeNode[]> {
    if (node) return [];
    try {
      const devices = await this.api.getDevices();
      if (devices.length === 0) {
        return [{ kind: 'message', text: 'No devices. Open Spotify somewhere, then refresh.' }];
      }
      return devices.map((device) => ({ kind: 'device', device }));
    } catch (error) {
      return [{ kind: 'message', text: 'Could not load devices', tooltip: describeError(error) }];
    }
  }

  dispose(): void {
    this.changeEmitter.dispose();
    this.disposables.forEach((disposable) => disposable.dispose());
  }
}
