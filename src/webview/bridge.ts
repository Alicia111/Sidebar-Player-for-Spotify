import { SEARCH_KINDS, type SearchKind, type WebviewMessage } from '../shared/protocol.ts';
import { vscodeApi } from './vscodeApi.ts';

export function send(message: WebviewMessage): void {
  vscodeApi.postMessage(message);
}

/** UI state that survives the webview being hidden and recreated. */
export interface PersistedState {
  query: string;
  kind: SearchKind;
}

export function loadState(): PersistedState | undefined {
  const state = vscodeApi.getState() as Partial<PersistedState> | undefined;
  if (typeof state?.query !== 'string' || !SEARCH_KINDS.includes(state.kind as SearchKind)) return undefined;
  return { query: state.query, kind: state.kind as SearchKind };
}

export function saveState(state: PersistedState): void {
  vscodeApi.setState(state);
}
