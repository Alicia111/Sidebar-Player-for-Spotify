interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

/** VS Code allows `acquireVsCodeApi()` only once per webview, so every module in a bundle shares this handle. */
export const vscodeApi = acquireVsCodeApi();
