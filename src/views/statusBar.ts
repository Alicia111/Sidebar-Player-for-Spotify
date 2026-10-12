import * as vscode from 'vscode';
import type { AuthManager } from '../auth/authManager.ts';
import type { PlayerState } from '../state/playerState.ts';

const MAX_LABEL_LENGTH = 40;
// Keep the controls together, just left of the track label.
const BASE_PRIORITY = 100;

export class StatusBarController implements vscode.Disposable {
  private readonly player: PlayerState;
  private readonly auth: AuthManager;
  private readonly previousItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, BASE_PRIORITY + 3);
  private readonly playPauseItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, BASE_PRIORITY + 2);
  private readonly nextItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, BASE_PRIORITY + 1);
  private readonly trackItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, BASE_PRIORITY);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(player: PlayerState, auth: AuthManager) {
    this.player = player;
    this.auth = auth;

    this.previousItem.text = '$(chevron-left)';
    this.previousItem.tooltip = 'Spotify: Previous Track';
    this.previousItem.command = 'spotifySidebar.previous';
    this.nextItem.text = '$(chevron-right)';
    this.nextItem.tooltip = 'Spotify: Next Track';
    this.nextItem.command = 'spotifySidebar.next';
    this.playPauseItem.command = 'spotifySidebar.playPause';
    this.trackItem.command = 'spotifySidebar.nowPlaying.focus';

    this.disposables.push(player.onDidChange(() => this.render()), auth.onDidChangeLoginState(() => this.render()));
    this.render();
  }

  dispose(): void {
    [this.previousItem, this.playPauseItem, this.nextItem, this.trackItem, ...this.disposables].forEach((item) => item.dispose());
  }

  private render(): void {
    const controls = [this.previousItem, this.playPauseItem, this.nextItem, this.trackItem];
    if (!this.auth.isLoggedIn) {
      controls.forEach((item) => item.hide());
      return;
    }

    const view = this.player.view;
    const isPlaying = view?.isPlaying === true;
    this.playPauseItem.text = isPlaying ? '$(debug-pause)' : '$(play)';
    this.playPauseItem.tooltip = isPlaying ? 'Spotify: Pause' : 'Spotify: Play';

    if (view?.track) {
      const label = `${view.track.title} – ${view.track.subtitle}`;
      this.trackItem.text = `$(music) ${truncate(label, MAX_LABEL_LENGTH)}`;
      this.trackItem.tooltip = view.deviceName ? `${label}\nPlaying on ${view.deviceName}` : label;
    } else {
      this.trackItem.text = '$(music) Spotify';
      this.trackItem.tooltip = 'Nothing playing. Click to open the Spotify sidebar.';
    }
    controls.forEach((item) => item.show());
  }
}

function truncate(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}
