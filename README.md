# Terminal World

터미널 안에서 각자의 개인 터미널 공간을 꾸미고, 여러 공용 공간을 오가며 소통·집중·오픈소스 탐색을 함께하는 개발자 커뮤니티 프로젝트입니다.

## 프로젝트 개요

Terminal World는 개발자에게 익숙한 터미널 환경에서 **SSH 기반 TUI**, **업무 CLI**, **MCP(Model Context Protocol)** 를 통해 하나의 커뮤니티 경험을 제공하는 것을 목표로 합니다.

### 핵심 공간 및 기능 범위
- **공간 탐색**: 격자 기반 공간 이동 및 상세 진입
  - **Lobby**: 현재 접속자 확인, 공지사항, 방명록
  - **Focus Room**: 개인 집중 타이머 및 일별 집중 시간 랭킹
  - **Cafe**: 개발 / 자유 / IT 뉴스 / MCP·Skills / 프로젝트·공모전·해커톤 모집 게시판
  - **RoofTop**: 실시간 자유 채팅방
  - **Living Room**: 자리 비움(AFK) 공간
- **개인 터미널 공간**: ASCII Art 프로필, 컬러 테마, 환영 문구·소개·상태, 기술 스택, 프로젝트 링크 및 방문자 방명록
- **멀티 인터페이스**: SSH TUI · 비대화형 업무 CLI · MCP 서버에서 동일한 계정·권한·데이터 규칙 공유
- **오픈소스 이슈 탐색**: 중·소규모 및 신생·트렌디 오픈소스의 공개 이슈를 언어·분야·관심사 기준으로 탐색

## 현재 구현 상태

현재 저장소에는 **로컬 Ink TUI 프로토타입**과 **요구사항 분석·설계 문서**, 그리고 전체 기능 데모를 위한 **공통 서비스 입력 검증 모듈**이 포함되어 있습니다.

| 영역 | 현재 상태 |
|---|---|
| 로컬 TUI 프로토타입 (`src/cli.tsx`, `src/App.tsx`, `src/model.ts`, `src/storage.ts`) | Lobby / RoofTop / 내 터미널 / 예시 사용자(Mina·Jun·Sol) 방문, 프로필·ASCII·테마 편집, 로컬 채팅·방명록, JSON 영속 저장 |
| 공통 입력 검증 (`src/service/validation.ts`) | 계정명·비밀번호·NFC 텍스트 길이·터미널 제어문자 차단·URL·ASCII Art 검증 및 단위 테스트 |
| 다중 사용자 서버·SSH·CLI·MCP·오픈소스 탐색 | 설계 및 단계별 데모 구현 진행 중 ([`docs/demo-plan.md`](docs/demo-plan.md) 참고) |

## 시작하기

### 요구 사항
- **Node.js 22 이상** (`>=22`)
- 대화형 TTY 터미널 (권장 `100×30`, 최소 `80×24`)

### 설치 및 실행
```bash
npm install
npm run build
npm start
```

### 실행 옵션
```bash
node dist/cli.js --help       # 도움말 및 조작 안내
node dist/cli.js --version    # 버전 출력
node dist/cli.js --no-mouse   # 마우스 입력 비활성화
```

### 기본 조작법 (로컬 TUI)
- `↑` / `↓`: 항목 선택
- `Enter`: 열기 / 전송
- `Tab` / `Shift+Tab`: 포커스 이동
- `Esc`: 취소 / 뒤로 가기
- `Ctrl+S`: 프로필 저장
- `Ctrl+C`: 종료

> 로컬 프로토타입의 데이터는 macOS 기준 `~/Library/Application Support/Terminal World/state.json`에 저장됩니다.

### 타입 체크 및 테스트
```bash
npm run typecheck     # TypeScript 타입 검사
npm test              # 모델·스토리지·UI·앱·서비스 입력 검증 테스트
npm run test:package  # 패키징 및 CLI 실행 테스트
```

## 프로젝트 구조

```text
Terminal-World/
├── src/
│   ├── cli.tsx                  # CLI 진입점 및 터미널 입출력 설정
│   ├── App.tsx                  # Ink 기반 TUI 메인 애플리케이션
│   ├── model.ts                 # 로컬 프로토타입 도메인 모델
│   ├── storage.ts               # 로컬 JSON 스냅샷 저장소 및 잠금 처리
│   ├── catalog.ts               # 기본 공간·예시 사용자 데이터
│   ├── ui/                      # TUI 컴포넌트 및 마우스/키보드 입력 처리
│   └── service/
│       └── validation.ts        # 공통 서비스 입력 검증 규칙
├── tests/                       # 단위·통합·패키징 테스트
├── docs/                        # 요구사항 분석, 도메인 모델, 설계 결정, 데모 계획
├── research/                    # 제품 방향성 및 커뮤니티 리서치 자료
└── strategy-lab/                # 리서치 시각화 및 검증 스크립트
```

## 주요 문서

- [요구사항 분석서 (`docs/requirements-analysis.md`)](docs/requirements-analysis.md)
- [유스케이스 및 도메인 모델 (`docs/analysis-models.md`)](docs/analysis-models.md)
- [요구사항 개정 결정 (`docs/2026-11-02.md`)](docs/2026-11-02.md)
- [설계 결정 기록 (`docs/design-decisions.md`)](docs/design-decisions.md)
- [전체 기능 데모 계획 (`docs/demo-plan.md`)](docs/demo-plan.md)

## 기술 스택

- **Language**: TypeScript 5.9 (ESM, NodeNext)
- **TUI Framework**: React 19, Ink 8, `@ink-tools/ink-mouse`, `xterm-mouse`
- **Runtime & Test**: Node.js 22+ (`node:test`)
