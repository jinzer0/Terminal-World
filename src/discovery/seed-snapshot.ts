export const SEED_SNAPSHOT_CHECKED_AT = '2026-11-28T00:00:00.000Z';
export const SEED_DEMO_AUTHORED_AT = '2026-11-28T00:00:00.000Z';

export interface SeedRepoSpec {
  fullName: string;
  sourceUrl: string;
  language: string | null;
  topics: string[];
  licenseSpdx: string | null;
  starsCount: number | null;
  repoCreatedAt: string | null;
  checkedAt: string;
  observations: Array<{ observedAt: string; starsCount: number }>;
}

export interface SeedIssueSpec {
  id: string;
  repoFullName: string;
  issueNumber: number;
  title: string;
  bodyExcerpt: string;
  labels: string[];
  sourceUrl: string;
  sourceState: 'open';
  assignees: string[];
  linkedPrs: string[];
  recentActivityAt: string | null;
  checkedAt: string;
}

export interface SeedDemoExplanationSpec {
  issueId: string;
  sourceCheckedAt: string;
  availabilityState: 'available' | 'unavailable';
  unavailableReason: string | null;
  demoAuthoredAt: string | null;
  summary: string | null;
  backgroundKnowledge: string | null;
  recommendationReason: string | null;
  facts: string[];
  inferences: string[];
  unknowns: string[];
  evidenceLinks: string[];
}

export const SEED_REPOS: readonly SeedRepoSpec[] = [
  // 1. Small + Newborn (<365d) + 7d positive trend
  {
    fullName: 'hanbit-oss/term-lint',
    sourceUrl: 'https://github.com/hanbit-oss/term-lint',
    language: 'TypeScript',
    topics: ['cli', 'tui', 'accessibility', 'good-first-issue'],
    licenseSpdx: 'MIT',
    starsCount: 185,
    repoCreatedAt: '2026-05-12T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 120 },
      { observedAt: '2026-11-25T00:00:00.000Z', starsCount: 158 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 185 },
    ],
  },
  // 2. Small + Newborn (<365d) + insufficient observations (only 1 in 7d window -> 미분류)
  {
    fullName: 'seoul-tools/sqlite-migrator',
    sourceUrl: 'https://github.com/seoul-tools/sqlite-migrator',
    language: 'TypeScript',
    topics: ['sqlite', 'database', 'nodejs'],
    licenseSpdx: 'Apache-2.0',
    starsCount: 420,
    repoCreatedAt: '2026-02-10T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-10T00:00:00.000Z', starsCount: 380 }, // outside 7d window
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 420 },
    ],
  },
  // 3. Small with observed 0 stars + Newborn (<365d) + no observations
  {
    fullName: 'narae-lab/kv-notes',
    sourceUrl: 'https://github.com/narae-lab/kv-notes',
    language: 'Go',
    topics: ['cli', 'notes'],
    licenseSpdx: 'BSD-3-Clause',
    starsCount: 0,
    repoCreatedAt: '2026-09-01T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [],
  },
  // 4. Medium + Established (>=365d) + 7d positive trend
  {
    fullName: 'open-protocol/mcp-inspector-lite',
    sourceUrl: 'https://github.com/open-protocol/mcp-inspector-lite',
    language: 'Python',
    topics: ['mcp', 'devtools', 'testing'],
    licenseSpdx: 'MIT',
    starsCount: 2840,
    repoCreatedAt: '2024-08-20T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 2710 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 2840 },
    ],
  },
  // 5. Medium + Unknown creation date (미분류) + intentional unavailable explanation target
  {
    fullName: 'miri-dev/ansi-canvas',
    sourceUrl: 'https://github.com/miri-dev/ansi-canvas',
    language: 'Rust',
    topics: ['terminal', 'ansi', 'graphics'],
    licenseSpdx: 'MIT',
    starsCount: 1520,
    repoCreatedAt: null,
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 1495 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 1520 },
    ],
  },
  // 6. Unknown stars (null) + Unknown creation date (미분류)
  {
    fullName: 'unclassified-org/draft-sdk',
    sourceUrl: 'https://github.com/unclassified-org/draft-sdk',
    language: 'TypeScript',
    topics: ['sdk'],
    licenseSpdx: null,
    starsCount: null,
    repoCreatedAt: null,
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [],
  },
  // 7. Large + Established (>=365d) + 7d trend (for Popular Repos list)
  {
    fullName: 'awesome-runtime/fast-ink-ui',
    sourceUrl: 'https://github.com/awesome-runtime/fast-ink-ui',
    language: 'TypeScript',
    topics: ['react', 'tui', 'framework'],
    licenseSpdx: 'MIT',
    starsCount: 24600,
    repoCreatedAt: '2021-04-03T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 24410 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 24600 },
    ],
  },
  // 8. Large + Established (for Popular Repos ranking)
  {
    fullName: 'core-systems/tiny-sqlite-engine',
    sourceUrl: 'https://github.com/core-systems/tiny-sqlite-engine',
    language: 'Rust',
    topics: ['database', 'storage'],
    licenseSpdx: 'Apache-2.0',
    starsCount: 41200,
    repoCreatedAt: '2020-01-15T00:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
    observations: [
      { observedAt: '2026-11-21T00:00:00.000Z', starsCount: 41150 },
      { observedAt: '2026-11-28T00:00:00.000Z', starsCount: 41200 },
    ],
  },
];

export const SEED_ISSUES: readonly SeedIssueSpec[] = [
  {
    id: 'hanbit-oss/term-lint#14',
    repoFullName: 'hanbit-oss/term-lint',
    issueNumber: 14,
    title: 'CJK 전각 문자 폭 계산 시 ANSI 색상 코드 오프셋 보정',
    bodyExcerpt:
      '한글·이모지가 포함된 터미널 줄에 ANSI 컬러 이스케이프 시퀀스가 섞여 있을 때 열 너비 계산이 2칸 어긋나는 재현 케이스를 보고합니다. string-width 적용 전후 테스트 추가가 필요합니다.',
    labels: ['good first issue', 'bug', 'unicode'],
    sourceUrl: 'https://github.com/hanbit-oss/term-lint/issues/14',
    sourceState: 'open',
    assignees: [],
    linkedPrs: [],
    recentActivityAt: '2026-11-27T14:20:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  {
    id: 'seoul-tools/sqlite-migrator#27',
    repoFullName: 'seoul-tools/sqlite-migrator',
    issueNumber: 27,
    title: 'WAL 모드에서 백업 후 schema_migrations 버전 검증 명령 추가',
    bodyExcerpt:
      'CLI 서브커맨드에 verify 옵션을 추가해 백업 파일의 schema_migrations 테이블 무결성을 읽기 전용으로 점검할 수 있도록 개선하고자 합니다.',
    labels: ['help wanted', 'enhancement', 'sqlite'],
    sourceUrl: 'https://github.com/seoul-tools/sqlite-migrator/issues/27',
    sourceState: 'open',
    assignees: ['maintainer-jun'],
    linkedPrs: [],
    recentActivityAt: '2026-11-26T09:10:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  {
    id: 'narae-lab/kv-notes#3',
    repoFullName: 'narae-lab/kv-notes',
    issueNumber: 3,
    title: 'README에 macOS/Linux 설치 및 기본 단축키 예제 보강',
    bodyExcerpt:
      '초기 사용자들이 CLI 단축키와 저장 경로 설정을 빠르게 파악할 수 있도록 예제 문서를 추가하려고 합니다.',
    labels: ['documentation', 'good first issue'],
    sourceUrl: 'https://github.com/narae-lab/kv-notes/issues/3',
    sourceState: 'open',
    assignees: [],
    linkedPrs: [],
    recentActivityAt: '2026-11-25T18:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  {
    id: 'open-protocol/mcp-inspector-lite#89',
    repoFullName: 'open-protocol/mcp-inspector-lite',
    issueNumber: 89,
    title: 'stdio JSON-RPC 진단 로그를 stderr로 분리하는 옵션 문서화 및 테스트',
    bodyExcerpt:
      'MCP stdio 전송 시 stdout 오염을 막기 위해 모든 진단 메시지를 stderr로 우회하는 회귀 테스트 케이스를 보강합니다.',
    labels: ['help wanted', 'testing', 'mcp'],
    sourceUrl: 'https://github.com/open-protocol/mcp-inspector-lite/issues/89',
    sourceState: 'open',
    assignees: [],
    linkedPrs: ['https://github.com/open-protocol/mcp-inspector-lite/pull/91'],
    recentActivityAt: '2026-11-27T21:05:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  // Intentional unavailable explanation case 1: explicitly marked unavailable
  {
    id: 'miri-dev/ansi-canvas#41',
    repoFullName: 'miri-dev/ansi-canvas',
    issueNumber: 41,
    title: '고해상도 터미널 팔레트 Fallback 매핑 테이블 검토 요청',
    bodyExcerpt:
      '24-bit TrueColor 미지원 터미널에서 256색 근사치 변환 시 대비가 떨어지는 색상 쌍을 제보받습니다.',
    labels: ['help wanted', 'colors'],
    sourceUrl: 'https://github.com/miri-dev/ansi-canvas/issues/41',
    sourceState: 'open',
    assignees: [],
    linkedPrs: [],
    recentActivityAt: '2026-11-24T11:30:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  // Intentional unavailable explanation case 2: no demo explanation entry prepared
  {
    id: 'unclassified-org/draft-sdk#5',
    repoFullName: 'unclassified-org/draft-sdk',
    issueNumber: 5,
    title: '초기 설정 스키마 유효성 오류 메시지 정리',
    bodyExcerpt: '누락된 필드명 표시를 일관되게 다듬는 이슈입니다.',
    labels: ['enhancement'],
    sourceUrl: 'https://github.com/unclassified-org/draft-sdk/issues/5',
    sourceState: 'open',
    assignees: [],
    linkedPrs: [],
    recentActivityAt: null,
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
  // Large repo issue (should rank behind small/medium & newborn in contribution search)
  {
    id: 'awesome-runtime/fast-ink-ui#1102',
    repoFullName: 'awesome-runtime/fast-ink-ui',
    issueNumber: 1102,
    title: '대용량 스크롤 리스트 가상화 렌더러 경계 테스트 추가',
    bodyExcerpt: '10,000행 이상 목록 렌더링 시 뷰포트 오프셋 계산 경계 조건을 검증합니다.',
    labels: ['testing', 'performance'],
    sourceUrl: 'https://github.com/awesome-runtime/fast-ink-ui/issues/1102',
    sourceState: 'open',
    assignees: [],
    linkedPrs: [],
    recentActivityAt: '2026-11-27T23:00:00.000Z',
    checkedAt: SEED_SNAPSHOT_CHECKED_AT,
  },
];

export const SEED_DEMO_EXPLANATIONS: readonly SeedDemoExplanationSpec[] = [
  {
    issueId: 'hanbit-oss/term-lint#14',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'available',
    unavailableReason: null,
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary:
      '터미널 문자열에 ANSI 색상 코드와 한글/이모지가 함께 들어갈 때 표시 폭 계산이 어긋나는 문제를 수정하고 단위 테스트를 추가하는 이슈입니다.',
    backgroundKnowledge:
      'ANSI SGR 이스케이프 시퀀스(\\x1b[...m)는 화면 폭을 차지하지 않으며, 전각 한글과 일부 이모지는 2열을 차지하므로 이스케이프 제거 후 표시 폭을 계산해야 합니다.',
    recommendationReason:
      '신생(365일 미만)·소규모 TypeScript 저장소이며 재현 범위가 단위 테스트로 명확하고 담당자가 아직 배정되지 않았습니다.',
    facts: [
      '저장소 규모: 소규모 (185 스타, MIT 라이선스)',
      '신생 여부: 신생 저장소 (생성일 2026-05-12, 365일 미만)',
      '7일 스타 추세: +65 (2026-11-21 120 → 2026-11-28 185)',
      '확인 시점 기준 라벨: good first issue, bug, unicode / 담당자: 없음 / 연결 PR: 없음',
    ],
    inferences: [
      'ANSI 스트립 이후 string-width 계산과 경계 테스트 추가 중심으로 수정 범위가 좁을 가능성이 있습니다.',
    ],
    unknowns: [
      '확인 시점 이후 새로운 댓글·담당자 배정·PR 제출 여부는 GitHub 원문에서 직접 확인해야 합니다.',
      '예상 소요 시간과 메인테이너 리뷰 수용 여부는 확정할 수 없습니다.',
    ],
    evidenceLinks: [
      'https://github.com/hanbit-oss/term-lint/issues/14',
      'https://github.com/hanbit-oss/term-lint',
    ],
  },
  {
    issueId: 'seoul-tools/sqlite-migrator#27',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'available',
    unavailableReason: null,
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary:
      'SQLite 백업 DB 파일의 schema_migrations 상태를 읽기 전용으로 검증하는 CLI 서브커맨드를 추가하는 작업입니다.',
    backgroundKnowledge:
      'SQLite WAL 모드와 읽기 전용 검증, Node.js CLI 서브커맨드 인자 파싱 및 종료 코드 규약에 대한 이해가 도움 됩니다.',
    recommendationReason:
      '신생·소규모 저장소이며 요구 기능이 독립된 서브커맨드로 분리되어 기존 마이그레이션 실행 경로와 충돌 위험이 낮습니다.',
    facts: [
      '저장소 규모: 소규모 (420 스타, Apache-2.0 라이선스)',
      '신생 여부: 신생 저장소 (생성일 2026-02-10, 365일 미만)',
      '7일 스타 추세: 미분류 (7일 창 내 유효 관측 1건)',
      '확인 시점 기준 담당자(@maintainer-jun)가 기록되어 있음',
    ],
    inferences: [
      '담당자가 이미 지정되어 있어 작업 착수 전 원문 코멘트로 진행 현황 확인이 필요합니다.',
    ],
    unknowns: [
      '담당자의 실제 작업 진행 여부와 원하는 출력 포맷 상세는 원문 논의 확인이 필요합니다.',
    ],
    evidenceLinks: [
      'https://github.com/seoul-tools/sqlite-migrator/issues/27',
      'https://github.com/seoul-tools/sqlite-migrator',
    ],
  },
  {
    issueId: 'narae-lab/kv-notes#3',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'available',
    unavailableReason: null,
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary:
      '초기 사용자를 위해 README에 OS별 설치 방법과 기본 단축키 예제를 보강하는 문서화 이슈입니다.',
    backgroundKnowledge:
      'Markdown 작성과 CLI 사용 예제 검증 외에 별도 고급 런타임 지식 없이도 접근할 수 있습니다.',
    recommendationReason:
      '신생·소규모(관측 스타 0) 저장소의 문서 개선 이슈로 첫 기여 입문 부담이 상대적으로 작습니다.',
    facts: [
      '저장소 규모: 소규모 (관측 0 스타, BSD-3-Clause 라이선스)',
      '신생 여부: 신생 저장소 (생성일 2026-09-01, 365일 미만)',
      '7일 스타 추세: 미분류 (관측 기록 없음)',
      '라벨: documentation, good first issue / 담당자: 없음',
    ],
    inferences: [
      '코드 실행 변경 없이 문서 PR로 기여 가능할 가능성이 높습니다.',
    ],
    unknowns: [
      '메인테이너가 기대하는 README 섹션 구조 및 영문/국문 작성 언어 기준은 원문 확인이 필요합니다.',
    ],
    evidenceLinks: [
      'https://github.com/narae-lab/kv-notes/issues/3',
      'https://github.com/narae-lab/kv-notes',
    ],
  },
  {
    issueId: 'open-protocol/mcp-inspector-lite#89',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'available',
    unavailableReason: null,
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary:
      'MCP stdio 전송에서 stdout JSON-RPC 스트림을 보호하기 위해 진단 로그를 stderr로 분리하는 테스트와 문서를 보강합니다.',
    backgroundKnowledge:
      'MCP stdio 전송 규격에서는 stdout에 UTF-8 JSON-RPC 프레임만 출력하고 모든 진단 로그는 stderr로 내보내야 합니다.',
    recommendationReason:
      '중규모 Python 저장소이며 프로토콜 경계 테스트 경험을 쌓기에 적합하나 연결된 PR(#91)이 확인되어 중복 작업 확인이 필요합니다.',
    facts: [
      '저장소 규모: 중규모 (2,840 스타, MIT 라이선스)',
      '신생 여부: 기존 저장소 (생성일 2024-08-20, 365일 이상)',
      '7일 스타 추세: +130 (2026-11-21 2,710 → 2026-11-28 2,840)',
      '확인 시점 기준 연결된 PR 기록이 존재함 (pull/91)',
    ],
    inferences: [
      '연결된 PR이 이미 리뷰 중일 수 있으므로 신규 PR 작성 전 원문 상태를 먼저 확인해야 합니다.',
    ],
    unknowns: [
      'PR #91의 병합 여부 및 추가 테스트 요구 사항은 확인 시점 기준 미확인입니다.',
    ],
    evidenceLinks: [
      'https://github.com/open-protocol/mcp-inspector-lite/issues/89',
      'https://github.com/open-protocol/mcp-inspector-lite/pull/91',
      'https://github.com/open-protocol/mcp-inspector-lite',
    ],
  },
  // Intentional unavailable case 1: explicit unavailable state in demo data
  {
    issueId: 'miri-dev/ansi-canvas#41',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'unavailable',
    unavailableReason: '근거 자료 부족 또는 의도된 데모 설명 불가 케이스로 설정되어 있습니다.',
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary: null,
    backgroundKnowledge: null,
    recommendationReason: null,
    facts: [
      '저장소 규모: 중규모 (1,520 스타, MIT 라이선스)',
      '신생 여부: 미분류 (저장소 생성일 미확인)',
    ],
    inferences: [],
    unknowns: [
      '256색 팔레트 대상 터미널 목록과 허용 오차 기준이 이슈 본문에 충분히 명시되지 않았습니다.',
    ],
    evidenceLinks: [
      'https://github.com/miri-dev/ansi-canvas/issues/41',
      'https://github.com/miri-dev/ansi-canvas',
    ],
  },
  {
    issueId: 'awesome-runtime/fast-ink-ui#1102',
    sourceCheckedAt: SEED_SNAPSHOT_CHECKED_AT,
    availabilityState: 'available',
    unavailableReason: null,
    demoAuthoredAt: SEED_DEMO_AUTHORED_AT,
    summary:
      '대규모 리스트 가상화 렌더링에서 뷰포트 경계 오프셋 계산 테스트를 추가하는 이슈입니다.',
    backgroundKnowledge:
      'React 기반 터미널 UI 레이아웃과 스크롤 윈도우 오프셋 계산에 대한 이해가 필요합니다.',
    recommendationReason:
      '대규모 저장소로 기여 경쟁이나 리뷰 대기 시간이 있을 수 있으나 테스트 코드 범위가 비교적 명확합니다.',
    facts: [
      '저장소 규모: 대규모 (24,600 스타, MIT 라이선스)',
      '신생 여부: 기존 저장소 (생성일 2021-04-03, 365일 이상)',
      '7일 스타 추세: +190 (2026-11-21 24,410 → 2026-11-28 24,600)',
    ],
    inferences: [
      '대규모 저장소이므로 CONTRIBUTING 가이드와 기존 테스트 컨벤션 확인이 권장됩니다.',
    ],
    unknowns: [
      '리뷰 응답 속도와 내부 테스트 유틸리티 변경 여부는 확인되지 않았습니다.',
    ],
    evidenceLinks: [
      'https://github.com/awesome-runtime/fast-ink-ui/issues/1102',
      'https://github.com/awesome-runtime/fast-ink-ui',
    ],
  },
];
