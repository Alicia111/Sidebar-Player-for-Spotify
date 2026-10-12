import { createServer, type ServerResponse } from 'node:http';

export const CALLBACK_PATH = '/callback';
const LOOPBACK_HOST = '127.0.0.1';

export function buildRedirectUri(port: number): string {
  return `http://${LOOPBACK_HOST}:${port}${CALLBACK_PATH}`;
}

/** `foreign` means the request did not come from our authorization redirect and must not affect the login. */
export type CallbackResult = { ok: true; code: string } | { ok: false; reason: string } | { foreign: true };

export function parseCallback(params: URLSearchParams, expectedState: string): CallbackResult {
  if (params.get('state') !== expectedState) {
    return { foreign: true };
  }
  const deniedReason = params.get('error');
  if (deniedReason) {
    return { ok: false, reason: `Spotify returned "${deniedReason}"` };
  }
  const code = params.get('code');
  if (!code) {
    return { ok: false, reason: 'callback has no authorization code' };
  }
  return { ok: true, code };
}

export class LoginCancelledError extends Error {
  constructor() {
    super('Spotify login was cancelled');
    this.name = 'LoginCancelledError';
  }
}

export interface AuthCodeListener {
  /** Settles once with the authorization code, or rejects on denial, timeout or cancellation. */
  readonly code: Promise<string>;
  dispose(): void;
}

export interface ListenOptions {
  port: number;
  expectedState: string;
  timeoutMs: number;
}

/** Resolves once the server is listening, so the browser is only opened when the callback can be received. */
export function listenForAuthCode(options: ListenOptions): Promise<AuthCodeListener> {
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;
  const code = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });
  // The caller awaits `code` later; this keeps an early rejection from being reported as unhandled meanwhile.
  code.catch(() => undefined);

  let isSettled = false;
  const settle = (result: Exclude<CallbackResult, { foreign: true }> | Error): void => {
    if (isSettled) return;
    isSettled = true;
    clearTimeout(timeoutHandle);
    server.close();
    server.closeAllConnections();
    if (result instanceof Error) rejectCode(result);
    else if (result.ok) resolveCode(result.code);
    else rejectCode(new Error(`Spotify login failed: ${result.reason}`));
  };

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', buildRedirectUri(options.port));
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) {
      response.writeHead(404).end();
      return;
    }
    const result = parseCallback(url.searchParams, options.expectedState);
    // Any web page can hit this port; without our state it must not be able to abort the login.
    if ('foreign' in result) {
      response.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Unexpected login callback.');
      return;
    }
    sendResultPage(response, result.ok);
    settle(result);
  });

  const timeoutHandle = setTimeout(
    () => settle(new Error(`Spotify login timed out after ${options.timeoutMs / 1000}s without a browser callback`)),
    options.timeoutMs,
  );

  return new Promise((resolve, reject) => {
    server.once('error', (error) => {
      clearTimeout(timeoutHandle);
      reject(new Error(`Cannot listen on ${LOOPBACK_HOST}:${options.port} for the login callback (${error.message}). ` +
        'Change "spotifySidebar.redirectPort" and the Redirect URI in your Spotify app.'));
    });
    server.listen(options.port, LOOPBACK_HOST, () => {
      resolve({ code, dispose: () => settle(new LoginCancelledError()) });
    });
  });
}

function sendResultPage(response: ServerResponse, isSuccess: boolean): void {
  // Static text only: never reflect query parameters back into the page.
  const message = isSuccess
    ? 'Logged in to Spotify. You can close this tab and return to VS Code.'
    : 'Spotify login failed. Return to VS Code for details.';
  response.writeHead(isSuccess ? 200 : 400, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'",
  });
  response.end(`<!doctype html><meta charset="utf-8"><title>Spotify Sidebar</title><p>${message}</p>`);
}
