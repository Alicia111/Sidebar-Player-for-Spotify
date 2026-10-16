const AUTHORIZE_URL = 'https://accounts.spotify.com/authorize';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';

export const SPOTIFY_SCOPES = [
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public',
  'user-library-read',
  'user-library-modify',
  'user-read-recently-played',
];

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

export class TokenRequestError extends Error {
  readonly status: number;
  /** OAuth error code such as `invalid_grant`, when Spotify sends one. */
  readonly errorCode: string | undefined;

  constructor(status: number, errorCode: string | undefined, description: string) {
    super(`Spotify token request failed (HTTP ${status}${errorCode ? `, ${errorCode}` : ''}): ${description}`);
    this.name = 'TokenRequestError';
    this.status = status;
    this.errorCode = errorCode;
  }
}

export interface AuthorizeUrlParams {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string;
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: params.clientId,
    response_type: 'code',
    redirect_uri: params.redirectUri,
    code_challenge_method: 'S256',
    code_challenge: params.codeChallenge,
    state: params.state,
    scope: SPOTIFY_SCOPES.join(' '),
  }).toString();
  return url.toString();
}

export interface CodeExchangeParams {
  clientId: string;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}

export function exchangeAuthorizationCode(params: CodeExchangeParams, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: params.clientId,
    code: params.code,
    redirect_uri: params.redirectUri,
    code_verifier: params.codeVerifier,
  });
  return requestTokens(form, undefined, fetchFn);
}

export function refreshAccessToken(clientId: string, refreshToken: string, fetchFn: typeof fetch = fetch): Promise<TokenSet> {
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  });
  // Spotify may or may not rotate the refresh token; keep the old one when it doesn't.
  return requestTokens(form, refreshToken, fetchFn);
}

async function requestTokens(form: URLSearchParams, previousRefreshToken: string | undefined, fetchFn: typeof fetch): Promise<TokenSet> {
  const requestedAt = Date.now();
  const response = await fetchFn(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form,
  });
  const payload: unknown = await response.json().catch(() => undefined);

  if (!response.ok) {
    const { error, error_description } = (payload ?? {}) as { error?: string; error_description?: string };
    throw new TokenRequestError(response.status, error, error_description ?? response.statusText);
  }
  return parseTokenResponse(payload, previousRefreshToken, requestedAt);
}

function parseTokenResponse(payload: unknown, previousRefreshToken: string | undefined, requestedAt: number): TokenSet {
  const { access_token, refresh_token, expires_in } = (payload ?? {}) as Record<string, unknown>;
  const refreshToken = typeof refresh_token === 'string' ? refresh_token : previousRefreshToken;

  if (typeof access_token !== 'string' || typeof expires_in !== 'number' || refreshToken === undefined) {
    throw new TokenRequestError(200, 'malformed_response', 'response is missing access_token, expires_in or refresh_token');
  }
  return { accessToken: access_token, refreshToken, expiresAt: requestedAt + expires_in * 1000 };
}
