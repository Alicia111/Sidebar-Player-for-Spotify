import { setTimeout as delay } from 'node:timers/promises';

const API_BASE_URL = 'https://api.spotify.com/v1';
const DEFAULT_MAX_RATE_LIMIT_RETRIES = 2;
const DEFAULT_RETRY_AFTER_SECONDS = 1;
// A longer Retry-After usually means the app quota is exhausted; surface that instead of hanging.
const MAX_RETRY_AFTER_SECONDS = 30;

export interface TokenProvider {
  getAccessToken(): Promise<string>;
  invalidateAccessToken(): void;
}

export type QueryValue = string | number | boolean | undefined;

export interface RequestOptions {
  query?: Record<string, QueryValue>;
  body?: unknown;
}

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export class SpotifyApiError extends Error {
  readonly status: number;
  /** Spotify's machine-readable reason, e.g. `NO_ACTIVE_DEVICE` or `PREMIUM_REQUIRED`. */
  readonly reason: string | undefined;
  readonly method: HttpMethod;
  readonly path: string;

  constructor(details: { status: number; reason?: string; apiMessage: string; method: HttpMethod; path: string }) {
    super(`${details.method} ${details.path} failed with HTTP ${details.status}: ${details.apiMessage}`);
    this.name = 'SpotifyApiError';
    this.status = details.status;
    this.reason = details.reason;
    this.method = details.method;
    this.path = details.path;
  }

  get isNoActiveDevice(): boolean {
    return this.reason === 'NO_ACTIVE_DEVICE' || (this.status === 404 && this.path.startsWith('/me/player'));
  }

  get isPremiumRequired(): boolean {
    return this.reason === 'PREMIUM_REQUIRED';
  }
}

export interface SpotifyClientOptions {
  tokens: TokenProvider;
  fetchFn?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

export class SpotifyClient {
  private readonly tokens: TokenProvider;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;

  constructor(options: SpotifyClientOptions) {
    this.tokens = options.tokens;
    this.fetchFn = options.fetchFn ?? fetch;
    this.sleep = options.sleep ?? ((milliseconds) => delay(milliseconds));
    this.maxRateLimitRetries = options.maxRateLimitRetries ?? DEFAULT_MAX_RATE_LIMIT_RETRIES;
  }

  /** Resolves to `undefined` for empty responses (204, or 200 with no body). */
  async request<T>(method: HttpMethod, path: string, options: RequestOptions = {}): Promise<T | undefined> {
    const url = buildUrl(path, options.query);
    let hasRetriedAuth = false;
    let rateLimitRetries = 0;

    for (;;) {
      const response = await this.send(method, url, options.body);

      if (response.status === 401 && !hasRetriedAuth) {
        hasRetriedAuth = true;
        this.tokens.invalidateAccessToken();
        continue;
      }
      if (response.status === 429 && rateLimitRetries < this.maxRateLimitRetries) {
        const retryAfterSeconds = parseRetryAfter(response.headers.get('Retry-After'));
        if (retryAfterSeconds <= MAX_RETRY_AFTER_SECONDS) {
          rateLimitRetries++;
          await this.sleep(retryAfterSeconds * 1000);
          continue;
        }
      }
      if (!response.ok) {
        throw await toApiError(response, method, path);
      }
      return parseBody<T>(response);
    }
  }

  private async send(method: HttpMethod, url: string, body: unknown): Promise<Response> {
    const accessToken = await this.tokens.getAccessToken();
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return this.fetchFn(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  }
}

export function buildUrl(path: string, query: Record<string, QueryValue> = {}): string {
  const url = new URL(API_BASE_URL + path);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseRetryAfter(header: string | null): number {
  const seconds = Number(header);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_RETRY_AFTER_SECONDS;
}

async function parseBody<T>(response: Response): Promise<T | undefined> {
  if (response.status === 204) return undefined;
  const text = await response.text();
  if (text.trim() === '') return undefined;
  try {
    return JSON.parse(text) as T;
  } catch {
    // Some write endpoints answer 200 with a bare snapshot id or plain text instead of JSON.
    return undefined;
  }
}

async function toApiError(response: Response, method: HttpMethod, path: string): Promise<SpotifyApiError> {
  const text = await response.text().catch(() => '');
  let apiMessage = response.statusText || 'no error message';
  let reason: string | undefined;
  try {
    const payload = JSON.parse(text) as { error?: { message?: string; reason?: string } | string };
    if (typeof payload.error === 'object') {
      apiMessage = payload.error.message ?? apiMessage;
      reason = payload.error.reason;
    } else if (typeof payload.error === 'string') {
      apiMessage = payload.error;
    }
  } catch {
    if (text) apiMessage = text.slice(0, 200);
  }
  return new SpotifyApiError({ status: response.status, reason, apiMessage, method, path });
}
