import { useCallback, useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type {
  ContributionIssuesResult,
  DiscoveryService,
  ExplainIssueResult,
  ExternalIssueView,
  OpenSourceRepoView,
  PopularReposResult,
} from '../../core/discovery-service.js';
import { ServiceError } from '../../core/errors.js';
import type { ServiceTheme } from '../../service/validation.js';
import { getThemePalette } from '../components/Themes.js';

export type OssDiscoveryTab = 'issues' | 'popular';

export interface OssDiscoveryScreenProps {
  discoveryService: DiscoveryService;
  initialTab?: OssDiscoveryTab;
  theme?: ServiceTheme;
  width?: number;
  height?: number;
  onBack: () => void;
}

type FilterField = 'language' | 'topic' | 'query';

function formatError(err: unknown): string {
  if (err instanceof ServiceError) {
    return `[${err.code}] ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return '오픈소스 탐색 요청을 처리하지 못했어요.';
}

function originLabel(origin: 'live_github' | 'seed_snapshot'): string {
  return origin === 'live_github' ? '실시간 GitHub' : '시드 스냅샷';
}

export function OssDiscoveryScreen({
  discoveryService,
  initialTab = 'issues',
  theme = 'dark',
  width,
  height,
  onBack,
}: OssDiscoveryScreenProps) {
  const palette = getThemePalette(theme);
  const [activeTab, setActiveTab] = useState<OssDiscoveryTab>(initialTab);
  const [languageFilter, setLanguageFilter] = useState('');
  const [topicFilter, setTopicFilter] = useState('');
  const [queryFilter, setQueryFilter] = useState('');
  const [editingField, setEditingField] = useState<FilterField | null>(null);
  const [draftInput, setDraftInput] = useState('');

  const [issuesResult, setIssuesResult] = useState<ContributionIssuesResult | null>(null);
  const [popularResult, setPopularResult] = useState<PopularReposResult | null>(null);
  const [issueCursor, setIssueCursor] = useState(0);
  const [repoCursor, setRepoCursor] = useState(0);

  const [selectedDetail, setSelectedDetail] = useState<ExplainIssueResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const loadCurrentTab = useCallback(
    async (tab: OssDiscoveryTab, forceRefresh = false) => {
      setLoading(true);
      setErrorMessage('');
      try {
        if (tab === 'issues') {
          const res = await discoveryService.searchContributionIssues({
            language: languageFilter || undefined,
            topic: topicFilter || undefined,
            query: queryFilter || undefined,
            limit: 15,
            forceRefresh,
          });
          setIssuesResult(res);
          setIssueCursor(prev => Math.max(0, Math.min(prev, Math.max(0, res.items.length - 1))));
        } else {
          const res = await discoveryService.listPopularRepos({
            language: languageFilter || undefined,
            topic: topicFilter || undefined,
            query: queryFilter || undefined,
            limit: 15,
            forceRefresh,
          });
          setPopularResult(res);
          setRepoCursor(prev => Math.max(0, Math.min(prev, Math.max(0, res.items.length - 1))));
        }
      } catch (err) {
        setErrorMessage(formatError(err));
      } finally {
        setLoading(false);
      }
    },
    [discoveryService, languageFilter, topicFilter, queryFilter],
  );

  useEffect(() => {
    void loadCurrentTab(activeTab, false);
  }, [activeTab, loadCurrentTab]);

  const openIssueDetail = useCallback(
    async (issue: ExternalIssueView, forceRefresh = false) => {
      setLoading(true);
      setErrorMessage('');
      try {
        const res = await discoveryService.explainIssue(issue.id, {
          criteria: {
            language: languageFilter || undefined,
            topic: topicFilter || undefined,
            query: queryFilter || undefined,
          },
          forceRefresh,
        });
        setSelectedDetail(res);
      } catch (err) {
        setErrorMessage(formatError(err));
      } finally {
        setLoading(false);
      }
    },
    [discoveryService, languageFilter, topicFilter, queryFilter],
  );

  useInput((input, key) => {
    if (editingField) {
      if (key.escape) {
        setEditingField(null);
        setDraftInput('');
        return;
      }
      if (key.return) {
        const trimmed = draftInput.trim();
        if (editingField === 'language') setLanguageFilter(trimmed);
        else if (editingField === 'topic') setTopicFilter(trimmed);
        else setQueryFilter(trimmed);
        setEditingField(null);
        setDraftInput('');
        return;
      }
      if (key.backspace || key.delete) {
        setDraftInput(prev => prev.slice(0, -1));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setDraftInput(prev => prev + input);
      }
      return;
    }

    if (selectedDetail) {
      if (key.escape) {
        setSelectedDetail(null);
        setErrorMessage('');
        return;
      }
      if (input === 'r') {
        void openIssueDetail(selectedDetail.issue, true);
      }
      return;
    }

    if (key.escape) {
      onBack();
      return;
    }

    if (key.tab || input === '1' || input === '2') {
      if (input === '1') setActiveTab('issues');
      else if (input === '2') setActiveTab('popular');
      else setActiveTab(prev => (prev === 'issues' ? 'popular' : 'issues'));
      return;
    }

    if (input === 'r') {
      void loadCurrentTab(activeTab, true);
      return;
    }
    if (input === 'l') {
      setEditingField('language');
      setDraftInput(languageFilter);
      return;
    }
    if (input === 't') {
      setEditingField('topic');
      setDraftInput(topicFilter);
      return;
    }
    if (input === '/' || input === 'q') {
      setEditingField('query');
      setDraftInput(queryFilter);
      return;
    }
    if (input === 'c') {
      setLanguageFilter('');
      setTopicFilter('');
      setQueryFilter('');
      return;
    }

    if (activeTab === 'issues') {
      const items = issuesResult?.items ?? [];
      if (key.upArrow || input === 'k') {
        setIssueCursor(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setIssueCursor(prev => Math.min(Math.max(0, items.length - 1), prev + 1));
        return;
      }
      if (key.return && items[issueCursor]) {
        void openIssueDetail(items[issueCursor]!, false);
      }
    } else {
      const items = popularResult?.items ?? [];
      if (key.upArrow || input === 'k') {
        setRepoCursor(prev => Math.max(0, prev - 1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setRepoCursor(prev => Math.min(Math.max(0, items.length - 1), prev + 1));
      }
    }
  });

  const activeMeta = activeTab === 'issues' ? issuesResult : popularResult;

  return (
    <Box
      flexDirection="column"
      width={width}
      height={height}
      backgroundColor={palette.background}
      paddingX={1}
    >
      <Box justifyContent="space-between" borderStyle="single" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.accent}>
          오픈소스 탐색 (비인증 공개 GitHub + 데모 AI)
        </Text>
        <Text color={palette.muted}>
          Tab/1/2: 탭 전환 · l:언어 · t:토픽 · /:검색 · c:초기화 · r:갱신 · Esc:복귀
        </Text>
      </Box>

      <Box paddingX={1} gap={2}>
        <Text
          bold={activeTab === 'issues'}
          color={activeTab === 'issues' ? palette.accent : palette.muted}
          backgroundColor={activeTab === 'issues' ? palette.selected : undefined}
        >
          {activeTab === 'issues' ? '● ' : '○ '}① 기여 이슈 탐색 + 데모 AI 설명
        </Text>
        <Text
          bold={activeTab === 'popular'}
          color={activeTab === 'popular' ? palette.accent : palette.muted}
          backgroundColor={activeTab === 'popular' ? palette.selected : undefined}
        >
          {activeTab === 'popular' ? '● ' : '○ '}② 공개 인기 저장소
        </Text>
      </Box>

      <Box paddingX={1}>
        <Text color={palette.muted}>
          필터: 언어=[{languageFilter || '전체'}] · 토픽=[{topicFilter || '전체'}] · 검색어=[{queryFilter || '없음'}]
        </Text>
      </Box>

      {editingField && (
        <Box borderStyle="round" borderColor={palette.accent} paddingX={1}>
          <Text color={palette.accent}>
            {editingField === 'language'
              ? '언어 입력'
              : editingField === 'topic'
                ? '토픽/라벨 입력'
                : '키워드 입력'}
            : {draftInput}█ (Enter 적용 · Esc 취소)
          </Text>
        </Box>
      )}

      {errorMessage ? (
        <Box borderStyle="round" borderColor={palette.error} paddingX={1} marginY={1}>
          <Text color={palette.error}>{errorMessage}</Text>
        </Box>
      ) : null}

      {activeMeta && (activeMeta.stale || activeMeta.latestUnconfirmed) ? (
        <Box borderStyle="single" borderColor={palette.warning} paddingX={1}>
          <Text color={palette.warning}>
            주의: 최신 여부 미확인(stale) · 출처={originLabel(activeMeta.dataOrigin)} · 확인={activeMeta.checkedAt}
            {activeMeta.fallbackErrorCode ? ` · 사유=${activeMeta.fallbackErrorCode}` : ''}
          </Text>
        </Box>
      ) : activeMeta ? (
        <Box paddingX={1}>
          <Text color={palette.muted}>
            출처: {originLabel(activeMeta.dataOrigin)} · 확인 시점: {activeMeta.checkedAt}
          </Text>
        </Box>
      ) : null}

      {loading ? (
        <Box paddingX={1}>
          <Text color={palette.accent}>공개 GitHub 자료를 조회하는 중...</Text>
        </Box>
      ) : null}

      {selectedDetail ? (
        <IssueDetailPane detail={selectedDetail} palette={palette} />
      ) : activeTab === 'issues' ? (
        <IssuesTabPane
          result={issuesResult}
          cursor={issueCursor}
          palette={palette}
        />
      ) : (
        <PopularReposTabPane
          result={popularResult}
          cursor={repoCursor}
          palette={palette}
        />
      )}
    </Box>
  );
}

function IssuesTabPane({
  result,
  cursor,
  palette,
}: {
  result: ContributionIssuesResult | null;
  cursor: number;
  palette: ReturnType<typeof getThemePalette>;
}) {
  const items = result?.items ?? [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1} flexGrow={1}>
      <Text color={palette.muted}>
        {result?.selectionPolicyNote ??
          '중소규모(0~9,999 스타) · 신생(365일 미만) 우선 · 열린 이슈만 표시 · 7일 관찰 창 기준'}
      </Text>
      {items.length === 0 ? (
        <Box marginTop={1}>
          <Text color={palette.muted}>조건에 맞는 열린 기여 이슈가 없습니다.</Text>
        </Box>
      ) : (
        items.slice(0, 10).map((issue, idx) => {
          const selected = idx === cursor;
          return (
            <Box key={issue.id} flexDirection="column" marginTop={idx === 0 ? 1 : 0}>
              <Text
                color={selected ? palette.accent : palette.text}
                backgroundColor={selected ? palette.selected : undefined}
                wrap="truncate-end"
              >
                {selected ? '› ' : '  '}
                [{issue.repo.sizeTierLabel}] [{issue.repo.newbornLabel}] [{issue.repo.trend7dLabel}] {issue.id} — {issue.title}
              </Text>
              <Text color={palette.muted} wrap="truncate-end">
                {'    '}언어: {issue.repo.language ?? '미확인'} · 라이선스: {issue.repo.licenseSpdx ?? '미확인'} · 라벨: {issue.labels.join(', ') || '없음'}
              </Text>
            </Box>
          );
        })
      )}
      <Box marginTop={1}>
        <Text color={palette.muted}>↑/↓ 이동 · Enter 선택(원문 정보 + 데모 AI 설명 보기)</Text>
      </Box>
    </Box>
  );
}

function PopularReposTabPane({
  result,
  cursor,
  palette,
}: {
  result: PopularReposResult | null;
  cursor: number;
  palette: ReturnType<typeof getThemePalette>;
}) {
  const items: OpenSourceRepoView[] = result?.items ?? [];
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.border} paddingX={1} flexGrow={1}>
      <Text color={palette.muted}>
        {result?.scopeNote ??
          '누적 스타 내림차순 공개 저장소 목록(대규모 포함 · 누적 스타는 최근 7일 추세나 기여 적합성 근거가 아님)'}
      </Text>
      {items.length === 0 ? (
        <Box marginTop={1}>
          <Text color={palette.muted}>조건에 맞는 공개 저장소가 없습니다.</Text>
        </Box>
      ) : (
        items.slice(0, 12).map((repo, idx) => {
          const selected = idx === cursor;
          return (
            <Text
              key={repo.fullName}
              color={selected ? palette.accent : palette.text}
              backgroundColor={selected ? palette.selected : undefined}
              wrap="truncate-end"
            >
              {selected ? '› ' : '  '}
              ★ {repo.starsCount ?? '미확인'} · {repo.fullName} · {repo.sizeTierLabel} · {repo.newbornLabel} · 트렌드:{repo.trend7dLabel} · {repo.language ?? '미확인'} · {repo.licenseSpdx ?? '라이선스 미확인'}
            </Text>
          );
        })
      )}
    </Box>
  );
}

function IssueDetailPane({
  detail,
  palette,
}: {
  detail: ExplainIssueResult;
  palette: ReturnType<typeof getThemePalette>;
}) {
  const { issue, explanation } = detail;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.accent} paddingX={1} flexGrow={1}>
      <Text bold color={palette.accent}>
        원문 이슈: {issue.id} — {issue.title}
      </Text>
      <Text color={palette.text}>
        상태: {issue.sourceState} · 원문 URL: {issue.sourceUrl}
      </Text>
      <Text color={palette.muted}>
        규모: {issue.repo.sizeTierLabel} · 신생: {issue.repo.newbornLabel} · 7일 추세: {issue.repo.trend7dLabel} · 확인: {issue.checkedAt}
      </Text>
      <Text color={palette.muted}>
        라벨: {issue.labels.join(', ') || '없음'} · 담당자: {issue.assignees.join(', ') || '없음'} · 연결 PR: {issue.linkedPrs.join(', ') || '없음'}
      </Text>
      {detail.statusNotice ? (
        <Text color={palette.warning}>{detail.statusNotice}</Text>
      ) : null}
      <Box marginTop={1}>
        <Text color={palette.text} wrap="wrap">
          본문 발췌: {issue.bodyExcerpt || '(본문 없음)'}
        </Text>
      </Box>

      <Box flexDirection="column" marginTop={1} borderStyle="single" borderColor={palette.border} paddingX={1}>
        <Text bold color={palette.warning}>
          [데모 응답 · mode: {explanation.mode} · 상태: {explanation.availabilityState}]
        </Text>
        <Text color={palette.muted}>
          {explanation.disclaimer}
        </Text>
        <Text color={palette.muted}>
          자료 확인 시점(sourceCheckedAt): {explanation.sourceCheckedAt} · 데모 작성 시점(demoAuthoredAt): {explanation.demoAuthoredAt ?? '없음'}
        </Text>

        {explanation.availabilityState === 'available' ? (
          <>
            <Text color={palette.text}>요약: {explanation.summary}</Text>
            <Text color={palette.text}>필요 배경지식: {explanation.backgroundKnowledge}</Text>
            <Text color={palette.text}>추천 이유: {explanation.recommendationReason}</Text>
            <Text color={palette.success}>사실(Facts): {explanation.facts.join(' | ') || '없음'}</Text>
            <Text color={palette.accent}>추론(Inferences): {explanation.inferences.join(' | ') || '없음'}</Text>
            <Text color={palette.warning}>미확인(Unknowns): {explanation.unknowns.join(' | ') || '없음'}</Text>
          </>
        ) : (
          <Text color={palette.error}>
            설명 없음(unavailable): {explanation.unavailableReason ?? '데모 설명을 제공할 수 없습니다. 위 원문 URL에서 직접 확인하세요.'}
          </Text>
        )}
        <Text color={palette.muted}>
          근거 링크: {explanation.evidenceLinks.join(', ')}
        </Text>
      </Box>

      <Text color={palette.muted}>Esc: 목록으로 돌아가기 · r: 원문 재검증</Text>
    </Box>
  );
}
