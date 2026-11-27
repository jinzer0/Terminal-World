import {
  DemoIssueExplainer,
  type IssueExplainer,
  type IssueExplanationResult,
} from '../discovery/demo-explainer.js';
import {
  GitHubClient,
  type GitHubIssueItem,
  type GitHubRepoItem,
} from '../discovery/github-client.js';
import { SEED_ISSUES, SEED_REPOS } from '../discovery/seed-snapshot.js';
import type { WorldDatabase } from '../store/sqlite/database.js';
import { type Clock, DAY_MS, SystemClock } from './clock.js';
import { ServiceError, type ServiceErrorCode } from './errors.js';

export type RepoSizeTier = 'small' | 'medium' | 'large' | 'unknown';
export type DataOrigin = 'live_github' | 'seed_snapshot';
export type ExternalIssueState = 'open' | 'closed' | 'deleted_or_inaccessible';

export const LIST_CACHE_TTL_MS = 30 * 60 * 1000;
export const DETAIL_CACHE_TTL_MS = 10 * 60 * 1000;
export const NEWBORN_MAX_AGE_DAYS = 365;
export const TREND_WINDOW_DAYS = 7;
export const DEFAULT_MIN_TREND_SPAN_MS = DAY_MS;

export interface StarObservation {
  observedAt: string;
  starsCount: number;
}

export interface SevenDayTrendSummary {
  netStarGain: number | null;
  status: 'classified' | '미분류';
  windowDays: number;
  observationCount: number;
  earliestObservedAt: string | null;
  latestObservedAt: string | null;
}

export interface OpenSourceRepoView {
  fullName: string;
  sourceUrl: string;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  licenseConfirmed: boolean;
  starsCount: number | null;
  repoCreatedAt: string | null;
  sizeTier: RepoSizeTier;
  sizeTierLabel: string;
  isNewborn: boolean | null;
  newbornLabel: '신생(365일 미만)' | '기존(365일 이상)' | '미분류';
  trend7d: number | null;
  trend7dLabel: string;
  trendObservationCount: number;
  checkedAt: string;
  etag: string | null;
  dataOrigin: DataOrigin;
  stale: boolean;
}

export interface ExternalIssueView {
  id: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  sourceUrl: string;
  sourceState: ExternalIssueState;
  assignees: string[];
  linkedPrs: string[];
  recentActivityAt: string | null;
  checkedAt: string;
  dataOrigin: DataOrigin;
  untrustedContent: true;
  repo: OpenSourceRepoView;
}

export interface ClassificationCriteria {
  sizeTierRule: string;
  newbornRule: string;
  trendRule: string;
  unclassifiedPolicy: string;
}

export const CONFIRMED_CLASSIFICATION_CRITERIA: ClassificationCriteria = {
  sizeTierRule: '소규모 0~999 스타 · 중규모 1,000~9,999 스타 · 대규모 10,000+ 스타 (관측 0과 미확인 구분)',
  newbornRule: 'GitHub 저장소 생성일(created_at) 기준 365일 미만 (미확인 시 미분류)',
  trendRule: '동일 저장소의 최근 7일 관찰 창(repo_star_observations 2시점 이상) 스타 수 순증 (누적 스타·최근 push 대체 금지)',
  unclassifiedPolicy: '기준 미확인 또는 관측 부족 항목은 미분류로 표시',
};

export interface PopularReposQuery {
  language?: string;
  topic?: string;
  query?: string;
  limit?: number;
  forceRefresh?: boolean;
}

export interface PopularReposResult {
  items: OpenSourceRepoView[];
  checkedAt: string;
  dataOrigin: DataOrigin;
  stale: boolean;
  latestUnconfirmed: boolean;
  fallbackErrorCode: ServiceErrorCode | null;
  scopeNote: string;
  classificationCriteria: ClassificationCriteria;
}

export interface ContributionIssuesQuery {
  language?: string;
  topic?: string;
  query?: string;
  sizeTier?: RepoSizeTier;
  newbornOnly?: boolean;
  limit?: number;
  forceRefresh?: boolean;
}

export interface ContributionIssuesResult {
  items: ExternalIssueView[];
  checkedAt: string;
  dataOrigin: DataOrigin;
  stale: boolean;
  latestUnconfirmed: boolean;
  fallbackErrorCode: ServiceErrorCode | null;
  selectionPolicyNote: string;
  classificationCriteria: ClassificationCriteria;
}

export interface IssueDetailResult {
  issue: ExternalIssueView;
  stale: boolean;
  latestUnconfirmed: boolean;
  fallbackErrorCode: ServiceErrorCode | null;
  statusNotice: string | null;
}

export interface ExplainIssueResult {
  issue: ExternalIssueView;
  explanation: IssueExplanationResult;
  stale: boolean;
  latestUnconfirmed: boolean;
  fallbackErrorCode: ServiceErrorCode | null;
  statusNotice: string | null;
}

export interface DiscoveryServiceOptions {
  githubClient?: GitHubClient;
  explainer?: IssueExplainer;
  clock?: Clock;
  listCacheTtlMs?: number;
  detailCacheTtlMs?: number;
  minTrendSpanMs?: number;
  autoSeed?: boolean;
}

interface RepoRow {
  full_name: string;
  source_url: string;
  language: string | null;
  topics_json: string;
  license_spdx: string | null;
  stars_count: number | null;
  repo_created_at: string | null;
  size_tier: RepoSizeTier;
  is_newborn: number | null;
  checked_at: string;
  etag: string | null;
  data_origin: DataOrigin;
  stale: number;
}

interface IssueRow {
  id: string;
  repo_full_name: string;
  issue_number: number;
  title: string;
  body_excerpt: string;
  labels_json: string;
  source_url: string;
  source_state: ExternalIssueState;
  assignees_json: string;
  linked_prs_json: string;
  recent_activity_at: string | null;
  checked_at: string;
  data_origin: DataOrigin;
}

interface QueryCacheEntry {
  checkedAtMs: number;
  etag: string | null;
  repoKeys?: string[];
  issueIds?: string[];
}

/**
 * Classifies repository popularity size tier per confirmed D-01 Q-01/Q-02 rules.
 * Distinguishes observed `0` stars ('small') from unknown `null`/`undefined` ('unknown').
 */
export function classifyRepoSizeTier(starsCount: number | null | undefined): RepoSizeTier {
  if (starsCount === null || starsCount === undefined || !Number.isFinite(starsCount) || starsCount < 0) {
    return 'unknown';
  }
  if (starsCount <= 999) return 'small';
  if (starsCount <= 9_999) return 'medium';
  return 'large';
}

export function formatSizeTierLabel(tier: RepoSizeTier): string {
  switch (tier) {
    case 'small':
      return '소규모(0~999)';
    case 'medium':
      return '중규모(1,000~9,999)';
    case 'large':
      return '대규모(10,000+)';
    case 'unknown':
      return '미분류';
  }
}

/**
 * Classifies newborn status per confirmed D-01 Q-03 rule (< 365 days before `now`).
 * Missing or invalid creation date returns `null` (미분류).
 */
export function classifyNewborn(
  repoCreatedAt: string | null | undefined,
  now: Date,
): boolean | null {
  if (!repoCreatedAt) return null;
  const createdMs = Date.parse(repoCreatedAt);
  if (Number.isNaN(createdMs)) return null;
  const ageMs = now.getTime() - createdMs;
  if (ageMs < 0) return true;
  return ageMs < NEWBORN_MAX_AGE_DAYS * DAY_MS;
}

export function formatNewbornLabel(
  isNewborn: boolean | null,
): '신생(365일 미만)' | '기존(365일 이상)' | '미분류' {
  if (isNewborn === null) return '미분류';
  return isNewborn ? '신생(365일 미만)' : '기존(365일 이상)';
}

/**
 * Computes 7-day net star gain from `repo_star_observations` per confirmed D-01 Q-04 rule.
 * Requires 2+ observations inside the [now - 7d, now] window spanning at least `minSpanMs`.
 * Never substitutes cumulative stars or recent push timestamps.
 */
export function computeSevenDayTrend(
  observations: readonly StarObservation[],
  now: Date,
  minSpanMs: number = DEFAULT_MIN_TREND_SPAN_MS,
): SevenDayTrendSummary {
  const nowMs = now.getTime();
  const windowStartMs = nowMs - TREND_WINDOW_DAYS * DAY_MS;

  const valid = observations
    .map(obs => ({
      observedAt: obs.observedAt,
      ms: Date.parse(obs.observedAt),
      starsCount: obs.starsCount,
    }))
    .filter(
      obs =>
        !Number.isNaN(obs.ms) &&
        Number.isFinite(obs.starsCount) &&
        obs.ms >= windowStartMs &&
        obs.ms <= nowMs,
    )
    .sort((a, b) => a.ms - b.ms);

  if (valid.length < 2) {
    return {
      netStarGain: null,
      status: '미분류',
      windowDays: TREND_WINDOW_DAYS,
      observationCount: valid.length,
      earliestObservedAt: valid[0]?.observedAt ?? null,
      latestObservedAt: valid[valid.length - 1]?.observedAt ?? null,
    };
  }

  const earliest = valid[0]!;
  const latest = valid[valid.length - 1]!;
  if (latest.ms - earliest.ms < minSpanMs) {
    return {
      netStarGain: null,
      status: '미분류',
      windowDays: TREND_WINDOW_DAYS,
      observationCount: valid.length,
      earliestObservedAt: earliest.observedAt,
      latestObservedAt: latest.observedAt,
    };
  }

  return {
    netStarGain: latest.starsCount - earliest.starsCount,
    status: 'classified',
    windowDays: TREND_WINDOW_DAYS,
    observationCount: valid.length,
    earliestObservedAt: earliest.observedAt,
    latestObservedAt: latest.observedAt,
  };
}

function parseIssueId(issueId: string): { repoFullName: string; owner: string; repo: string; issueNumber: number } {
  const trimmed = issueId.trim();
  const match = /^([^/\s#]+\/[^/\s#]+)#(\d+)$/.exec(trimmed);
  if (!match) {
    throw new ServiceError(
      'INVALID_INPUT',
      '이슈 식별자는 owner/repo#번호 형식으로 입력해 주세요.',
      'issueId',
    );
  }
  const repoFullName = match[1]!;
  const issueNumber = Number(match[2]!);
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new ServiceError('INVALID_INPUT', '올바른 이슈 번호를 입력해 주세요.', 'issueId');
  }
  const [owner, repo] = repoFullName.split('/') as [string, string];
  return { repoFullName, owner, repo, issueNumber };
}

function parseJsonStringArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function scoreIssuePriority(issue: ExternalIssueView): number {
  let score = 0;
  switch (issue.repo.sizeTier) {
    case 'small':
      score += 100;
      break;
    case 'medium':
      score += 80;
      break;
    case 'unknown':
      score += 40;
      break;
    case 'large':
      score += 0;
      break;
  }
  if (issue.repo.isNewborn === true) {
    score += 20;
  } else if (issue.repo.isNewborn === false) {
    score += 5;
  }
  if (issue.repo.licenseConfirmed) {
    score += 5;
  }
  if (issue.repo.trend7d !== null && issue.repo.trend7d > 0) {
    score += 3;
  }
  return score;
}

export class DiscoveryService {
  private readonly githubClient: GitHubClient;
  private readonly explainer: IssueExplainer;
  private readonly clock: Clock;
  private readonly listCacheTtlMs: number;
  private readonly detailCacheTtlMs: number;
  private readonly minTrendSpanMs: number;

  private readonly listCache = new Map<string, QueryCacheEntry>();
  private readonly inFlightOperations = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: WorldDatabase,
    options: DiscoveryServiceOptions = {},
  ) {
    this.clock = options.clock ?? new SystemClock();
    this.githubClient = options.githubClient ?? new GitHubClient({ clock: this.clock });
    this.explainer = options.explainer ?? new DemoIssueExplainer();
    this.listCacheTtlMs = options.listCacheTtlMs ?? LIST_CACHE_TTL_MS;
    this.detailCacheTtlMs = options.detailCacheTtlMs ?? DETAIL_CACHE_TTL_MS;
    this.minTrendSpanMs = options.minTrendSpanMs ?? DEFAULT_MIN_TREND_SPAN_MS;

    if (options.autoSeed ?? true) {
      this.loadSeedSnapshot();
    }
  }

  /**
   * Loads curated seed repositories, star observations, and open issues with
   * `dataOrigin = 'seed_snapshot'` without overwriting newer `live_github` rows.
   */
  loadSeedSnapshot(): void {
    this.db.transaction(() => {
      const upsertRepo = this.db.db.prepare(`
        INSERT INTO opensource_repos (
          full_name, source_url, language, topics_json, license_spdx,
          stars_count, repo_created_at, size_tier, is_newborn,
          checked_at, etag, data_origin, stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'seed_snapshot', 0)
        ON CONFLICT(full_name) DO UPDATE SET
          source_url = excluded.source_url,
          language = excluded.language,
          topics_json = excluded.topics_json,
          license_spdx = excluded.license_spdx,
          stars_count = excluded.stars_count,
          repo_created_at = excluded.repo_created_at,
          size_tier = excluded.size_tier,
          is_newborn = excluded.is_newborn,
          checked_at = excluded.checked_at,
          data_origin = 'seed_snapshot',
          stale = 0
        WHERE opensource_repos.data_origin != 'live_github'
      `);

      const insertObservation = this.db.db.prepare(`
        INSERT OR IGNORE INTO repo_star_observations (full_name, observed_at, stars_count)
        VALUES (?, ?, ?)
      `);

      const now = this.clock.now();
      for (const repo of SEED_REPOS) {
        const sizeTier = classifyRepoSizeTier(repo.starsCount);
        const isNewborn = classifyNewborn(repo.repoCreatedAt, now);
        upsertRepo.run(
          repo.fullName,
          repo.sourceUrl,
          repo.language,
          JSON.stringify(repo.topics),
          repo.licenseSpdx,
          repo.starsCount,
          repo.repoCreatedAt,
          sizeTier,
          isNewborn === null ? null : isNewborn ? 1 : 0,
          repo.checkedAt,
        );
        for (const obs of repo.observations) {
          insertObservation.run(repo.fullName, obs.observedAt, obs.starsCount);
        }
      }

      const upsertIssue = this.db.db.prepare(`
        INSERT INTO external_issues (
          id, repo_full_name, issue_number, title, body_excerpt, labels_json,
          source_url, source_state, assignees_json, linked_prs_json,
          recent_activity_at, checked_at, data_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'seed_snapshot')
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          body_excerpt = excluded.body_excerpt,
          labels_json = excluded.labels_json,
          source_url = excluded.source_url,
          source_state = excluded.source_state,
          assignees_json = excluded.assignees_json,
          linked_prs_json = excluded.linked_prs_json,
          recent_activity_at = excluded.recent_activity_at,
          checked_at = excluded.checked_at,
          data_origin = 'seed_snapshot'
        WHERE external_issues.data_origin != 'live_github'
      `);

      for (const issue of SEED_ISSUES) {
        upsertIssue.run(
          issue.id,
          issue.repoFullName,
          issue.issueNumber,
          issue.title,
          issue.bodyExcerpt,
          JSON.stringify(issue.labels),
          issue.sourceUrl,
          issue.sourceState,
          JSON.stringify(issue.assignees),
          JSON.stringify(issue.linkedPrs),
          issue.recentActivityAt,
          issue.checkedAt,
        );
      }
    });
  }

  recordStarObservation(fullName: string, observedAt: string, starsCount: number): void {
    this.db.db
      .prepare(`
        INSERT INTO repo_star_observations (full_name, observed_at, stars_count)
        VALUES (?, ?, ?)
        ON CONFLICT(full_name, observed_at) DO UPDATE SET
          stars_count = excluded.stars_count
      `)
      .run(fullName, observedAt, starsCount);
  }

  /**
   * Lists public popular repositories ordered by cumulative stars descending (includes large repos).
   * Explicitly separated from small/medium & newborn prioritized contribution issue search.
   */
  async listPopularRepos(options: PopularReposQuery = {}): Promise<PopularReposResult> {
    const cacheKey = this.buildPopularCacheKey(options);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const now = this.clock.now();
    const nowMs = now.getTime();
    const cached = this.listCache.get(cacheKey);

    if (!options.forceRefresh && cached && nowMs - cached.checkedAtMs < this.listCacheTtlMs) {
      const cachedRepos = this.queryStoredRepos(options, {
        dataOrigin: 'live_github',
        fullNames: cached.repoKeys,
        limit,
      });
      return {
        items: cachedRepos,
        checkedAt: new Date(cached.checkedAtMs).toISOString(),
        dataOrigin: 'live_github',
        stale: false,
        latestUnconfirmed: false,
        fallbackErrorCode: null,
        scopeNote:
          '질의 조건에 해당하는 공개 저장소 누적 스타 순위(대규모 포함)이며 전체 GitHub 순위나 최근 7일 추세를 의미하지 않습니다.',
        classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
      };
    }

    return this.deduplicateOperation(`popular:${cacheKey}:${limit}:${Boolean(options.forceRefresh)}`, async () => {
      try {
        const res = await this.githubClient.searchRepositories({
          language: options.language,
          topic: options.topic,
          query: options.query,
          sort: 'stars',
          order: 'desc',
          perPage: limit,
          etag: cached?.etag ?? null,
        });

        if (res.notModified) {
          const checkedAtMs = Date.parse(res.checkedAt);
          this.listCache.set(cacheKey, {
            checkedAtMs: Number.isNaN(checkedAtMs) ? nowMs : checkedAtMs,
            etag: res.etag,
            repoKeys: cached?.repoKeys,
          });
          if (cached?.repoKeys && cached.repoKeys.length > 0) {
            this.touchReposCheckedAt(cached.repoKeys, res.checkedAt);
          }
          const items = this.queryStoredRepos(options, {
            dataOrigin: 'live_github',
            fullNames: cached?.repoKeys,
            limit,
          });
          return {
            items,
            checkedAt: res.checkedAt,
            dataOrigin: 'live_github',
            stale: false,
            latestUnconfirmed: false,
            fallbackErrorCode: null,
            scopeNote:
              '질의 조건에 해당하는 공개 저장소 누적 스타 순위(대규모 포함)이며 전체 GitHub 순위나 최근 7일 추세를 의미하지 않습니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        const repoKeys = res.items.map(r => r.fullName);
        this.upsertLiveRepos(res.items, res.checkedAt);
        const checkedAtMs = Date.parse(res.checkedAt);
        this.listCache.set(cacheKey, {
          checkedAtMs: Number.isNaN(checkedAtMs) ? nowMs : checkedAtMs,
          etag: res.etag,
          repoKeys,
        });

        const items = this.queryStoredRepos(options, {
          dataOrigin: 'live_github',
          fullNames: repoKeys,
          limit,
        });

        return {
          items,
          checkedAt: res.checkedAt,
          dataOrigin: 'live_github',
          stale: false,
          latestUnconfirmed: false,
          fallbackErrorCode: null,
          scopeNote:
            '질의 조건에 해당하는 공개 저장소 누적 스타 순위(대규모 포함)이며 전체 GitHub 순위나 최근 7일 추세를 의미하지 않습니다.',
          classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
        };
      } catch (err) {
        const serviceErr = this.asExternalOrRateLimitError(err);
        const fallbackLive = this.queryStoredRepos(options, {
          dataOrigin: 'live_github',
          fullNames: cached?.repoKeys,
          limit,
          markStale: true,
        });
        if (fallbackLive.length > 0) {
          return {
            items: fallbackLive,
            checkedAt: fallbackLive[0]!.checkedAt,
            dataOrigin: 'live_github',
            stale: true,
            latestUnconfirmed: true,
            fallbackErrorCode: serviceErr.code,
            scopeNote:
              '외부 조회 지연/한도로 인해 마지막 확인 캐시 자료를 표시합니다. 최신 여부는 미확인입니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        const fallbackSeed = this.queryStoredRepos(options, {
          dataOrigin: 'seed_snapshot',
          limit,
          markStale: true,
        });
        if (fallbackSeed.length > 0) {
          return {
            items: fallbackSeed,
            checkedAt: fallbackSeed[0]!.checkedAt,
            dataOrigin: 'seed_snapshot',
            stale: true,
            latestUnconfirmed: true,
            fallbackErrorCode: serviceErr.code,
            scopeNote:
              '외부 조회 지연/한도로 인해 내장 시드 스냅샷을 표시합니다. 최신 순위/상태가 아닐 수 있습니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        throw serviceErr;
      }
    });
  }

  /**
   * Searches open contribution issues (`is:issue is:open`), excluding PRs, closed,
   * and deleted/inaccessible issues, and prioritizing small/medium & newborn repos.
   */
  async searchContributionIssues(
    options: ContributionIssuesQuery = {},
  ): Promise<ContributionIssuesResult> {
    const cacheKey = this.buildIssuesCacheKey(options);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const now = this.clock.now();
    const nowMs = now.getTime();
    const cached = this.listCache.get(cacheKey);

    if (!options.forceRefresh && cached && nowMs - cached.checkedAtMs < this.listCacheTtlMs) {
      const cachedIssues = this.queryStoredOpenIssues(options, {
        dataOrigin: 'live_github',
        issueIds: cached.issueIds,
        limit,
      });
      return {
        items: cachedIssues,
        checkedAt: new Date(cached.checkedAtMs).toISOString(),
        dataOrigin: 'live_github',
        stale: false,
        latestUnconfirmed: false,
        fallbackErrorCode: null,
        selectionPolicyNote:
          '열린 이슈만 표시하며 PR·닫힘·삭제/접근 불가 이슈는 제외하고 중소규모·신생(365일 미만) 저장소를 우선 정렬합니다.',
        classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
      };
    }

    return this.deduplicateOperation(`issues:${cacheKey}:${limit}:${Boolean(options.forceRefresh)}`, async () => {
      try {
        const res = await this.githubClient.searchIssues({
          language: options.language,
          topic: options.topic,
          query: options.query,
          perPage: limit,
          etag: cached?.etag ?? null,
        });

        if (res.notModified) {
          const checkedAtMs = Date.parse(res.checkedAt);
          this.listCache.set(cacheKey, {
            checkedAtMs: Number.isNaN(checkedAtMs) ? nowMs : checkedAtMs,
            etag: res.etag,
            issueIds: cached?.issueIds,
          });
          if (cached?.issueIds && cached.issueIds.length > 0) {
            this.touchIssuesCheckedAt(cached.issueIds, res.checkedAt);
          }
          const items = this.queryStoredOpenIssues(options, {
            dataOrigin: 'live_github',
            limit,
          });
          return {
            items,
            checkedAt: res.checkedAt,
            dataOrigin: 'live_github',
            stale: false,
            latestUnconfirmed: false,
            fallbackErrorCode: null,
            selectionPolicyNote:
              '열린 이슈만 표시하며 PR·닫힘·삭제/접근 불가 이슈는 제외하고 중소규모·신생(365일 미만) 저장소를 우선 정렬합니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        const issueIds = res.items.map(i => i.id);
        this.upsertLiveIssues(res.items, res.checkedAt);
        const checkedAtMs = Date.parse(res.checkedAt);
        this.listCache.set(cacheKey, {
          checkedAtMs: Number.isNaN(checkedAtMs) ? nowMs : checkedAtMs,
          etag: res.etag,
          issueIds,
        });

        const items = this.queryStoredOpenIssues(options, {
          dataOrigin: 'live_github',
          issueIds,
          limit,
        });

        return {
          items,
          checkedAt: res.checkedAt,
          dataOrigin: 'live_github',
          stale: false,
          latestUnconfirmed: false,
          fallbackErrorCode: null,
          selectionPolicyNote:
            '열린 이슈만 표시하며 PR·닫힘·삭제/접근 불가 이슈는 제외하고 중소규모·신생(365일 미만) 저장소를 우선 정렬합니다.',
          classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
        };
      } catch (err) {
        const serviceErr = this.asExternalOrRateLimitError(err);
        const fallbackLive = this.queryStoredOpenIssues(options, {
          dataOrigin: 'live_github',
          limit,
        });
        if (fallbackLive.length > 0) {
          return {
            items: fallbackLive,
            checkedAt: fallbackLive[0]!.checkedAt,
            dataOrigin: 'live_github',
            stale: true,
            latestUnconfirmed: true,
            fallbackErrorCode: serviceErr.code,
            selectionPolicyNote:
              '외부 조회 지연/한도로 인해 마지막 확인 캐시 자료를 표시합니다. 최신 상태는 미확인입니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        const fallbackSeed = this.queryStoredOpenIssues(options, {
          dataOrigin: 'seed_snapshot',
          limit,
        });
        if (fallbackSeed.length > 0) {
          return {
            items: fallbackSeed,
            checkedAt: fallbackSeed[0]!.checkedAt,
            dataOrigin: 'seed_snapshot',
            stale: true,
            latestUnconfirmed: true,
            fallbackErrorCode: serviceErr.code,
            selectionPolicyNote:
              '외부 조회 지연/한도로 인해 내장 시드 스냅샷을 표시합니다. 최신 상태가 아닐 수 있습니다.',
            classificationCriteria: CONFIRMED_CLASSIFICATION_CRITERIA,
          };
        }

        throw serviceErr;
      }
    });
  }

  /**
   * Fetches/revalidates a single issue (`owner/repo#number`) with 10-minute detail TTL.
   * Updates `closed` or `deleted_or_inaccessible` (404/410) in SQLite so closed/deleted issues
   * are excluded from open contribution search results.
   */
  async getIssueDetail(
    issueId: string,
    options: { forceRefresh?: boolean } = {},
  ): Promise<IssueDetailResult> {
    const parsed = parseIssueId(issueId);
    const canonicalId = `${parsed.repoFullName}#${parsed.issueNumber}`;
    const existing = this.getStoredIssueView(canonicalId);
    const nowMs = this.clock.now().getTime();

    if (
      !options.forceRefresh &&
      existing &&
      existing.dataOrigin === 'live_github' &&
      nowMs - Date.parse(existing.checkedAt) < this.detailCacheTtlMs
    ) {
      return {
        issue: existing,
        stale: false,
        latestUnconfirmed: false,
        fallbackErrorCode: null,
        statusNotice: this.buildIssueStateNotice(existing.sourceState),
      };
    }

    return this.deduplicateOperation(`detail:${canonicalId}:${Boolean(options.forceRefresh)}`, async () => {
      try {
        const res = await this.githubClient.getIssue(
          parsed.owner,
          parsed.repo,
          parsed.issueNumber,
          existing?.repo.etag ?? null,
        );

        if (res.status === 'not_modified') {
          if (existing) {
            this.touchIssuesCheckedAt([canonicalId], res.checkedAt);
            const updated = this.getStoredIssueView(canonicalId) ?? existing;
            return {
              issue: updated,
              stale: false,
              latestUnconfirmed: false,
              fallbackErrorCode: null,
              statusNotice: this.buildIssueStateNotice(updated.sourceState),
            };
          }
          throw new ServiceError('NOT_FOUND', '이슈 상세 캐시를 찾을 수 없습니다.', 'issueId');
        }

        if (res.status === 'deleted_or_inaccessible') {
          if (existing) {
            this.db.db
              .prepare(`
                UPDATE external_issues
                SET source_state = 'deleted_or_inaccessible',
                    checked_at = ?,
                    data_origin = 'live_github'
                WHERE id = ?
              `)
              .run(res.checkedAt, canonicalId);
            const updated = this.getStoredIssueView(canonicalId)!;
            return {
              issue: updated,
              stale: false,
              latestUnconfirmed: false,
              fallbackErrorCode: null,
              statusNotice: this.buildIssueStateNotice('deleted_or_inaccessible'),
            };
          }
          throw new ServiceError(
            'NOT_FOUND',
            `이슈(${canonicalId})가 삭제되었거나 접근할 수 없습니다 (${res.httpStatus}).`,
            'issueId',
          );
        }

        if (res.issue.isPullRequest) {
          if (existing) {
            this.db.db
              .prepare(`
                UPDATE external_issues
                SET source_state = 'deleted_or_inaccessible',
                    checked_at = ?,
                    data_origin = 'live_github'
                WHERE id = ?
              `)
              .run(res.checkedAt, canonicalId);
          }
          throw new ServiceError(
            'NOT_FOUND',
            `${canonicalId}은(는) 이슈가 아닌 Pull Request이므로 이슈 탐색 대상에서 제외됩니다.`,
            'issueId',
          );
        }

        this.upsertLiveIssues([res.issue], res.checkedAt);
        const updated = this.getStoredIssueView(canonicalId)!;
        return {
          issue: updated,
          stale: false,
          latestUnconfirmed: false,
          fallbackErrorCode: null,
          statusNotice: this.buildIssueStateNotice(updated.sourceState),
        };
      } catch (err) {
        if (err instanceof ServiceError && (err.code === 'NOT_FOUND' || err.code === 'INVALID_INPUT')) {
          throw err;
        }
        const serviceErr = this.asExternalOrRateLimitError(err);
        if (existing) {
          const staleRepo: OpenSourceRepoView = { ...existing.repo, stale: true };
          const staleIssue: ExternalIssueView = { ...existing, repo: staleRepo };
          return {
            issue: staleIssue,
            stale: true,
            latestUnconfirmed: true,
            fallbackErrorCode: serviceErr.code,
            statusNotice:
              this.buildIssueStateNotice(existing.sourceState) ??
              '외부 조회 지연/한도로 인해 마지막 확인 자료를 표시합니다. 최신 여부는 미확인입니다.',
          };
        }
        throw serviceErr;
      }
    });
  }

  /**
   * Produces a Demo AI explanation for an issue while always preserving raw issue access
   * even when `explanation.availabilityState === 'unavailable'`.
   */
  async explainIssue(
    issueId: string,
    options: {
      criteria?: { language?: string; topic?: string; query?: string };
      forceRefresh?: boolean;
    } = {},
  ): Promise<ExplainIssueResult> {
    const detail = await this.getIssueDetail(issueId, { forceRefresh: options.forceRefresh });
    const explanation = await this.explainer.explain({
      issue: {
        id: detail.issue.id,
        repoFullName: detail.issue.repoFullName,
        issueNumber: detail.issue.issueNumber,
        title: detail.issue.title,
        bodyExcerpt: detail.issue.bodyExcerpt,
        labels: detail.issue.labels,
        sourceUrl: detail.issue.sourceUrl,
        sourceState: detail.issue.sourceState,
        assignees: detail.issue.assignees,
        linkedPrs: detail.issue.linkedPrs,
        recentActivityAt: detail.issue.recentActivityAt,
        checkedAt: detail.issue.checkedAt,
      },
      repo: {
        fullName: detail.issue.repo.fullName,
        sourceUrl: detail.issue.repo.sourceUrl,
        language: detail.issue.repo.language,
        topics: detail.issue.repo.topics,
        licenseSpdx: detail.issue.repo.licenseSpdx,
        starsCount: detail.issue.repo.starsCount,
        sizeTier: detail.issue.repo.sizeTier,
        isNewborn: detail.issue.repo.isNewborn,
        trend7d: detail.issue.repo.trend7d,
      },
      criteria: options.criteria,
    });

    this.db.db
      .prepare(`
        INSERT INTO issue_explanations (
          issue_id, source_checked_at, mode, availability_state,
          summary, background_knowledge, recommendation_reason,
          evidence_links_json, demo_authored_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(issue_id, source_checked_at) DO UPDATE SET
          mode = excluded.mode,
          availability_state = excluded.availability_state,
          summary = excluded.summary,
          background_knowledge = excluded.background_knowledge,
          recommendation_reason = excluded.recommendation_reason,
          evidence_links_json = excluded.evidence_links_json,
          demo_authored_at = excluded.demo_authored_at
      `)
      .run(
        explanation.issueId,
        explanation.sourceCheckedAt,
        explanation.mode,
        explanation.availabilityState,
        explanation.summary,
        explanation.backgroundKnowledge,
        explanation.recommendationReason,
        JSON.stringify(explanation.evidenceLinks),
        explanation.demoAuthoredAt,
      );

    return {
      issue: detail.issue,
      explanation,
      stale: detail.stale,
      latestUnconfirmed: detail.latestUnconfirmed,
      fallbackErrorCode: detail.fallbackErrorCode,
      statusNotice: detail.statusNotice,
    };
  }

  private buildIssueStateNotice(state: ExternalIssueState): string | null {
    if (state === 'closed') {
      return '이 이슈는 닫힘(closed) 상태가 확인되어 열린 후보 목록에서 제외되었습니다.';
    }
    if (state === 'deleted_or_inaccessible') {
      return '이 이슈는 삭제되었거나 접근할 수 없는 상태(404/410)로 확인되어 열린 후보 목록에서 제외되었습니다.';
    }
    return null;
  }

  private buildPopularCacheKey(options: PopularReposQuery): string {
    return JSON.stringify({
      kind: 'popular',
      language: options.language?.trim().toLowerCase() ?? '',
      topic: options.topic?.trim().toLowerCase() ?? '',
      query: options.query?.trim().toLowerCase() ?? '',
    });
  }

  private buildIssuesCacheKey(options: ContributionIssuesQuery): string {
    return JSON.stringify({
      kind: 'issues',
      language: options.language?.trim().toLowerCase() ?? '',
      topic: options.topic?.trim().toLowerCase() ?? '',
      query: options.query?.trim().toLowerCase() ?? '',
    });
  }

  private deduplicateOperation<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inFlightOperations.get(key) as Promise<T> | undefined;
    if (existing) return existing;
    const promise = fn().finally(() => {
      this.inFlightOperations.delete(key);
    });
    this.inFlightOperations.set(key, promise);
    return promise;
  }

  private asExternalOrRateLimitError(err: unknown): ServiceError {
    if (err instanceof ServiceError && (err.code === 'RATE_LIMITED' || err.code === 'EXTERNAL_UNAVAILABLE')) {
      return err;
    }
    if (err instanceof ServiceError) return err;
    const message = err instanceof Error ? err.message : 'GitHub 공개 자료 조회에 실패했어요.';
    return new ServiceError('EXTERNAL_UNAVAILABLE', message);
  }

  private upsertLiveRepos(repos: readonly GitHubRepoItem[], checkedAt: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const upsert = this.db.db.prepare(`
        INSERT INTO opensource_repos (
          full_name, source_url, language, topics_json, license_spdx,
          stars_count, repo_created_at, size_tier, is_newborn,
          checked_at, etag, data_origin, stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'live_github', 0)
        ON CONFLICT(full_name) DO UPDATE SET
          source_url = excluded.source_url,
          language = COALESCE(excluded.language, opensource_repos.language),
          topics_json = CASE WHEN excluded.topics_json != '[]' THEN excluded.topics_json ELSE opensource_repos.topics_json END,
          license_spdx = COALESCE(excluded.license_spdx, opensource_repos.license_spdx),
          stars_count = excluded.stars_count,
          repo_created_at = COALESCE(excluded.repo_created_at, opensource_repos.repo_created_at),
          size_tier = excluded.size_tier,
          is_newborn = COALESCE(excluded.is_newborn, opensource_repos.is_newborn),
          checked_at = excluded.checked_at,
          data_origin = 'live_github',
          stale = 0
      `);

      const insertObs = this.db.db.prepare(`
        INSERT INTO repo_star_observations (full_name, observed_at, stars_count)
        VALUES (?, ?, ?)
        ON CONFLICT(full_name, observed_at) DO UPDATE SET
          stars_count = excluded.stars_count
      `);

      for (const repo of repos) {
        const sizeTier = classifyRepoSizeTier(repo.starsCount);
        const isNewborn = classifyNewborn(repo.repoCreatedAt, now);
        upsert.run(
          repo.fullName,
          repo.sourceUrl,
          repo.language,
          JSON.stringify(repo.topics),
          repo.licenseSpdx,
          repo.starsCount,
          repo.repoCreatedAt,
          sizeTier,
          isNewborn === null ? null : isNewborn ? 1 : 0,
          checkedAt,
        );
        if (repo.starsCount !== null) {
          insertObs.run(repo.fullName, checkedAt, repo.starsCount);
        }
      }
    });
  }

  private upsertLiveIssues(issues: readonly GitHubIssueItem[], checkedAt: string): void {
    const now = this.clock.now();
    this.db.transaction(() => {
      const insertMissingRepo = this.db.db.prepare(`
        INSERT INTO opensource_repos (
          full_name, source_url, language, topics_json, license_spdx,
          stars_count, repo_created_at, size_tier, is_newborn,
          checked_at, etag, data_origin, stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'live_github', 0)
        ON CONFLICT(full_name) DO UPDATE SET
          language = COALESCE(excluded.language, opensource_repos.language),
          topics_json = CASE WHEN excluded.topics_json != '[]' THEN excluded.topics_json ELSE opensource_repos.topics_json END,
          license_spdx = COALESCE(excluded.license_spdx, opensource_repos.license_spdx),
          stars_count = COALESCE(excluded.stars_count, opensource_repos.stars_count),
          repo_created_at = COALESCE(excluded.repo_created_at, opensource_repos.repo_created_at),
          size_tier = CASE WHEN excluded.stars_count IS NOT NULL THEN excluded.size_tier ELSE opensource_repos.size_tier END,
          is_newborn = COALESCE(excluded.is_newborn, opensource_repos.is_newborn),
          checked_at = CASE WHEN excluded.stars_count IS NOT NULL THEN excluded.checked_at ELSE opensource_repos.checked_at END,
          data_origin = CASE WHEN excluded.stars_count IS NOT NULL THEN 'live_github' ELSE opensource_repos.data_origin END
      `);

      const upsertIssue = this.db.db.prepare(`
        INSERT INTO external_issues (
          id, repo_full_name, issue_number, title, body_excerpt, labels_json,
          source_url, source_state, assignees_json, linked_prs_json,
          recent_activity_at, checked_at, data_origin
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live_github')
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          body_excerpt = excluded.body_excerpt,
          labels_json = excluded.labels_json,
          source_url = excluded.source_url,
          source_state = excluded.source_state,
          assignees_json = excluded.assignees_json,
          linked_prs_json = excluded.linked_prs_json,
          recent_activity_at = excluded.recent_activity_at,
          checked_at = excluded.checked_at,
          data_origin = 'live_github'
      `);

      const insertObs = this.db.db.prepare(`
        INSERT INTO repo_star_observations (full_name, observed_at, stars_count)
        VALUES (?, ?, ?)
        ON CONFLICT(full_name, observed_at) DO UPDATE SET
          stars_count = excluded.stars_count
      `);

      for (const issue of issues) {
        const embedded = issue.embeddedRepo;
        const stars = embedded?.starsCount ?? null;
        const createdAt = embedded?.repoCreatedAt ?? null;
        const sizeTier = classifyRepoSizeTier(stars);
        const isNewborn = classifyNewborn(createdAt, now);

        insertMissingRepo.run(
          issue.repoFullName,
          embedded?.sourceUrl ?? `https://github.com/${issue.repoFullName}`,
          embedded?.language ?? null,
          JSON.stringify(embedded?.topics ?? []),
          embedded?.licenseSpdx ?? null,
          stars,
          createdAt,
          sizeTier,
          isNewborn === null ? null : isNewborn ? 1 : 0,
          checkedAt,
        );

        if (stars !== null) {
          insertObs.run(issue.repoFullName, checkedAt, stars);
        }

        upsertIssue.run(
          issue.id,
          issue.repoFullName,
          issue.issueNumber,
          issue.title,
          issue.bodyExcerpt,
          JSON.stringify(issue.labels),
          issue.sourceUrl,
          issue.sourceState,
          JSON.stringify(issue.assignees),
          JSON.stringify(issue.linkedPrs),
          issue.recentActivityAt,
          checkedAt,
        );
      }
    });
  }

  private touchReposCheckedAt(fullNames: readonly string[], checkedAt: string): void {
    if (fullNames.length === 0) return;
    const stmt = this.db.db.prepare(`
      UPDATE opensource_repos SET checked_at = ?, stale = 0 WHERE full_name = ?
    `);
    this.db.transaction(() => {
      for (const name of fullNames) {
        stmt.run(checkedAt, name);
      }
    });
  }

  private touchIssuesCheckedAt(issueIds: readonly string[], checkedAt: string): void {
    if (issueIds.length === 0) return;
    const stmt = this.db.db.prepare(`
      UPDATE external_issues SET checked_at = ? WHERE id = ?
    `);
    this.db.transaction(() => {
      for (const id of issueIds) {
        stmt.run(checkedAt, id);
      }
    });
  }

  private buildRepoView(row: RepoRow, markStale = false): OpenSourceRepoView {
    const now = this.clock.now();
    const observations = this.db.db
      .prepare(`
        SELECT observed_at, stars_count
        FROM repo_star_observations
        WHERE full_name = ?
        ORDER BY observed_at ASC
      `)
      .all(row.full_name) as Array<{ observed_at: string; stars_count: number }>;

    const trend = computeSevenDayTrend(
      observations.map(o => ({ observedAt: o.observed_at, starsCount: o.stars_count })),
      now,
      this.minTrendSpanMs,
    );

    const sizeTier = classifyRepoSizeTier(row.stars_count);
    const isNewborn = classifyNewborn(row.repo_created_at, now);
    const topics = parseJsonStringArray(row.topics_json);

    return {
      fullName: row.full_name,
      sourceUrl: row.source_url,
      language: row.language,
      topics,
      licenseSpdx: row.license_spdx,
      licenseConfirmed: Boolean(row.license_spdx && row.license_spdx !== 'NOASSERTION'),
      starsCount: row.stars_count,
      repoCreatedAt: row.repo_created_at,
      sizeTier,
      sizeTierLabel: formatSizeTierLabel(sizeTier),
      isNewborn,
      newbornLabel: formatNewbornLabel(isNewborn),
      trend7d: trend.netStarGain,
      trend7dLabel:
        trend.netStarGain === null
          ? '미분류'
          : `7일 ${trend.netStarGain >= 0 ? '+' : ''}${trend.netStarGain}`,
      trendObservationCount: trend.observationCount,
      checkedAt: row.checked_at,
      etag: row.etag,
      dataOrigin: row.data_origin,
      stale: markStale || row.stale === 1,
    };
  }

  private getStoredIssueView(issueId: string): ExternalIssueView | null {
    const issueRow = this.db.db
      .prepare(`SELECT * FROM external_issues WHERE id = ?`)
      .get(issueId) as IssueRow | undefined;
    if (!issueRow) return null;

    const repoRow = this.db.db
      .prepare(`SELECT * FROM opensource_repos WHERE full_name = ?`)
      .get(issueRow.repo_full_name) as RepoRow | undefined;
    if (!repoRow) return null;

    return {
      id: issueRow.id,
      repoFullName: issueRow.repo_full_name,
      issueNumber: issueRow.issue_number,
      title: issueRow.title,
      bodyExcerpt: issueRow.body_excerpt,
      labels: parseJsonStringArray(issueRow.labels_json),
      sourceUrl: issueRow.source_url,
      sourceState: issueRow.source_state,
      assignees: parseJsonStringArray(issueRow.assignees_json),
      linkedPrs: parseJsonStringArray(issueRow.linked_prs_json),
      recentActivityAt: issueRow.recent_activity_at,
      checkedAt: issueRow.checked_at,
      dataOrigin: issueRow.data_origin,
      untrustedContent: true,
      repo: this.buildRepoView(repoRow),
    };
  }

  private queryStoredRepos(
    options: PopularReposQuery,
    filter: { dataOrigin?: DataOrigin; fullNames?: string[]; limit: number; markStale?: boolean },
  ): OpenSourceRepoView[] {
    let rows = this.db.db
      .prepare(`SELECT * FROM opensource_repos`)
      .all() as unknown as RepoRow[];

    if (filter.dataOrigin) {
      rows = rows.filter(r => r.data_origin === filter.dataOrigin);
    }
    if (filter.fullNames !== undefined) {
      if (filter.fullNames.length === 0) return [];
      const allowed = new Set(filter.fullNames);
      rows = rows.filter(r => allowed.has(r.full_name));
    }

    const lang = options.language?.trim().toLowerCase();
    const topic = options.topic?.trim().toLowerCase();
    const q = options.query?.trim().toLowerCase();

    const views = rows
      .map(row => this.buildRepoView(row, filter.markStale))
      .filter(repo => {
        if (lang && (repo.language ?? '').toLowerCase() !== lang) return false;
        if (topic && !repo.topics.some(t => t.toLowerCase().includes(topic))) return false;
        if (q) {
          const hay = `${repo.fullName} ${repo.language ?? ''} ${repo.topics.join(' ')}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => {
        const aStars = a.starsCount ?? -1;
        const bStars = b.starsCount ?? -1;
        if (bStars !== aStars) return bStars - aStars;
        return a.fullName.localeCompare(b.fullName);
      });

    return views.slice(0, filter.limit);
  }

  private queryStoredOpenIssues(
    options: ContributionIssuesQuery,
    filter: { dataOrigin?: DataOrigin; issueIds?: string[]; limit: number },
  ): ExternalIssueView[] {
    let issueRows = this.db.db
      .prepare(`SELECT * FROM external_issues WHERE source_state = 'open'`)
      .all() as unknown as IssueRow[];

    if (filter.dataOrigin) {
      issueRows = issueRows.filter(i => i.data_origin === filter.dataOrigin);
    }
    if (filter.issueIds !== undefined) {
      if (filter.issueIds.length === 0) return [];
      const allowed = new Set(filter.issueIds);
      issueRows = issueRows.filter(i => allowed.has(i.id));
    }

    const repoRows = this.db.db
      .prepare(`SELECT * FROM opensource_repos`)
      .all() as unknown as RepoRow[];
    const repoMap = new Map<string, OpenSourceRepoView>();
    for (const r of repoRows) {
      repoMap.set(r.full_name, this.buildRepoView(r));
    }

    const lang = options.language?.trim().toLowerCase();
    const topic = options.topic?.trim().toLowerCase();
    const q = options.query?.trim().toLowerCase();

    const views: ExternalIssueView[] = [];
    for (const row of issueRows) {
      if (/\/pull\/\d+(?:$|[?#])/.test(row.source_url)) continue;
      const repo = repoMap.get(row.repo_full_name);
      if (!repo) continue;

      const labels = parseJsonStringArray(row.labels_json);
      if (lang && (repo.language ?? '').toLowerCase() !== lang) continue;
      if (
        topic &&
        !repo.topics.some(t => t.toLowerCase().includes(topic)) &&
        !labels.some(l => l.toLowerCase().includes(topic))
      ) {
        continue;
      }
      if (q) {
        const hay = `${row.title} ${row.body_excerpt} ${row.repo_full_name} ${labels.join(' ')} ${repo.topics.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) continue;
      }
      if (options.sizeTier && repo.sizeTier !== options.sizeTier) continue;
      if (options.newbornOnly && repo.isNewborn !== true) continue;

      views.push({
        id: row.id,
        repoFullName: row.repo_full_name,
        issueNumber: row.issue_number,
        title: row.title,
        bodyExcerpt: row.body_excerpt,
        labels,
        sourceUrl: row.source_url,
        sourceState: row.source_state,
        assignees: parseJsonStringArray(row.assignees_json),
        linkedPrs: parseJsonStringArray(row.linked_prs_json),
        recentActivityAt: row.recent_activity_at,
        checkedAt: row.checked_at,
        dataOrigin: row.data_origin,
        untrustedContent: true,
        repo,
      });
    }

    views.sort((a, b) => {
      const scoreDiff = scoreIssuePriority(b) - scoreIssuePriority(a);
      if (scoreDiff !== 0) return scoreDiff;
      const aActivity = a.recentActivityAt ?? '';
      const bActivity = b.recentActivityAt ?? '';
      if (bActivity !== aActivity) return bActivity.localeCompare(aActivity);
      return a.id.localeCompare(b.id);
    });

    return views.slice(0, filter.limit);
  }
}
