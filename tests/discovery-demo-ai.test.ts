import assert from 'node:assert/strict';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createElement } from 'react';
import { render } from 'ink';
import { FakeClock } from '../src/core/clock.js';
import {
  classifyNewborn,
  classifyRepoSizeTier,
  computeSevenDayTrend,
  DETAIL_CACHE_TTL_MS,
  DiscoveryService,
  LIST_CACHE_TTL_MS,
} from '../src/core/discovery-service.js';
import { ServiceError } from '../src/core/errors.js';
import { DemoIssueExplainer } from '../src/discovery/demo-explainer.js';
import { GitHubClient } from '../src/discovery/github-client.js';
import { WorldDatabase } from '../src/store/sqlite/database.js';
import { OssDiscoveryScreen } from '../src/tui/screens/OssDiscoveryScreen.js';

interface RecordedRequest {
  method: string;
  path: string;
  query: string;
  qParam: string;
  headers: http.IncomingHttpHeaders;
}

interface MockServerHandlerResult {
  status: number;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  delayMs?: number;
}

async function startMockGitHubServer(
  handler: (req: RecordedRequest, hitIndex: number) => Promise<MockServerHandlerResult> | MockServerHandlerResult,
): Promise<{
  baseUrl: string;
  requests: RecordedRequest[];
  getMaxConcurrent: () => number;
  close: () => Promise<void>;
}> {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let maxConcurrent = 0;

  const server = http.createServer(async (req, res) => {
    inFlight += 1;
    maxConcurrent = Math.max(maxConcurrent, inFlight);
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const recorded: RecordedRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams.toString(),
        qParam: url.searchParams.get('q') ?? '',
        headers: { ...req.headers },
      };
      requests.push(recorded);

      const outcome = await handler(recorded, requests.length);
      if (outcome.delayMs && outcome.delayMs > 0) {
        await delay(outcome.delayMs);
      }

      const responseHeaders: Record<string, string> = {
        'Content-Type': 'application/json; charset=utf-8',
      };
      for (const [k, v] of Object.entries(outcome.headers ?? {})) {
        if (v !== undefined) responseHeaders[k] = v;
      }
      res.writeHead(outcome.status, responseHeaders);
      if (outcome.status === 304 || outcome.body === undefined) {
        res.end();
      } else {
        res.end(JSON.stringify(outcome.body));
      }
    } finally {
      inFlight -= 1;
    }
  });

  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');

  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    requests,
    getMaxConcurrent: () => maxConcurrent,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

test('D-01 classification helpers: size tiers (0 vs null), 365-day newborn, and 7-day star trend', () => {
  const now = new Date('2026-11-28T00:00:00.000Z');

  // Observed 0 is 'small', whereas null/undefined is 'unknown' (미분류)
  assert.equal(classifyRepoSizeTier(0), 'small');
  assert.equal(classifyRepoSizeTier(999), 'small');
  assert.equal(classifyRepoSizeTier(1000), 'medium');
  assert.equal(classifyRepoSizeTier(9999), 'medium');
  assert.equal(classifyRepoSizeTier(10000), 'large');
  assert.equal(classifyRepoSizeTier(null), 'unknown');
  assert.equal(classifyRepoSizeTier(undefined), 'unknown');

  // Q-03: strictly < 365 days is newborn, >= 365 days is established, missing is null (미분류)
  assert.equal(classifyNewborn('2025-11-28T00:00:01.000Z', now), true); // 364d 23h 59m 59s
  assert.equal(classifyNewborn('2025-11-28T00:00:00.000Z', now), false); // exactly 365d
  assert.equal(classifyNewborn('2024-01-01T00:00:00.000Z', now), false);
  assert.equal(classifyNewborn(null, now), null);
  assert.equal(classifyNewborn(undefined, now), null);

  // Q-04: 7-day trend requires 2+ observations inside [now - 7d, now] spanning >= 1 day
  const classified = computeSevenDayTrend(
    [
      { observedAt: '2026-11-10T00:00:00.000Z', starsCount: 50 }, // outside 7d window -> ignored
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 100 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 165 },
    ],
    now,
  );
  assert.equal(classified.status, 'classified');
  assert.equal(classified.netStarGain, 65);
  assert.equal(classified.observationCount, 2);

  // 1 observation inside window + 1 outside (10d ago) -> insufficient (미분류)
  const outsideOnly = computeSevenDayTrend(
    [
      { observedAt: '2026-11-18T00:00:00.000Z', starsCount: 90 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 165 },
    ],
    now,
  );
  assert.equal(outsideOnly.status, '미분류');
  assert.equal(outsideOnly.netStarGain, null);

  // 2 observations only 1 hour apart -> does not span multi-day window (미분류)
  const tooShortSpan = computeSevenDayTrend(
    [
      { observedAt: '2026-11-27T23:00:00.000Z', starsCount: 100 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 102 },
    ],
    now,
  );
  assert.equal(tooShortSpan.status, '미분류');
  assert.equal(tooShortSpan.netStarGain, null);
});

test('GitHubClient: never sends Authorization even when GITHUB_TOKEN/GH_TOKEN set, deduplicates singleflight, serializes queue, and handles ETag 304', async () => {
  const prevGhToken = process.env.GH_TOKEN;
  const prevGithubToken = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = 'ghp_secret_must_never_be_used';
  process.env.GH_TOKEN = 'gho_secret_must_never_be_used';

  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  const mock = await startMockGitHubServer((req, hitIndex) => {
    assert.equal(req.headers.authorization, undefined, 'Authorization header must NEVER be sent');
    if (req.path === '/search/repositories') {
      if (req.headers['if-none-match'] === '"etag-repos-1"') {
        return {
          status: 304,
          headers: {
            ETag: '"etag-repos-1"',
            'X-RateLimit-Remaining': '58',
          },
        };
      }
      return {
        status: 200,
        delayMs: 25,
        headers: {
          ETag: '"etag-repos-1"',
          'X-RateLimit-Limit': '60',
          'X-RateLimit-Remaining': '59',
          'X-RateLimit-Reset': String(Math.floor(Date.parse('2026-11-28T02:00:00.000Z') / 1000)),
        },
        body: {
          total_count: 1,
          incomplete_results: false,
          items: [
            {
              full_name: 'demo-org/small-cli',
              html_url: 'https://github.com/demo-org/small-cli',
              language: 'TypeScript',
              topics: ['cli'],
              license: { spdx_id: 'MIT' },
              stargazers_count: 42,
              created_at: '2026-07-01T00:00:00.000Z',
              pushed_at: '2026-11-27T00:00:00.000Z',
            },
          ],
        },
      };
    }
    return {
      status: 200,
      delayMs: 20,
      headers: { 'X-RateLimit-Remaining': String(60 - hitIndex) },
      body: { total_count: 0, incomplete_results: false, items: [] },
    };
  });

  try {
    const client = new GitHubClient({ baseUrl: mock.baseUrl, clock });

    // Singleflight: 5 concurrent identical searches must produce exactly 1 HTTP request
    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => client.searchRepositories({ language: 'TypeScript' })),
    );
    assert.equal(mock.requests.length, 1);
    for (const res of concurrent) {
      assert.equal(res.notModified, false);
      if (!res.notModified) {
        assert.equal(res.items[0]?.fullName, 'demo-org/small-cli');
      }
    }

    // ETag conditional GET -> 304 Not Modified
    clock.advanceMinutes(1);
    const revalidated = await client.searchRepositories({ language: 'TypeScript' });
    assert.equal(mock.requests.length, 2);
    assert.equal(mock.requests[1]?.headers['if-none-match'], '"etag-repos-1"');
    assert.equal(revalidated.notModified, true);

    // Serial queue: distinct queries fired concurrently must run one at a time (maxConcurrent === 1)
    await Promise.all([
      client.searchIssues({ query: 'alpha' }),
      client.searchIssues({ query: 'beta' }),
      client.searchIssues({ query: 'gamma' }),
    ]);
    assert.equal(mock.getMaxConcurrent(), 1);
    assert.equal(mock.requests.length, 5);
  } finally {
    if (prevGithubToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithubToken;
    if (prevGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGhToken;
    await mock.close();
  }
});

test('GitHubClient: 403/429 triggers immediate cooldown and blocks request storm (even for queued calls)', async () => {
  const clock = new FakeClock('2026-11-28T01:00:00.000Z');
  let returnRateLimit = true;

  const mock = await startMockGitHubServer(() => {
    if (returnRateLimit) {
      return {
        status: 429,
        delayMs: 20,
        headers: {
          'Retry-After': '45',
          'X-RateLimit-Remaining': '0',
        },
        body: { message: 'API rate limit exceeded' },
      };
    }
    return {
      status: 200,
      headers: { 'X-RateLimit-Remaining': '59' },
      body: { total_count: 0, incomplete_results: false, items: [] },
    };
  });

  try {
    const client = new GitHubClient({ baseUrl: mock.baseUrl, clock });

    // Fire 4 distinct queries concurrently; #1 hits 429 and puts client into cooldown,
    // so queued #2..#4 MUST fail fast without touching the mock server!
    const settled = await Promise.allSettled([
      client.searchIssues({ query: 'q1' }),
      client.searchIssues({ query: 'q2' }),
      client.searchIssues({ query: 'q3' }),
      client.searchIssues({ query: 'q4' }),
    ]);

    assert.equal(mock.requests.length, 1, 'Cooldown must prevent queued requests from hitting GitHub');
    for (const entry of settled) {
      assert.equal(entry.status, 'rejected');
      if (entry.status === 'rejected') {
        assert.ok(entry.reason instanceof ServiceError);
        assert.equal(entry.reason.code, 'RATE_LIMITED');
      }
    }
    assert.equal(client.isInCooldown(), true);

    // Additional call during cooldown must also be blocked locally
    await assert.rejects(
      () => client.searchRepositories({ query: 'q5' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'RATE_LIMITED',
    );
    assert.equal(mock.requests.length, 1);

    // After advancing clock past Retry-After (45s), requests resume normally
    returnRateLimit = false;
    clock.advanceSeconds(46);
    assert.equal(client.isInCooldown(), false);
    const recovered = await client.searchRepositories({ query: 'q5' });
    assert.equal(recovered.notModified, false);
    assert.equal(mock.requests.length, 2);
  } finally {
    await mock.close();
  }
});

test('DiscoveryService: separates popular repos vs contribution issues, excludes PR/closed/404/410, enforces TTLs & stale fallback vs explicit errors', async () => {
  const clock = new FakeClock('2026-11-28T00:00:00.000Z');
  let mode: 'normal' | 'closed_and_404' | 'outage_503' | 'rate_limit_403' = 'normal';

  const mock = await startMockGitHubServer(req => {
    if (mode === 'outage_503') {
      return { status: 503, body: { message: 'Service Unavailable' } };
    }
    if (mode === 'rate_limit_403') {
      return {
        status: 403,
        headers: { 'X-RateLimit-Remaining': '0', 'Retry-After': '120' },
        body: { message: 'secondary rate limit' },
      };
    }

    if (req.path === '/search/repositories') {
      return {
        status: 200,
        body: {
          total_count: 2,
          incomplete_results: false,
          items: [
            {
              full_name: 'mega/giant-framework',
              html_url: 'https://github.com/mega/giant-framework',
              language: 'TypeScript',
              topics: ['framework'],
              license: { spdx_id: 'MIT' },
              stargazers_count: 35000,
              created_at: '2019-01-01T00:00:00.000Z',
              pushed_at: '2026-11-27T23:00:00.000Z',
            },
            {
              full_name: 'tiny/newborn-helper',
              html_url: 'https://github.com/tiny/newborn-helper',
              language: 'TypeScript',
              topics: ['cli'],
              license: { spdx_id: 'Apache-2.0' },
              stargazers_count: 85,
              created_at: '2026-06-01T00:00:00.000Z',
              pushed_at: '2026-11-27T12:00:00.000Z',
            },
          ],
        },
      };
    }

    if (req.path === '/search/issues') {
      assert.ok(req.qParam.includes('is:issue') && req.qParam.includes('is:open'));
      return {
        status: 200,
        body: {
          total_count: 3,
          incomplete_results: false,
          items: [
            {
              number: 101,
              title: 'Large repo issue',
              body: 'Issue on large repo',
              state: 'open',
              html_url: 'https://github.com/mega/giant-framework/issues/101',
              repository_url: 'https://api.github.com/repos/mega/giant-framework',
              labels: [{ name: 'bug' }],
              assignees: [],
              updated_at: '2026-11-27T22:00:00.000Z',
            },
            {
              number: 7,
              title: 'Small newborn issue',
              body: 'Issue on small newborn repo',
              state: 'open',
              html_url: 'https://github.com/tiny/newborn-helper/issues/7',
              repository_url: 'https://api.github.com/repos/tiny/newborn-helper',
              labels: [{ name: 'good first issue' }],
              assignees: [],
              updated_at: '2026-11-27T20:00:00.000Z',
            },
            {
              number: 99,
              title: 'Accidental PR item',
              body: 'Must be filtered out because pull_request is set',
              state: 'open',
              html_url: 'https://github.com/tiny/newborn-helper/pull/99',
              repository_url: 'https://api.github.com/repos/tiny/newborn-helper',
              pull_request: { url: 'https://api.github.com/repos/tiny/newborn-helper/pulls/99' },
              labels: [],
              assignees: [],
              updated_at: '2026-11-27T21:00:00.000Z',
            },
          ],
        },
      };
    }

    if (req.path === '/repos/mega/giant-framework/issues/101') {
      if (mode === 'closed_and_404') {
        return {
          status: 200,
          body: {
            number: 101,
            title: 'Large repo issue',
            body: 'Now closed',
            state: 'closed',
            html_url: 'https://github.com/mega/giant-framework/issues/101',
            labels: [{ name: 'bug' }],
            assignees: [],
            updated_at: '2026-11-28T00:15:00.000Z',
          },
        };
      }
      return {
        status: 200,
        body: {
          number: 101,
          title: 'Large repo issue',
          body: 'Still open',
          state: 'open',
          html_url: 'https://github.com/mega/giant-framework/issues/101',
          labels: [{ name: 'bug' }],
          assignees: [],
          updated_at: '2026-11-27T22:00:00.000Z',
        },
      };
    }

    if (req.path === '/repos/tiny/newborn-helper/issues/7') {
      if (mode === 'closed_and_404') {
        return { status: 404, body: { message: 'Not Found' } };
      }
      return {
        status: 200,
        body: {
          number: 7,
          title: 'Small newborn issue',
          body: 'Still open',
          state: 'open',
          html_url: 'https://github.com/tiny/newborn-helper/issues/7',
          labels: [{ name: 'good first issue' }],
          assignees: [],
          updated_at: '2026-11-27T20:00:00.000Z',
        },
      };
    }

    return { status: 404, body: { message: 'Not found' } };
  });

  // Part A: No cache & no seed (autoSeed: false) -> explicit EXTERNAL_UNAVAILABLE / RATE_LIMITED (never empty list!)
  const coldDb = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const coldService = new DiscoveryService(coldDb, {
      githubClient: new GitHubClient({ baseUrl: mock.baseUrl, clock }),
      clock,
      autoSeed: false,
    });

    mode = 'outage_503';
    await assert.rejects(
      () => coldService.searchContributionIssues(),
      (err: unknown) => err instanceof ServiceError && err.code === 'EXTERNAL_UNAVAILABLE',
    );

    mode = 'rate_limit_403';
    await assert.rejects(
      () => coldService.listPopularRepos(),
      (err: unknown) => err instanceof ServiceError && err.code === 'RATE_LIMITED',
    );
  } finally {
    coldDb.close();
  }

  // Part B: Full live + cache TTL + revalidation + stale fallback
  clock.set('2026-11-28T00:00:00.000Z');
  mode = 'normal';
  const beforeCount = mock.requests.length;
  const db = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const service = new DiscoveryService(db, {
      githubClient: new GitHubClient({ baseUrl: mock.baseUrl, clock }),
      clock,
      autoSeed: false,
    });

    // 1. Popular repos includes 'large' ordered by cumulative stars desc, and trend7d is 미분류 (no cumulative fallback)
    const popular = await service.listPopularRepos({ language: 'TypeScript' });
    assert.equal(popular.stale, false);
    assert.equal(popular.items.length, 2);
    assert.equal(popular.items[0]?.fullName, 'mega/giant-framework');
    assert.equal(popular.items[0]?.sizeTier, 'large');
    assert.equal(popular.items[0]?.isNewborn, false);
    assert.equal(popular.items[0]?.trend7d, null);
    assert.equal(popular.items[0]?.trend7dLabel, '미분류');
    assert.equal(popular.items[1]?.fullName, 'tiny/newborn-helper');
    assert.equal(popular.items[1]?.sizeTier, 'small');
    assert.equal(popular.items[1]?.isNewborn, true);

    // 2. Contribution issues excludes PRs and prioritizes small+newborn ahead of large
    const issues = await service.searchContributionIssues({ language: 'TypeScript' });
    assert.equal(issues.stale, false);
    assert.equal(issues.items.length, 2);
    assert.equal(issues.items[0]?.id, 'tiny/newborn-helper#7');
    assert.equal(issues.items[1]?.id, 'mega/giant-framework#101');

    // 3. List cache TTL (30m): within 30m does NOT hit mock server
    const hitsAfterInitial = mock.requests.length;
    clock.advanceMinutes(20);
    const cachedIssues = await service.searchContributionIssues({ language: 'TypeScript' });
    assert.equal(mock.requests.length, hitsAfterInitial);
    assert.equal(cachedIssues.items.length, 2);

    // 4. Detail cache TTL (10m): since 20m > 10m, getIssueDetail revalidates!
    mode = 'closed_and_404';
    const closedDetail = await service.getIssueDetail('mega/giant-framework#101');
    assert.equal(closedDetail.issue.sourceState, 'closed');
    assert.ok(closedDetail.statusNotice?.includes('닫힘'));

    const deletedDetail = await service.getIssueDetail('tiny/newborn-helper#7');
    assert.equal(deletedDetail.issue.sourceState, 'deleted_or_inaccessible');
    assert.ok(deletedDetail.statusNotice?.includes('404/410'));

    // Detail cache within 10m avoids extra HTTP hit
    const hitsAfterDetail = mock.requests.length;
    clock.advanceMinutes(5);
    await service.getIssueDetail('mega/giant-framework#101');
    assert.equal(mock.requests.length, hitsAfterDetail);
    assert.ok(DETAIL_CACHE_TTL_MS === 10 * 60 * 1000);
    assert.ok(LIST_CACHE_TTL_MS === 30 * 60 * 1000);

    // Closed & 404 issues are immediately excluded from open contribution issues list (within 30m TTL)
    const postRevalidationIssues = await service.searchContributionIssues({ language: 'TypeScript' });
    assert.equal(postRevalidationIssues.items.length, 0);

    // 5. On outage after TTL expires, stale fallback returns cached data with stale=true & latestUnconfirmed=true
    mode = 'outage_503';
    clock.advanceMinutes(20); // total 45m > 30m list TTL
    const stalePopular = await service.listPopularRepos({ language: 'TypeScript' });
    assert.equal(stalePopular.stale, true);
    assert.equal(stalePopular.latestUnconfirmed, true);
    assert.equal(stalePopular.fallbackErrorCode, 'EXTERNAL_UNAVAILABLE');
    assert.equal(stalePopular.items.length, 2);

    // With no open fallback candidates remaining, outage throws explicit EXTERNAL_UNAVAILABLE (never empty list)
    await assert.rejects(
      () => service.searchContributionIssues({ language: 'TypeScript' }),
      (err: unknown) => err instanceof ServiceError && err.code === 'EXTERNAL_UNAVAILABLE',
    );
    assert.ok(mock.requests.length > beforeCount);
  } finally {
    db.close();
    await mock.close();
  }
});

test('DemoIssueExplainer & seed fallback: returns mode="demo", handles unavailable & sourceCheckedAt mismatch while preserving raw issue', async () => {
  const clock = new FakeClock('2026-11-28T00:00:00.000Z');
  let allowLiveDetail = false;
  const mock = await startMockGitHubServer(req => {
    if (allowLiveDetail && req.path === '/repos/hanbit-oss/term-lint/issues/14') {
      return {
        status: 200,
        body: {
          number: 14,
          title: 'CJK 전각 문자 폭 계산 시 ANSI 색상 코드 오프셋 보정 (갱신됨)',
          body: 'Updated issue body at a newer timestamp',
          state: 'open',
          html_url: 'https://github.com/hanbit-oss/term-lint/issues/14',
          labels: [{ name: 'good first issue' }],
          assignees: [],
          updated_at: '2026-11-28T05:00:00.000Z',
        },
      };
    }
    return { status: 503, body: { message: 'GitHub unreachable' } };
  });

  const db = new WorldDatabase({ dbPath: ':memory:' });
  try {
    const service = new DiscoveryService(db, {
      githubClient: new GitHubClient({ baseUrl: mock.baseUrl, clock }),
      explainer: new DemoIssueExplainer(),
      clock,
      autoSeed: true,
    });

    // 1. When GitHub is unavailable (503), seed_snapshot fallback works with stale + latestUnconfirmed
    const fallbackIssues = await service.searchContributionIssues();
    assert.equal(fallbackIssues.dataOrigin, 'seed_snapshot');
    assert.equal(fallbackIssues.stale, true);
    assert.equal(fallbackIssues.latestUnconfirmed, true);
    // Small/newborn prioritized ahead of large repo
    assert.equal(fallbackIssues.items[0]?.repo.sizeTier, 'small');
    assert.equal(fallbackIssues.items[0]?.repo.isNewborn, true);
    assert.equal(fallbackIssues.items[0]?.repo.trend7d, 65);
    // Large repo is at the back of contribution issues, while at top of popular repos
    const lastIssue = fallbackIssues.items[fallbackIssues.items.length - 1]!;
    assert.equal(lastIssue.repo.sizeTier, 'large');

    const fallbackPopular = await service.listPopularRepos();
    assert.equal(fallbackPopular.dataOrigin, 'seed_snapshot');
    assert.equal(fallbackPopular.items[0]?.fullName, 'core-systems/tiny-sqlite-engine');
    assert.equal(fallbackPopular.items[0]?.starsCount, 41200);

    // 2. Observed 0 stars vs null stars in seed snapshot
    const zeroStarRepo = fallbackPopular.items.find(r => r.fullName === 'narae-lab/kv-notes');
    const nullStarRepo = fallbackPopular.items.find(r => r.fullName === 'unclassified-org/draft-sdk');
    assert.equal(zeroStarRepo?.starsCount, 0);
    assert.equal(zeroStarRepo?.sizeTier, 'small');
    assert.equal(nullStarRepo?.starsCount, null);
    assert.equal(nullStarRepo?.sizeTier, 'unknown');
    assert.equal(nullStarRepo?.isNewborn, null);
    assert.equal(nullStarRepo?.newbornLabel, '미분류');

    // 3. Available demo explanation (forceRefresh=false hits 503 -> stale seed detail matches sourceCheckedAt)
    const available = await service.explainIssue('hanbit-oss/term-lint#14');
    assert.equal(available.explanation.mode, 'demo');
    assert.equal(available.explanation.availabilityState, 'available');
    assert.ok(available.explanation.demoAuthoredAt);
    assert.equal(available.explanation.sourceCheckedAt, '2026-11-28T00:00:00.000Z');
    assert.ok(available.explanation.summary);
    assert.ok(available.explanation.backgroundKnowledge);
    assert.ok(available.explanation.recommendationReason);
    assert.ok(available.explanation.facts.length > 0);
    assert.ok(available.explanation.inferences.length > 0);
    assert.ok(available.explanation.unknowns.length > 0);
    assert.ok(available.explanation.evidenceLinks.includes('https://github.com/hanbit-oss/term-lint/issues/14'));

    // 4. Intentional unavailable test cases preserve raw issue access
    const unavailableExplicit = await service.explainIssue('miri-dev/ansi-canvas#41');
    assert.equal(unavailableExplicit.explanation.mode, 'demo');
    assert.equal(unavailableExplicit.explanation.availabilityState, 'unavailable');
    assert.equal(unavailableExplicit.issue.title, '고해상도 터미널 팔레트 Fallback 매핑 테이블 검토 요청');
    assert.equal(unavailableExplicit.issue.sourceUrl, 'https://github.com/miri-dev/ansi-canvas/issues/41');

    const unavailableMissing = await service.explainIssue('unclassified-org/draft-sdk#5');
    assert.equal(unavailableMissing.explanation.mode, 'demo');
    assert.equal(unavailableMissing.explanation.availabilityState, 'unavailable');
    assert.equal(unavailableMissing.issue.id, 'unclassified-org/draft-sdk#5');

    // 5. sourceCheckedAt mismatch: live refresh at 05:00 updates issue.checkedAt, so prepared demo entry is unavailable
    allowLiveDetail = true;
    clock.set('2026-11-28T05:00:00.000Z');
    const mismatched = await service.explainIssue('hanbit-oss/term-lint#14', { forceRefresh: true });
    assert.equal(mismatched.stale, false);
    assert.equal(mismatched.issue.checkedAt, '2026-11-28T05:00:00.000Z');
    assert.equal(mismatched.explanation.mode, 'demo');
    assert.equal(mismatched.explanation.availabilityState, 'unavailable');
    assert.ok(mismatched.explanation.unavailableReason?.includes('불일치'));
    assert.ok(mismatched.issue.title.includes('갱신됨'));
  } finally {
    db.close();
    await mock.close();
  }
});

test('OssDiscoveryScreen: renders two tabs, opens issue detail with demo AI badge, and switches to popular repos tab', async () => {
  const clock = new FakeClock('2026-11-28T00:00:00.000Z');
  const mock = await startMockGitHubServer(() => ({
    status: 503,
    body: { message: 'offline for seed UI test' },
  }));

  const db = new WorldDatabase({ dbPath: ':memory:' });
  const stdin = Object.assign(new PassThrough(), {
    isTTY: true,
    setRawMode() { return this; },
    ref() { return this; },
    unref() { return this; },
  });
  let frame = '';
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 34 });
  stdout.on('data', chunk => {
    frame += String(chunk).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
  });
  const stderr = new PassThrough();
  stderr.resume();

  try {
    const service = new DiscoveryService(db, {
      githubClient: new GitHubClient({ baseUrl: mock.baseUrl, clock }),
      clock,
      autoSeed: true,
    });

    const instance = render(
      createElement(OssDiscoveryScreen, {
        discoveryService: service,
        width: 120,
        height: 34,
        onBack: () => {},
      }),
      {
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        stderr: stderr as unknown as NodeJS.WriteStream,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    await delay(80);
    await instance.waitUntilRenderFlush();
    assert.ok(frame.includes('기여 이슈 탐색 + 데모 AI 설명'));
    assert.ok(frame.includes('공개 인기 저장소'));
    assert.ok(frame.includes('hanbit-oss/term-lint#14'));

    // Open first issue detail with Enter
    stdin.write('\r');
    await delay(80);
    await instance.waitUntilRenderFlush();
    assert.ok(frame.includes('mode: demo'));
    assert.ok(frame.includes('데모 응답'));

    // Esc back to list, then '2' to switch to Popular Repos tab
    stdin.write('\x1b');
    await delay(50);
    stdin.write('2');
    await delay(80);
    await instance.waitUntilRenderFlush();
    assert.ok(frame.includes('core-systems/tiny-sqlite-engine'));

    instance.unmount();
    await instance.waitUntilExit();
  } finally {
    stdin.destroy();
    stdout.destroy();
    stderr.destroy();
    db.close();
    await mock.close();
  }
});
