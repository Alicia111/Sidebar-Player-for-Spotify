import * as vscode from 'vscode';
import type { TokenProvider } from '../api/spotifyClient.ts';
import { buildRedirectUri, listenForAuthCode } from './loopbackServer.ts';
import { buildAuthorizeUrl, exchangeAuthorizationCode, refreshAccessToken, TokenRequestError } from './oauth.ts';
import { createCodeChallenge, createCodeVerifier, createState } from './pkce.ts';

const SESSION_SECRET_KEY = 'spotifySidebar.session';
const LOGGED_IN_CONTEXT_KEY = 'spotifySidebar.loggedIn';
const LOGIN_TIMEOUT_MS = 2 * 60 * 1000;
// Refresh slightly early so a token never expires mid-request.
const TOKEN_EXPIRY_MARGIN_MS = 60 * 1000;
// Must match the `spotifySidebar.redirectPort` default in package.json.
const DEFAULT_REDIRECT_PORT = 8888;
const CLIENT_ID_PATTERN = /^[0-9a-f]{32}$/i;
const DASHBOARD_URL = 'https://developer.spotify.com/dashboard';

/** Persisted together because a refresh token only works with the client ID that issued it. */
interface StoredSession {
  clientId: string;
  refreshToken: string;
}

interface CachedAccessToken {
  value: string;
  expiresAt: number;
}

export class NotLoggedInError extends Error {
  constructor(detail = 'Not logged in to Spotify') {
    super(detail);
    this.name = 'NotLoggedInError';
  }
}

export class AuthManager implements TokenProvider, vscode.Disposable {
  private readonly secrets: vscode.SecretStorage;
  private readonly log: vscode.LogOutputChannel;
  private readonly loginStateEmitter = new vscode.EventEmitter<boolean>();
  private session: StoredSession | undefined;
  private accessToken: CachedAccessToken | undefined;
  private refreshInFlight: Promise<string> | undefined;

  readonly onDidChangeLoginState = this.loginStateEmitter.event;

  constructor(secrets: vscode.SecretStorage, log: vscode.LogOutputChannel) {
    this.secrets = secrets;
    this.log = log;
  }

  get isLoggedIn(): boolean {
    return this.session !== undefined;
  }

  async initialize(): Promise<void> {
    const raw = await this.secrets.get(SESSION_SECRET_KEY);
    this.session = raw ? parseStoredSession(raw) : undefined;
    if (raw && !this.session) {
      this.log.warn('Stored Spotify session was unreadable; discarding it.');
      await this.secrets.delete(SESSION_SECRET_KEY);
    }
    await this.publishLoginState();
  }

  /** Returns false when the user backs out (no client ID entered or login cancelled). */
  async login(): Promise<boolean> {
    const clientId = await this.resolveClientId();
    if (!clientId) return false;

    const port = vscode.workspace.getConfiguration('spotifySidebar').get<number>('redirectPort', DEFAULT_REDIRECT_PORT);
    const redirectUri = buildRedirectUri(port);
    const codeVerifier = createCodeVerifier();
    const state = createState();
    const listener = await listenForAuthCode({ port, expectedState: state, timeoutMs: LOGIN_TIMEOUT_MS });

    try {
      const authorizeUrl = buildAuthorizeUrl({ clientId, redirectUri, codeChallenge: createCodeChallenge(codeVerifier), state });
      await vscode.env.openExternal(vscode.Uri.parse(authorizeUrl, true));
      const code = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Waiting for Spotify authorization in your browser…', cancellable: true },
        (_progress, cancellation) => {
          cancellation.onCancellationRequested(() => listener.dispose());
          return listener.code;
        },
      );
      const tokens = await exchangeAuthorizationCode({ clientId, code, redirectUri, codeVerifier });
      await this.storeSession({ clientId, refreshToken: tokens.refreshToken });
      this.accessToken = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
      this.log.info('Logged in to Spotify.');
      return true;
    } finally {
      listener.dispose();
    }
  }

  async logout(): Promise<void> {
    this.session = undefined;
    this.accessToken = undefined;
    await this.secrets.delete(SESSION_SECRET_KEY);
    await this.publishLoginState();
    this.log.info('Logged out of Spotify.');
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.accessToken.expiresAt - TOKEN_EXPIRY_MARGIN_MS) {
      return this.accessToken.value;
    }
    // Concurrent callers share one refresh so a rotated refresh token is never used twice.
    this.refreshInFlight ??= this.refreshSession().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  invalidateAccessToken(): void {
    this.accessToken = undefined;
  }

  dispose(): void {
    this.loginStateEmitter.dispose();
  }

  private async refreshSession(): Promise<string> {
    const session = this.session;
    if (!session) throw new NotLoggedInError();

    try {
      const tokens = await refreshAccessToken(session.clientId, session.refreshToken);
      if (tokens.refreshToken !== session.refreshToken) {
        await this.storeSession({ clientId: session.clientId, refreshToken: tokens.refreshToken });
      }
      this.accessToken = { value: tokens.accessToken, expiresAt: tokens.expiresAt };
      return tokens.accessToken;
    } catch (error) {
      if (error instanceof TokenRequestError && error.errorCode === 'invalid_grant') {
        this.log.warn(`Refresh token rejected, logging out: ${error.message}`);
        await this.logout();
        throw new NotLoggedInError('Spotify session expired, please log in again');
      }
      throw error;
    }
  }

  private async storeSession(session: StoredSession): Promise<void> {
    const wasLoggedIn = this.isLoggedIn;
    this.session = session;
    await this.secrets.store(SESSION_SECRET_KEY, JSON.stringify(session));
    if (!wasLoggedIn) await this.publishLoginState();
  }

  private async publishLoginState(): Promise<void> {
    await vscode.commands.executeCommand('setContext', LOGGED_IN_CONTEXT_KEY, this.isLoggedIn);
    this.loginStateEmitter.fire(this.isLoggedIn);
  }

  private async resolveClientId(): Promise<string | undefined> {
    const config = vscode.workspace.getConfiguration('spotifySidebar');
    const configured = config.get<string>('clientId', '').trim();
    if (CLIENT_ID_PATTERN.test(configured)) return configured;

    const port = config.get<number>('redirectPort', DEFAULT_REDIRECT_PORT);
    const entered = await vscode.window.showInputBox({
      title: 'Spotify Client ID',
      prompt: `Create an app at ${DASHBOARD_URL} with Redirect URI ${buildRedirectUri(port)} and "Web API" enabled, then paste its Client ID.`,
      placeHolder: '32 hex characters',
      ignoreFocusOut: true,
      validateInput: (value) => (CLIENT_ID_PATTERN.test(value.trim()) ? undefined : 'A Client ID is 32 hexadecimal characters'),
    });
    if (!entered) return undefined;

    const clientId = entered.trim();
    await config.update('clientId', clientId, vscode.ConfigurationTarget.Global);
    return clientId;
  }
}

function parseStoredSession(raw: string): StoredSession | undefined {
  try {
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed.clientId === 'string' && typeof parsed.refreshToken === 'string') {
      return { clientId: parsed.clientId, refreshToken: parsed.refreshToken };
    }
  } catch {
    // Fall through: the caller logs and discards unreadable sessions.
  }
  return undefined;
}
