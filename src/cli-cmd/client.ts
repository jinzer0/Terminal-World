import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { ServiceError, type ServiceErrorCode } from '../core/errors.js';
import type { IntegrationChannel, IntegrationScope } from '../core/integration-auth-service.js';

export const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:4310';

export interface StoredCredentials {
  serverUrl: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
  grantId: string;
  grantExpiresAt: string;
  channel: IntegrationChannel;
  scopes: IntegrationScope[];
  memberId: string;
  loginId: string;
  nickname: string;
  role: 'member' | 'admin';
}

export interface BridgeSuccessEnvelope<T = unknown> {
  ok: true;
  data: T;
  meta: {
    cursor?: string | null;
    hasMore?: boolean;
    checkedAt?: string;
    [key: string]: unknown;
  };
}

export interface BridgeErrorEnvelope {
  ok: false;
  error: {
    code: ServiceErrorCode;
    field?: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export type BridgeEnvelope<T = unknown> = BridgeSuccessEnvelope<T> | BridgeErrorEnvelope;

export interface SseFrame {
  id?: string;
  event: string;
  data: unknown;
}

export interface BridgeClientOptions {
  baseUrl?: string;
  credentialsPath?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export function resolveCredentialsPath(explicitPath?: string): string {
  if (explicitPath && explicitPath.trim()) {
    return explicitPath.trim();
  }
  const envPath = process.env.TERMINAL_WORLD_CREDENTIALS_PATH;
  if (envPath && envPath.trim()) {
    return envPath.trim();
  }
  return join(homedir(), '.config', 'terminal-world', 'credentials.json');
}

export function loadCredentials(credentialsPath?: string): StoredCredentials | null {
  const filePath = resolveCredentialsPath(credentialsPath);
  if (!existsSync(filePath)) return null;
  try {
    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredCredentials>;
    if (!parsed || typeof parsed !== 'object' || typeof parsed.accessToken !== 'string') {
      return null;
    }
    return parsed as StoredCredentials;
  } catch {
    return null;
  }
}

export function saveCredentials(credentials: StoredCredentials, credentialsPath?: string): string {
  const filePath = resolveCredentialsPath(credentialsPath);
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  writeFileSync(filePath, `${JSON.stringify(credentials, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(filePath, 0o600);
  return filePath;
}

export function clearCredentials(credentialsPath?: string): boolean {
  const filePath = resolveCredentialsPath(credentialsPath);
  if (!existsSync(filePath)) return false;
  unlinkSync(filePath);
  return true;
}

function isPreConnectRefusal(error: unknown): boolean {
  const visited = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !visited.has(current)) {
    visited.add(current);
    const code = (current as { code?: unknown }).code;
    if (
      code === 'ECONNREFUSED'
      || code === 'ENOTFOUND'
      || code === 'EAI_AGAIN'
      || code === 'EHOSTUNREACH'
      || code === 'ENETUNREACH'
    ) {
      return true;
    }
    current = (current as { cause?: unknown }).cause;
  }
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('ECONNREFUSED') || message.includes('ENOTFOUND');
}

export class BridgeClient {
  readonly baseUrl: string;
  readonly credentialsPath: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: BridgeClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.TERMINAL_WORLD_SERVER ?? DEFAULT_BRIDGE_URL).replace(/\/+$/, '');
    this.credentialsPath = resolveCredentialsPath(options.credentialsPath);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  getCredentials(): StoredCredentials | null {
    return loadCredentials(this.credentialsPath);
  }

  storeCredentials(credentials: StoredCredentials): string {
    return saveCredentials(credentials, this.credentialsPath);
  }

  removeCredentials(): boolean {
    return clearCredentials(this.credentialsPath);
  }

  async refreshStoredCredentials(explicitRefreshToken?: string): Promise<StoredCredentials> {
    const existing = this.getCredentials();
    const refreshToken = explicitRefreshToken ?? existing?.refreshToken;
    if (!refreshToken) {
      throw new ServiceError('UNAUTHORIZED', '저장된 Refresh 토큰이 없어요. 다시 로그인해 주세요.');
    }

    const res = await this.request<{
      accessToken: string;
      accessTokenExpiresAt: string;
      refreshToken: string;
      refreshTokenExpiresAt: string;
      grant: {
        id: string;
        channel: IntegrationChannel;
        scopes: IntegrationScope[];
        expiresAt: string;
      };
      member: {
        id: string;
        loginId: string;
        nickname: string;
        role: 'member' | 'admin';
      };
      effectiveScopes: IntegrationScope[];
    }>('POST', '/auth/refresh', {
      body: { refreshToken },
      auth: false,
      retryOnExpired: false,
    });

    const updated: StoredCredentials = {
      serverUrl: this.baseUrl,
      accessToken: res.data.accessToken,
      accessTokenExpiresAt: res.data.accessTokenExpiresAt,
      refreshToken: res.data.refreshToken,
      refreshTokenExpiresAt: res.data.refreshTokenExpiresAt,
      grantId: res.data.grant.id,
      grantExpiresAt: res.data.grant.expiresAt,
      channel: res.data.grant.channel,
      scopes: res.data.effectiveScopes,
      memberId: res.data.member.id,
      loginId: res.data.member.loginId,
      nickname: res.data.member.nickname,
      role: res.data.member.role,
    };
    this.storeCredentials(updated);
    return updated;
  }

  async request<T = unknown>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    opts: {
      query?: Record<string, string | number | boolean | undefined>;
      body?: Record<string, unknown>;
      auth?: boolean | 'optional';
      token?: string;
      idempotencyKey?: string;
      retryOnExpired?: boolean;
      signal?: AbortSignal;
    } = {},
  ): Promise<BridgeSuccessEnvelope<T>> {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.baseUrl}/`);
    if (opts.query) {
      for (const [key, value] of Object.entries(opts.query)) {
        if (value !== undefined && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const authMode = opts.auth ?? false;
    let token = opts.token;
    if (!token && authMode !== false) {
      const creds = this.getCredentials();
      token = creds?.accessToken;
    }
    if (!token && authMode === true) {
      throw new ServiceError('UNAUTHORIZED', '로그인이 필요해요. terminal-world auth login으로 인증해 주세요.');
    }

    const executeFetch = async (bearerToken?: string): Promise<{ status: number; payload: BridgeEnvelope<T> }> => {
      const headers: Record<string, string> = {
        accept: 'application/json',
      };
      if (bearerToken) {
        headers.authorization = `Bearer ${bearerToken}`;
      }
      if (opts.idempotencyKey) {
        headers['idempotency-key'] = opts.idempotencyKey;
      }

      let bodyText: string | undefined;
      if (opts.body !== undefined && method !== 'GET') {
        headers['content-type'] = 'application/json; charset=utf-8';
        bodyText = JSON.stringify(opts.body);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
      const onExternalAbort = () => controller.abort();
      opts.signal?.addEventListener('abort', onExternalAbort, { once: true });

      let response: Response;
      try {
        response = await this.fetchImpl(url.toString(), {
          method,
          headers,
          body: bodyText,
          signal: controller.signal,
        });
      } catch (error) {
        if (isPreConnectRefusal(error)) {
          throw new ServiceError(
            'EXTERNAL_UNAVAILABLE',
            `서버 브릿지(${this.baseUrl})에 연결할 수 없어요.`,
          );
        }
        if (method !== 'GET') {
          throw new ServiceError(
            'UNCERTAIN_DELIVERY',
            '쓰기 요청의 처리 결과를 확인하지 못했어요. 자동 재전송하지 않았으니 같은 --idempotency-key로 재시도해 주세요.',
          );
        }
        throw new ServiceError(
          'EXTERNAL_UNAVAILABLE',
          error instanceof Error ? error.message : '서버 통신 중 오류가 발생했어요.',
        );
      } finally {
        clearTimeout(timeout);
        opts.signal?.removeEventListener('abort', onExternalAbort);
      }

      if (response.status === 504) {
        throw new ServiceError(
          'UNCERTAIN_DELIVERY',
          '요청 처리 결과를 시간 내에 확인하지 못했어요. 같은 --idempotency-key로 확인 후 재시도해 주세요.',
        );
      }

      let parsed: BridgeEnvelope<T>;
      try {
        parsed = (await response.json()) as BridgeEnvelope<T>;
      } catch {
        if (response.status >= 500) {
          throw new ServiceError('EXTERNAL_UNAVAILABLE', `서버 응답 오류 (HTTP ${response.status}).`);
        }
        throw new ServiceError('INTERNAL_ERROR', `서버 응답을 해석할 수 없어요 (HTTP ${response.status}).`);
      }

      return { status: response.status, payload: parsed };
    };

    let { payload } = await executeFetch(token);

    if (
      !payload.ok
      && payload.error.code === 'AUTH_EXPIRED'
      && opts.retryOnExpired !== false
      && !opts.token
      && authMode !== false
      && this.getCredentials()?.refreshToken
    ) {
      const refreshed = await this.refreshStoredCredentials();
      ({ payload } = await executeFetch(refreshed.accessToken));
    }

    if (!payload.ok) {
      throw new ServiceError(
        payload.error.code,
        payload.error.message,
        payload.error.field,
        payload.error.details,
      );
    }

    return payload;
  }

  async streamSse(
    path: string,
    onFrame: (frame: SseFrame) => void,
    opts: { signal?: AbortSignal; token?: string; query?: Record<string, string | undefined> } = {},
  ): Promise<void> {
    const url = new URL(path.startsWith('/') ? path : `/${path}`, `${this.baseUrl}/`);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) url.searchParams.set(k, v);
      }
    }

    const headers: Record<string, string> = {
      accept: 'text/event-stream',
    };
    const token = opts.token ?? this.getCredentials()?.accessToken;
    if (token) {
      headers.authorization = `Bearer ${token}`;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), {
        method: 'GET',
        headers,
        signal: opts.signal,
      });
    } catch (error) {
      if (opts.signal?.aborted) return;
      throw new ServiceError(
        'EXTERNAL_UNAVAILABLE',
        `SSE 스트림(${this.baseUrl})에 연결할 수 없어요: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok || !response.body) {
      throw new ServiceError('EXTERNAL_UNAVAILABLE', `SSE 스트림 연결 실패 (HTTP ${response.status}).`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const rawFrame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          this.dispatchRawSseFrame(rawFrame, onFrame);
          boundary = buffer.indexOf('\n\n');
        }
      }
    } catch (error) {
      if (opts.signal?.aborted) return;
      throw new ServiceError(
        'EXTERNAL_UNAVAILABLE',
        error instanceof Error ? error.message : 'SSE 연결이 끊어졌어요.',
      );
    } finally {
      try {
        await reader.cancel();
      } catch {
        // ignore
      }
    }
  }

  private dispatchRawSseFrame(rawFrame: string, onFrame: (frame: SseFrame) => void): void {
    const lines = rawFrame.split(/\r?\n/);
    let id: string | undefined;
    let event = 'message';
    const dataLines: string[] = [];

    for (const line of lines) {
      if (!line || line.startsWith(':')) continue;
      const colonIdx = line.indexOf(':');
      const field = colonIdx === -1 ? line : line.slice(0, colonIdx);
      const value = colonIdx === -1 ? '' : line.slice(colonIdx + 1).replace(/^ /, '');
      if (field === 'id') id = value;
      else if (field === 'event') event = value;
      else if (field === 'data') dataLines.push(value);
    }

    if (dataLines.length === 0) return;
    const rawData = dataLines.join('\n');
    let parsed: unknown = rawData;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      // keep raw string
    }
    onFrame({ id, event, data: parsed });
  }
}
