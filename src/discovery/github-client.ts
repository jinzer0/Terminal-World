import { type Clock, SystemClock } from '../core/clock.js';
import { ServiceError } from '../core/errors.js';

export interface GitHubRateLimitInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
  retryAfterSeconds: number | null;
}

export interface GitHubRepoItem {
  fullName: string;
  sourceUrl: string;
  description: string;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  starsCount: number | null;
  repoCreatedAt: string | null;
  pushedAt: string | null;
}

export interface GitHubIssueItem {
  id: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  sourceUrl: string;
  sourceState: 'open' | 'closed';
  assignees: string[];
  linkedPrs: string[];
  recentActivityAt: string | null;
  isPullRequest: boolean;
  embeddedRepo?: Partial<GitHubRepoItem>;
}

export interface GitHubSearchReposParams {
  query?: string;
  language?: string;
  topic?: string;
  sort?: 'stars' | 'updated';
  order?: 'desc' | 'asc';
  perPage?: number;
  etag?: string | null;
}

export interface GitHubSearchIssuesParams {
  query?: string;
  language?: string;
  topic?: string;
  repos?: string[];
  perPage?: number;
  etag?: string | null;
}

export type GitHubSearchReposResult =
  | {
      notModified: true;
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
    }
  | {
      notModified: false;
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
      totalCount: number;
      incompleteResults: boolean;
      items: GitHubRepoItem[];
    };

export type GitHubSearchIssuesResult =
  | {
      notModified: true;
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
    }
  | {
      notModified: false;
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
      totalCount: number;
      incompleteResults: boolean;
      items: GitHubIssueItem[];
    };

export type GitHubGetIssueResult =
  | {
      status: 'ok';
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
      issue: GitHubIssueItem;
    }
  | {
      status: 'not_modified';
      etag: string | null;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
    }
  | {
      status: 'deleted_or_inaccessible';
      httpStatus: 404 | 410;
      checkedAt: string;
      rateLimit: GitHubRateLimitInfo;
    };

export interface GitHubClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  defaultCooldownMs?: number;
  timeoutMs?: number;
  userAgent?: string;
}

interface RawGitHubRepo {
  full_name?: unknown;
  html_url?: unknown;
  description?: unknown;
  language?: unknown;
  topics?: unknown;
  license?: { spdx_id?: unknown; name?: unknown } | null;
  stargazers_count?: unknown;
  created_at?: unknown;
  pushed_at?: unknown;
}

interface RawGitHubIssue {
  number?: unknown;
  title?: unknown;
  body?: unknown;
  state?: unknown;
  html_url?: unknown;
  repository_url?: unknown;
  labels?: unknown;
  assignees?: unknown;
  pull_request?: unknown;
  updated_at?: unknown;
  created_at?: unknown;
  repository?: RawGitHubRepo;
}

const DEFAULT_BASE_URL = 'https://api.github.com';
const DEFAULT_COOLDOWN_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_USER_AGENT = 'terminal-world-oss-discovery/0.1';

function parseIntegerHeader(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseRetryAfterSeconds(value: string | null, nowMs: number): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) {
    const sec = Number(trimmed);
    return Number.isFinite(sec) ? Math.max(1, sec) : null;
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(1, Math.ceil((dateMs - nowMs) / 1000));
  }
  return null;
}

function extractRateLimitInfo(headers: Headers, nowMs: number): GitHubRateLimitInfo {
  const limit = parseIntegerHeader(headers.get('x-ratelimit-limit'));
  const remaining = parseIntegerHeader(headers.get('x-ratelimit-remaining'));
  const resetEpoch = parseIntegerHeader(headers.get('x-ratelimit-reset'));
  const retryAfterSeconds = parseRetryAfterSeconds(headers.get('retry-after'), nowMs);
  const resetAt = resetEpoch !== null ? new Date(resetEpoch * 1000).toISOString() : null;
  return { limit, remaining, resetAt, retryAfterSeconds };
}

function sanitizeSearchToken(value: string): string {
  return value.trim().replace(/[\r\n\t]+/g, ' ');
}

function buildBodyExcerpt(body: unknown, maxLen = 400): string {
  if (typeof body !== 'string') return '';
  const collapsed = body.replace(/\r\n/g, '\n').trim();
  if (collapsed.length <= maxLen) return collapsed;
  return `${collapsed.slice(0, maxLen - 1).trimEnd()}…`;
}

function parseRepoFullNameFromIssue(raw: RawGitHubIssue): string | null {
  if (typeof raw.repository_url === 'string') {
    const match = /\/repos\/([^/]+\/[^/]+)\/?$/.exec(raw.repository_url);
    if (match?.[1]) return match[1];
  }
  if (typeof raw.html_url === 'string') {
    const match = /github\.com\/([^/]+\/[^/]+)\/(?:issues|pull)\/\d+/.exec(raw.html_url);
    if (match?.[1]) return match[1];
  }
  if (raw.repository && typeof raw.repository.full_name === 'string') {
    return raw.repository.full_name;
  }
  return null;
}

function mapRawRepo(raw: RawGitHubRepo): GitHubRepoItem | null {
  if (typeof raw.full_name !== 'string' || !raw.full_name.includes('/')) return null;
  const fullName = raw.full_name;
  const sourceUrl =
    typeof raw.html_url === 'string' && raw.html_url.length > 0
      ? raw.html_url
      : `https://github.com/${fullName}`;
  const licenseSpdx =
    raw.license && typeof raw.license.spdx_id === 'string' && raw.license.spdx_id.trim().length > 0
      ? raw.license.spdx_id.trim()
      : null;
  const topics = Array.isArray(raw.topics)
    ? raw.topics.filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    : [];
  const starsCount =
    typeof raw.stargazers_count === 'number' && Number.isFinite(raw.stargazers_count) && raw.stargazers_count >= 0
      ? Math.floor(raw.stargazers_count)
      : null;
  return {
    fullName,
    sourceUrl,
    description: typeof raw.description === 'string' ? raw.description : '',
    language: typeof raw.language === 'string' && raw.language.trim().length > 0 ? raw.language.trim() : null,
    topics,
    licenseSpdx,
    starsCount,
    repoCreatedAt: typeof raw.created_at === 'string' && raw.created_at.length > 0 ? raw.created_at : null,
    pushedAt: typeof raw.pushed_at === 'string' && raw.pushed_at.length > 0 ? raw.pushed_at : null,
  };
}

function mapRawIssue(raw: RawGitHubIssue, fallbackRepoFullName?: string): GitHubIssueItem | null {
  const repoFullName = parseRepoFullNameFromIssue(raw) ?? fallbackRepoFullName ?? null;
  const issueNumber = typeof raw.number === 'number' && Number.isInteger(raw.number) ? raw.number : null;
  if (!repoFullName || issueNumber === null || typeof raw.title !== 'string') {
    return null;
  }
  const htmlUrl =
    typeof raw.html_url === 'string' && raw.html_url.length > 0
      ? raw.html_url
      : `https://github.com/${repoFullName}/issues/${issueNumber}`;
  const isPullRequest = Boolean(raw.pull_request) || /\/pull\/\d+(?:$|[?#])/.test(htmlUrl);
  const labels = Array.isArray(raw.labels)
    ? raw.labels
        .map(l => (l && typeof l === 'object' && typeof (l as { name?: unknown }).name === 'string'
          ? (l as { name: string }).name.trim()
          : ''))
        .filter(Boolean)
    : [];
  const assignees = Array.isArray(raw.assignees)
    ? raw.assignees
        .map(a => (a && typeof a === 'object' && typeof (a as { login?: unknown }).login === 'string'
          ? (a as { login: string }).login.trim()
          : ''))
        .filter(Boolean)
    : [];
  const sourceState: 'open' | 'closed' = raw.state === 'closed' ? 'closed' : 'open';
  const embeddedRepo = raw.repository ? mapRawRepo(raw.repository) ?? undefined : undefined;

  return {
    id: `${repoFullName}#${issueNumber}`,
    repoFullName,
    issueNumber,
    title: raw.title,
    bodyExcerpt: buildBodyExcerpt(raw.body),
    labels,
    sourceUrl: htmlUrl,
    sourceState,
    assignees,
    linkedPrs: [],
    recentActivityAt:
      typeof raw.updated_at === 'string'
        ? raw.updated_at
        : typeof raw.created_at === 'string'
          ? raw.created_at
          : null,
    isPullRequest,
    embeddedRepo,
  };
}

/**
 * Unauthenticated public GitHub REST client.
 * Never reads GITHUB_TOKEN, GH_TOKEN, or .netrc and never sends an Authorization header.
 * Provides singleflight request deduplication, a serial request queue, ETag conditional GET,
 * rate-limit header tracking, and immediate 403/429 cooldown protection.
 */
export class GitHubClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: Clock;
  private readonly defaultCooldownMs: number;
  private readonly timeoutMs: number;
  private readonly userAgent: string;

  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly etagByUrl = new Map<string, string>();
  private queueTail: Promise<void> = Promise.resolve();
  private cooldownUntilMs = 0;
  private lastRateLimit: GitHubRateLimitInfo = {
    limit: null,
    remaining: null,
    resetAt: null,
    retryAfterSeconds: null,
  };

  constructor(options: GitHubClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.clock = options.clock ?? new SystemClock();
    this.defaultCooldownMs = options.defaultCooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.userAgent = options.userAgent ?? DEFAULT_USER_AGENT;
  }

  getCooldownUntil(): string | null {
    return this.cooldownUntilMs > this.clock.now().getTime()
      ? new Date(this.cooldownUntilMs).toISOString()
      : null;
  }

  getLastRateLimit(): GitHubRateLimitInfo {
    return { ...this.lastRateLimit };
  }

  isInCooldown(): boolean {
    return this.clock.now().getTime() < this.cooldownUntilMs;
  }

  async searchRepositories(params: GitHubSearchReposParams = {}): Promise<GitHubSearchReposResult> {
    const terms: string[] = [];
    if (params.query && params.query.trim()) {
      terms.push(sanitizeSearchToken(params.query));
    } else {
      terms.push('stars:>0');
    }
    if (params.language && params.language.trim()) {
      terms.push(`language:${sanitizeSearchToken(params.language)}`);
    }
    if (params.topic && params.topic.trim()) {
      terms.push(`topic:${sanitizeSearchToken(params.topic)}`);
    }

    const searchParams = new URLSearchParams({
      q: terms.join(' '),
      sort: params.sort ?? 'stars',
      order: params.order ?? 'desc',
      per_page: String(Math.min(50, Math.max(1, params.perPage ?? 20))),
    });
    const url = `${this.baseUrl}/search/repositories?${searchParams.toString()}`;
    const etag = params.etag !== undefined ? params.etag : this.etagByUrl.get(url) ?? null;

    return this.singleflight(`repos:${url}:${etag ?? ''}`, async () => {
      const res = await this.enqueueRequest(url, etag);
      if (res.status === 304) {
        return {
          notModified: true,
          etag: res.etag ?? etag,
          checkedAt: res.checkedAt,
          rateLimit: res.rateLimit,
        };
      }
      const data = res.body as {
        total_count?: unknown;
        incomplete_results?: unknown;
        items?: unknown;
      };
      const rawItems = Array.isArray(data?.items) ? (data.items as RawGitHubRepo[]) : [];
      const items = rawItems
        .map(mapRawRepo)
        .filter((item): item is GitHubRepoItem => item !== null);
      return {
        notModified: false,
        etag: res.etag,
        checkedAt: res.checkedAt,
        rateLimit: res.rateLimit,
        totalCount: typeof data?.total_count === 'number' ? data.total_count : items.length,
        incompleteResults: Boolean(data?.incomplete_results),
        items,
      };
    });
  }

  async searchIssues(params: GitHubSearchIssuesParams = {}): Promise<GitHubSearchIssuesResult> {
    const terms: string[] = ['is:issue', 'is:open'];
    if (params.repos && params.repos.length > 0) {
      for (const repo of params.repos.slice(0, 5)) {
        if (repo.includes('/')) {
          terms.push(`repo:${sanitizeSearchToken(repo)}`);
        }
      }
    }
    if (params.language && params.language.trim()) {
      terms.push(`language:${sanitizeSearchToken(params.language)}`);
    }
    if (params.topic && params.topic.trim()) {
      terms.push(`label:${sanitizeSearchToken(params.topic)}`);
    }
    if (params.query && params.query.trim()) {
      terms.push(sanitizeSearchToken(params.query));
    }

    const searchParams = new URLSearchParams({
      q: terms.join(' '),
      sort: 'updated',
      order: 'desc',
      per_page: String(Math.min(50, Math.max(1, params.perPage ?? 20))),
    });
    const url = `${this.baseUrl}/search/issues?${searchParams.toString()}`;
    const etag = params.etag !== undefined ? params.etag : this.etagByUrl.get(url) ?? null;

    return this.singleflight(`issues:${url}:${etag ?? ''}`, async () => {
      const res = await this.enqueueRequest(url, etag);
      if (res.status === 304) {
        return {
          notModified: true,
          etag: res.etag ?? etag,
          checkedAt: res.checkedAt,
          rateLimit: res.rateLimit,
        };
      }
      const data = res.body as {
        total_count?: unknown;
        incomplete_results?: unknown;
        items?: unknown;
      };
      const rawItems = Array.isArray(data?.items) ? (data.items as RawGitHubIssue[]) : [];
      const items = rawItems
        .map(raw => mapRawIssue(raw))
        .filter((item): item is GitHubIssueItem => item !== null && !item.isPullRequest && item.sourceState === 'open');
      return {
        notModified: false,
        etag: res.etag,
        checkedAt: res.checkedAt,
        rateLimit: res.rateLimit,
        totalCount: typeof data?.total_count === 'number' ? data.total_count : items.length,
        incompleteResults: Boolean(data?.incomplete_results),
        items,
      };
    });
  }

  async getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    etag?: string | null,
  ): Promise<GitHubGetIssueResult> {
    const cleanOwner = encodeURIComponent(owner);
    const cleanRepo = encodeURIComponent(repo);
    const url = `${this.baseUrl}/repos/${cleanOwner}/${cleanRepo}/issues/${issueNumber}`;
    const effectiveEtag = etag !== undefined ? etag : this.etagByUrl.get(url) ?? null;

    return this.singleflight(`issue:${url}:${effectiveEtag ?? ''}`, async () => {
      const res = await this.enqueueRequest(url, effectiveEtag, { allowNotFound: true });
      if (res.status === 304) {
        return {
          status: 'not_modified',
          etag: res.etag ?? effectiveEtag,
          checkedAt: res.checkedAt,
          rateLimit: res.rateLimit,
        };
      }
      if (res.status === 404 || res.status === 410) {
        return {
          status: 'deleted_or_inaccessible',
          httpStatus: res.status,
          checkedAt: res.checkedAt,
          rateLimit: res.rateLimit,
        };
      }
      const mapped = mapRawIssue(res.body as RawGitHubIssue, `${owner}/${repo}`);
      if (!mapped) {
        throw new ServiceError('EXTERNAL_UNAVAILABLE', 'GitHub 이슈 응답 형식을 해석하지 못했어요.');
      }
      return {
        status: 'ok',
        etag: res.etag,
        checkedAt: res.checkedAt,
        rateLimit: res.rateLimit,
        issue: mapped,
      };
    });
  }

  private singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      return existing;
    }
    const promise = fn().finally(() => {
      this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private enqueueRequest(
    url: string,
    etag: string | null,
    options: { allowNotFound?: boolean } = {},
  ): Promise<{
    status: number;
    etag: string | null;
    checkedAt: string;
    rateLimit: GitHubRateLimitInfo;
    body: unknown;
  }> {
    const run = () => this.executeFetch(url, etag, options);
    const next = this.queueTail.then(run, run);
    // Keep queue serial regardless of individual request errors.
    this.queueTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async executeFetch(
    url: string,
    etag: string | null,
    options: { allowNotFound?: boolean },
  ): Promise<{
    status: number;
    etag: string | null;
    checkedAt: string;
    rateLimit: GitHubRateLimitInfo;
    body: unknown;
  }> {
    const nowMs = this.clock.now().getTime();
    if (nowMs < this.cooldownUntilMs) {
      const remainingSec = Math.max(1, Math.ceil((this.cooldownUntilMs - nowMs) / 1000));
      throw new ServiceError(
        'RATE_LIMITED',
        `GitHub 공개 API 요청 한도 쿨다운 중입니다(${remainingSec}초 후 재시도).`,
        undefined,
        {
          cooldownUntil: new Date(this.cooldownUntilMs).toISOString(),
          retryAfterSeconds: remainingSec,
        },
      );
    }

    // Explicitly construct clean headers without Authorization and without credentials.
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github+json',
      'User-Agent': this.userAgent,
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (etag) {
      headers['If-None-Match'] = etag;
    }

    let response: Response;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      response = await this.fetchImpl(url, {
        method: 'GET',
        headers,
        credentials: 'omit',
        signal: controller.signal,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceError(
        'EXTERNAL_UNAVAILABLE',
        `GitHub 공개 API에 연결할 수 없어요: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }

    const afterMs = this.clock.now().getTime();
    const checkedAt = new Date(afterMs).toISOString();
    const rateLimit = extractRateLimitInfo(response.headers, afterMs);
    this.lastRateLimit = rateLimit;
    const responseEtag = response.headers.get('etag');

    if (response.status === 403 || response.status === 429) {
      this.activateCooldown(afterMs, rateLimit);
      throw new ServiceError(
        'RATE_LIMITED',
        `GitHub 공개 API 요청 한도(${response.status})에 도달해 쿨다운으로 전환했어요.`,
        undefined,
        {
          httpStatus: response.status,
          cooldownUntil: new Date(this.cooldownUntilMs).toISOString(),
          rateLimit,
        },
      );
    }

    if (response.status === 304) {
      if (responseEtag) {
        this.etagByUrl.set(url, responseEtag);
      }
      return {
        status: 304,
        etag: responseEtag ?? etag,
        checkedAt,
        rateLimit,
        body: null,
      };
    }

    if ((response.status === 404 || response.status === 410) && options.allowNotFound) {
      return {
        status: response.status,
        etag: responseEtag,
        checkedAt,
        rateLimit,
        body: null,
      };
    }

    if (!response.ok) {
      throw new ServiceError(
        'EXTERNAL_UNAVAILABLE',
        `GitHub 공개 API가 오류 응답(${response.status})을 반환했어요.`,
        undefined,
        { httpStatus: response.status, rateLimit },
      );
    }

    if (responseEtag) {
      this.etagByUrl.set(url, responseEtag);
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ServiceError('EXTERNAL_UNAVAILABLE', 'GitHub 공개 API JSON 응답을 해석하지 못했어요.');
    }

    return {
      status: response.status,
      etag: responseEtag,
      checkedAt,
      rateLimit,
      body,
    };
  }

  private activateCooldown(nowMs: number, rateLimit: GitHubRateLimitInfo): void {
    let targetMs = nowMs + this.defaultCooldownMs;
    if (rateLimit.retryAfterSeconds !== null) {
      targetMs = nowMs + rateLimit.retryAfterSeconds * 1000;
    } else if (rateLimit.remaining === 0 && rateLimit.resetAt) {
      const resetMs = Date.parse(rateLimit.resetAt);
      if (!Number.isNaN(resetMs) && resetMs > nowMs) {
        targetMs = resetMs;
      }
    }
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, targetMs);
  }
}
