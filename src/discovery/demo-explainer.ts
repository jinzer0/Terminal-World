import {
  SEED_DEMO_EXPLANATIONS,
  type SeedDemoExplanationSpec,
} from './seed-snapshot.js';

export type ExplanationMode = 'demo';
export type ExplanationAvailability = 'available' | 'unavailable';

export interface ExplainerRepoContext {
  fullName: string;
  sourceUrl: string;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  starsCount: number | null;
  sizeTier: 'small' | 'medium' | 'large' | 'unknown';
  isNewborn: boolean | null;
  trend7d: number | null;
}

export interface ExplainerIssueContext {
  id: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  sourceUrl: string;
  sourceState: 'open' | 'closed' | 'deleted_or_inaccessible';
  assignees: string[];
  linkedPrs: string[];
  recentActivityAt: string | null;
  checkedAt: string;
}

export interface IssueExplanationRequest {
  issue: ExplainerIssueContext;
  repo: ExplainerRepoContext;
  criteria?: {
    language?: string;
    topic?: string;
    query?: string;
  };
}

export interface IssueExplanationResult {
  issueId: string;
  sourceCheckedAt: string;
  mode: ExplanationMode;
  availabilityState: ExplanationAvailability;
  unavailableReason: string | null;
  demoAuthoredAt: string | null;
  summary: string | null;
  backgroundKnowledge: string | null;
  recommendationReason: string | null;
  facts: string[];
  inferences: string[];
  unknowns: string[];
  evidenceLinks: string[];
  untrustedContent: true;
  disclaimer: string;
}

export interface IssueExplainer {
  explain(request: IssueExplanationRequest): Promise<IssueExplanationResult> | IssueExplanationResult;
}

export const DEMO_EXPLAINER_DISCLAIMER =
  '데모 응답(mode: demo): 실제 AI 모델 생성이 아닌 준비된 데모 설명입니다. 최신 상태와 기여 가능 여부는 GitHub 원문에서 직접 확인하세요.';

export interface DemoIssueExplainerOptions {
  entries?: readonly SeedDemoExplanationSpec[];
}

/**
 * Deterministic Demo AI Issue Explainer (D-03).
 * Never claims real AI generation; returns `mode: 'demo'` and returns
 * `availabilityState: 'unavailable'` when no matching prepared entry exists,
 * when `sourceCheckedAt` mismatches, or for explicit unavailable test cases.
 */
export class DemoIssueExplainer implements IssueExplainer {
  private readonly entriesByIssueId = new Map<string, SeedDemoExplanationSpec>();

  constructor(options: DemoIssueExplainerOptions = {}) {
    const entries = options.entries ?? SEED_DEMO_EXPLANATIONS;
    for (const entry of entries) {
      this.entriesByIssueId.set(entry.issueId, entry);
    }
  }

  explain(request: IssueExplanationRequest): IssueExplanationResult {
    const { issue, repo } = request;
    const baseLinks = Array.from(new Set([issue.sourceUrl, repo.sourceUrl].filter(Boolean)));
    const baseFacts = [
      `이슈 식별자: ${issue.id} (확인 시점 상태: ${issue.sourceState})`,
      `저장소: ${repo.fullName} (스타: ${repo.starsCount ?? '미확인'}, 규모: ${repo.sizeTier === 'unknown' ? '미분류' : repo.sizeTier})`,
      `신생 여부: ${repo.isNewborn === null ? '미분류' : repo.isNewborn ? '신생(365일 미만)' : '기존(365일 이상)'}`,
      `7일 스타 추세: ${repo.trend7d === null ? '미분류' : `${repo.trend7d >= 0 ? '+' : ''}${repo.trend7d}`}`,
    ];

    const prepared = this.entriesByIssueId.get(issue.id);
    if (!prepared) {
      return {
        issueId: issue.id,
        sourceCheckedAt: issue.checkedAt,
        mode: 'demo',
        availabilityState: 'unavailable',
        unavailableReason: '해당 이슈에 대한 준비된 데모 설명 자료가 없습니다.',
        demoAuthoredAt: null,
        summary: null,
        backgroundKnowledge: null,
        recommendationReason: null,
        facts: baseFacts,
        inferences: [],
        unknowns: [
          '데모 설명이 준비되지 않았으므로 원문 이슈 본문과 GitHub 저장소 문서를 직접 확인해야 합니다.',
        ],
        evidenceLinks: baseLinks,
        untrustedContent: true,
        disclaimer: DEMO_EXPLAINER_DISCLAIMER,
      };
    }

    if (prepared.sourceCheckedAt !== issue.checkedAt) {
      return {
        issueId: issue.id,
        sourceCheckedAt: issue.checkedAt,
        mode: 'demo',
        availabilityState: 'unavailable',
        unavailableReason: `원본 확인 시점 불일치(준비: ${prepared.sourceCheckedAt}, 현재: ${issue.checkedAt})로 데모 설명을 사용할 수 없습니다.`,
        demoAuthoredAt: prepared.demoAuthoredAt,
        summary: null,
        backgroundKnowledge: null,
        recommendationReason: null,
        facts: baseFacts,
        inferences: [],
        unknowns: [
          '이슈 자료가 새로 갱신되어 기존 데모 설명 시점과 일치하지 않습니다. GitHub 원문에서 최신 내용을 확인하세요.',
        ],
        evidenceLinks: baseLinks,
        untrustedContent: true,
        disclaimer: DEMO_EXPLAINER_DISCLAIMER,
      };
    }

    if (prepared.availabilityState === 'unavailable') {
      return {
        issueId: issue.id,
        sourceCheckedAt: issue.checkedAt,
        mode: 'demo',
        availabilityState: 'unavailable',
        unavailableReason:
          prepared.unavailableReason ?? '근거 부족 또는 의도된 데모 설명 불가 상태입니다.',
        demoAuthoredAt: prepared.demoAuthoredAt,
        summary: null,
        backgroundKnowledge: null,
        recommendationReason: null,
        facts: prepared.facts.length > 0 ? [...prepared.facts] : baseFacts,
        inferences: [...prepared.inferences],
        unknowns:
          prepared.unknowns.length > 0
            ? [...prepared.unknowns]
            : ['근거 자료가 부족하여 요약 및 추천 이유를 제공하지 않습니다.'],
        evidenceLinks:
          prepared.evidenceLinks.length > 0 ? [...prepared.evidenceLinks] : baseLinks,
        untrustedContent: true,
        disclaimer: DEMO_EXPLAINER_DISCLAIMER,
      };
    }

    return {
      issueId: issue.id,
      sourceCheckedAt: issue.checkedAt,
      mode: 'demo',
      availabilityState: 'available',
      unavailableReason: null,
      demoAuthoredAt: prepared.demoAuthoredAt,
      summary: prepared.summary,
      backgroundKnowledge: prepared.backgroundKnowledge,
      recommendationReason: prepared.recommendationReason,
      facts: [...prepared.facts],
      inferences: [...prepared.inferences],
      unknowns: [...prepared.unknowns],
      evidenceLinks:
        prepared.evidenceLinks.length > 0 ? [...prepared.evidenceLinks] : baseLinks,
      untrustedContent: true,
      disclaimer: DEMO_EXPLAINER_DISCLAIMER,
    };
  }
}
