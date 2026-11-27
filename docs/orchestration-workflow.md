# Terminal-World Orca 병렬 오케스트레이션 워크플로 가이드

이 문서는 `Terminal-World` 저장소(TypeScript · Node.js `>=22` · Ink · `node:sqlite` · `ssh2` · MCP SDK)에서 승인된 [구현 계획](implementation-plan.md)(Phase 3~10)을 **Orca 병렬 Worktree Worker**로 분할 구현하고, 통합 배선 및 독립 검수까지 수행하는 표준 워크플로입니다.

- 기준 명세: [요구사항 분석 명세](requirements-analysis.md), [설계 결정 기록](design-decisions.md), [아키텍처·데이터 설계](architecture-spec.md), [인터페이스·화면 설계](interface-spec.md), [구현 계획](implementation-plan.md)

---

## 1. 역할 및 모델 구성

| 역할 | 실행 환경 | Agent / Model / Effort | Worktree | 책임 |
| --- | --- | --- | --- | --- |
| **Coordinator** | 현재 Antigravity CLI 세션 | Gemini 4 Neon · Medium | `main` (현재 워크스페이스) | 선행 기반(Wave 0) 구축, 파일 소유권 분리 및 스펙 작성, Worker 병렬 실행, 브랜치 머지·크로스-모듈 배선·E2E 통합, 리뷰 이슈 최종 반영 |
| **구현 Worker** (최대 3개 동시) | Orca Supervised Worker | `antigravity` · `gemini-4-hydrogen-high` · `high` | `--worktree new-child --name <track>` | 배정된 파일 소유권 범위 내 구현, 단위/통합 테스트 작성, `typecheck`/`build`/`test` 검증 후 브랜치 커밋 |
| **검수 Worker** (1개) | Orca Supervised Worker | `antigravity` · `gemini-4-neon-medium` · `medium` | `--worktree current` | 통합된 전체 diff 감사, FR 30개·UC 18개·확정 정책·엣지케이스·회귀 검증, 전체 테스트 독립 실행 (코드 수정 없이 리포트) |

> 모델 ID 확인: `agy models`
> Orca CLI 경로 (macOS): `/Applications/Orca.app/Contents/Resources/bin/orca` (또는 `$ORCA_CLI_COMMAND`)

---

## 2. Terminal-World Wave 구성 및 파일 소유권 분리

파일 충돌을 방지하기 위해 **공통 기반(Wave 0)**을 Coordinator가 `main`에 먼저 구축·커밋한 뒤, **Wave 1 → Wave 2**를 각각 최대 3개 병렬 Worker로 실행하고, 마지막으로 **Wave 3(독립 검수)**를 수행합니다.

### 공통 수정 금지 경계 (모든 구현 Worker 공통)
- 분석 원본 문서·공유본: `docs/requirements-analysis.md`, `docs/analysis-models.md`, `docs/analysis-deliverables.md`, `docs/2026-*.md`, `requirement-analysis.zip`
- 기존 로컬 프로토타입 보존 파일: `src/model.ts`, `src/storage.ts`, `src/App.tsx`, `src/catalog.ts`, `tests/model.test.ts`, `tests/storage.test.ts`, `tests/app.test.tsx`, `tests/ui.test.ts`, `tests/package.test.mjs`
- 공유 진입점(`package.json`, `src/cli.tsx`, `docs/demo-plan.md`, `README.md`)은 각 Wave 통합 시 **Coordinator만** 수정합니다.

### Wave 0. 선행 기반 구축 (Coordinator 단독 — Phase 3)
1. 현재 `git status` 및 기준 커밋 해시(`<BASE_SHA>`)를 기록하고, 기존 테스트(`npm run typecheck && npm run build && npm test`) 통과를 확인합니다.
2. Coordinator가 `main`에서 Phase 3 기반을 직접 구현·커밋합니다:
   - `package.json` (`ssh2`, `@modelcontextprotocol/sdk`, `zod`, `@types/ssh2` 추가 및 `npm test`를 `tsconfig.test.json` 기반으로 확장), `package-lock.json`, `tsconfig.test.json`
   - `src/core/clock.ts`, `src/core/errors.ts`, `src/core/crypto.ts`
   - `src/store/sqlite/migrations.ts`, `src/store/sqlite/database.ts` (전체 ERD 스키마·WAL·`tombstones.log`·`VACUUM INTO` 기반)
   - `src/core/auth-service.ts`, `tests/core-auth.test.ts`
3. 검증 통과(`npm run typecheck && npm run build && npm test && git diff --check`) 후 `main`에 커밋합니다. (이후 Wave 1의 모든 Worktree가 동일한 `package-lock.json`·SQLite 스키마·공통 코어 위에서 분기합니다.)

### Wave 1. 핵심 기능 병렬 구현 (최대 3개 Worker — Phase 4 · 5 · 6)

| Worker | Worktree 이름 | 대응 Phase | 배타적 파일 소유권 |
| --- | --- | --- | --- |
| **W1** | `w1-profile-ssh-tui` | Phase 4 | `src/core/profile-service.ts`, `src/core/guestbook-service.ts`, `src/ssh/ssh-server.ts`, `src/tui/world-map.ts`, `src/tui/components/*`, `src/tui/WorldApp.tsx`, `src/tui/screens/AuthGateScreen.tsx`, `src/tui/screens/PersonalSpaceScreen.tsx`, `tests/world-map-and-ssh.test.ts` |
| **W2** | `w2-community-board` | Phase 5 | `src/core/board-service.ts`, `src/core/recruitment-service.ts`, `src/core/notice-service.ts`, `src/tui/screens/CafeScreen.tsx`, `src/tui/screens/RecruitmentScreen.tsx`, `src/tui/screens/LobbyScreen.tsx`, `tests/core-community.test.ts` |
| **W3** | `w3-realtime-focus` | Phase 6 | `src/core/realtime-hub.ts`, `src/core/presence-service.ts`, `src/core/chat-service.ts`, `src/core/focus-service.ts`, `src/tui/screens/RoofTopScreen.tsx`, `src/tui/screens/FocusScreen.tsx`, `src/tui/screens/LivingRoomScreen.tsx`, `tests/core-realtime-focus.test.ts` |

- **Wave 1 통합 (Coordinator)**: `orca/w1-profile-ssh-tui`, `orca/w2-community-board`, `orca/w3-realtime-focus`를 `main`에 순차 머지 → `WorldApp.tsx`에 Cafe·Recruitment·Lobby·RoofTop·Focus·LivingRoom 화면 및 `RealtimeHub` 배선 → `npm run typecheck && npm run build && npm test && git diff --check` 통과 후 `main` 커밋.

### Wave 2. 운영·연동·오픈소스 병렬 구현 (최대 3개 Worker — Phase 7 · 8 · 9)

| Worker | Worktree 이름 | 대응 Phase | 배타적 파일 소유권 |
| --- | --- | --- | --- |
| **W4** | `w4-lifecycle-mod` | Phase 7 | `src/core/account-lifecycle-service.ts`, `src/core/moderation-service.ts`, `src/core/retention-service.ts`, `src/tui/screens/AccountSecurityScreen.tsx`, `src/tui/screens/AdminPanelScreen.tsx`, `tests/core-lifecycle-moderation.test.ts` |
| **W5** | `w5-auth-cli-mcp` | Phase 8 | `src/core/integration-auth-service.ts`, `src/bridge/http-bridge.ts`, `src/cli-cmd/*`, `src/mcp/*`, `src/server.ts`, `tests/cli-mcp-auth.test.ts` |
| **W6** | `w6-oss-demo-ai` | Phase 9 | `src/discovery/github-client.ts`, `src/discovery/seed-snapshot.ts`, `src/discovery/demo-explainer.ts`, `src/core/discovery-service.ts`, `src/tui/screens/OssDiscoveryScreen.tsx`, `tests/discovery-demo-ai.test.ts` |

- **Wave 2 통합 & Phase 10 마감 (Coordinator)**:
  1. `orca/w4-lifecycle-mod`, `orca/w5-auth-cli-mcp`, `orca/w6-oss-demo-ai`를 `main`에 순차 머지합니다.
  2. 크로스-모듈 배선을 수행합니다:
     - `src/cli.tsx` 서브커맨드 라우팅 추가 (기존 무인수 로컬 프로토타입 및 `--help`/`--version`/`--no-mouse` 호환 유지)
     - `src/server.ts`·`src/bridge/http-bridge.ts`·`src/cli-cmd/router.ts`·`src/mcp/tools.ts`·`src/tui/WorldApp.tsx`에 Phase 7(복구/탈퇴/신고/관리/백업) 및 Phase 9(오픈소스/데모 AI) 전체 연결
  3. Phase 10 통합 E2E 테스트(`tests/e2e-full-demo.test.ts`) 작성 및 [docs/demo-plan.md](demo-plan.md)·[README.md](../README.md) 갱신.
  4. 전체 검증(`npm run typecheck && npm run build && npm test && npm run test:package && git diff --check`) 통과 후 `main` 커밋.

---

## 3. 단계별 실행 절차

### Step 1. 스펙 파일 작성 (각 Wave 시작 전)
각 Worker의 작업 지시서를 임시 디렉터리(`$SDIR`)에 별도 Markdown 파일(`--spec-file`)로 작성합니다.
- **필수 포함 항목**:
  1. 참고할 기준 문서(`docs/architecture-spec.md`, `docs/interface-spec.md`, `docs/implementation-plan.md`, `docs/requirements-analysis.md`)
  2. 배타적 담당 파일 목록 및 수정 금지 파일 목록
  3. 크로스-트랙 계약(함수/클래스 시그니처, 오류 코드, 이벤트 타입)
  4. **Worktree 의존성 준비**: 새 Worktree에는 `.gitignore`된 `node_modules`가 없으므로, 작업 시작 시 `npm ci --prefer-offline --no-audit --no-fund` 실행 지시
  5. 검증 명령: `npm run typecheck && npm run build && npm test && git diff --check`
  6. 작업 브랜치 커밋 지시 및 마지막 줄: `Placement: this machine (local), the user named it.`

### Step 2. 병렬 Worker 실행 (Wave 1 / Wave 2 공통 패턴)
한 번의 셸 명령에서 백그라운드(`&`)로 최대 3개 Worker를 동시에 시작하고 `wait`로 receipt를 수집합니다. 모든 `worker-start`에는 `--environment local`을 명시합니다.

```sh
d=$(mktemp -d)
ORCA=/Applications/Orca.app/Contents/Resources/bin/orca
SDIR=/path/to/specs

"$ORCA" orchestration worker-start \
  --environment local \
  --spec-file "$SDIR/w1-spec.md" \
  --task-title "W1: Profile, SSH server & 2.5D avatar TUI" \
  --worktree new-child --base-branch main --name w1-profile-ssh-tui \
  --agent antigravity --model gemini-4-hydrogen-high --effort high \
  >"$d/w1.out" 2>"$d/w1.err" & p1=$!

"$ORCA" orchestration worker-start \
  --environment local \
  --spec-file "$SDIR/w2-spec.md" \
  --task-title "W2: Cafe 7 boards, recruitment & notices" \
  --worktree new-child --base-branch main --name w2-community-board \
  --agent antigravity --model gemini-4-hydrogen-high --effort high \
  >"$d/w2.out" 2>"$d/w2.err" & p2=$!

"$ORCA" orchestration worker-start \
  --environment local \
  --spec-file "$SDIR/w3-spec.md" \
  --task-title "W3: RealtimeHub, presence, chat & focus ranking" \
  --worktree new-child --base-branch main --name w3-realtime-focus \
  --agent antigravity --model gemini-4-hydrogen-high --effort high \
  >"$d/w3.out" 2>"$d/w3.err" & p3=$!

s=0; wait "$p1" || s=$?; echo "w1 exit $s"
s=0; wait "$p2" || s=$?; echo "w2 exit $s"
s=0; wait "$p3" || s=$?; echo "w3 exit $s"
for f in "$d"/*; do echo "== $f"; cat "$f"; done
```

- Worker 시작이 완료되면 Coordinator는 **턴을 종료**하고 Orca의 `worker_done` 알림을 기다립니다(폴링/watch 스크립트 금지).

### Step 3. 통합 · 크로스-모듈 배선 (각 Wave 종료 시 Coordinator)
1. 모든 구현 Worker가 `outcome: "succeeded"`로 보고하면 각 Worktree 브랜치(`orca/<name>`)를 `main`에 순차 머지합니다:
   ```sh
   git merge --no-edit orca/w1-profile-ssh-tui
   git merge --no-edit orca/w2-community-board
   git merge --no-edit orca/w3-realtime-focus
   ```
2. 트랙 간 배선과 중복 헬퍼 정리를 수행합니다.
3. 전체 검증을 실행하고 통합 커밋을 생성합니다:
   ```sh
   npm run typecheck && npm run build && npm test && git diff --check
   ```
   (Wave 2 + Phase 10 최종 통합 시에는 `npm run test:package`까지 실행합니다.)

### Step 4. 독립 검수 · 테스트 및 최종 수정 (Wave 3 — Review Worker)
1. 검수 전용 `--spec-file`에 아래 항목을 명시합니다:
   - 감사 범위: `<BASE_SHA>..HEAD` 전체 diff
   - 읽기 전용 감사 원칙(코드 수정 없이 Critical / Medium / Minor 리포트 반환)
   - 체크리스트:
     - FR 30개(`FR-01~20`, `FR-22~31`, 삭제된 `FR-21` 미복원) 및 UC 18개 충족 여부
     - 확정 정책 준수: 신생 365일 미만, 트렌드 7일 순증(미관측 `미분류`), 연동 승인 최대 30일/관리자 4시간 + Access/Refresh 로테이션 및 Replay 탐지 회수, 6자리 원타임 승인 코드, `120×30+` 2.5D 아바타 자유 이동 맵 + `80×24` 목록 폴백, `--data-dir/ssh_host_ed25519.key`(`0600`)
     - 보안·동시성·보존: 자격 회수 vs 쓰기 경합 차단, 비밀번호/복구코드/토큰 비노출, 외부 본문 `untrustedContent` 처리, 14일/90일 만료 및 7일 백업 복구 후 Tombstone 재적용, 분석 원본 문서·기존 로컬 프로토타입 무훼손
   - 독립 실행 명령: `npm run typecheck && npm run build && npm test && npm run test:package && git diff --check`
   - 마지막 줄: `Placement: this machine (local), the user named it.`
2. 검수 Worker를 `--worktree current`로 실행합니다:
   ```sh
   /Applications/Orca.app/Contents/Resources/bin/orca orchestration worker-start \
     --environment local \
     --spec-file "$SDIR/review-spec.md" \
     --task-title "Review: Independent audit & full verification" \
     --worktree current \
     --agent antigravity --model gemini-4-neon-medium --effort medium
   ```
3. 검수 완료(`worker_done`) 후 발견된 Critical / Medium / Minor 이슈를 Coordinator가 수정하고 회귀 테스트를 추가합니다.
4. 최종 검증(`npm run typecheck && npm run build && npm test && npm run test:package && git diff --check`) 통과 후 커밋하고 사용자에게 보고합니다.

---

## 4. 운영 규칙 요약
- **커밋 Co-author 필수**: Coordinator 및 모든 Worker의 모든 `git commit` 메시지 마지막에는 빈 줄 뒤에 반드시 아래 trailer를 포함합니다:
  ```text
  Co-authored-by: Gemini <200291788+gemini-code-assist@users.noreply.github.com>
  ```
- **Heredoc(`<<`) / Here-string(`<<<`) 금지**: 멀티라인 텍스트는 항상 파일로 작성해 `--spec-file`로 전달합니다.
- **폴링 금지**: `worker-start` 이후에는 턴을 마치고 Orca의 자동 깨우기(`worker_done`)를 기다립니다.
- **Worktree 의존성**: 각 `new-child` Worktree에서 `npm ci --prefer-offline --no-audit --no-fund`를 실행해 독립 검증 환경을 확보합니다.
- **작업 후 정리**: 머지와 검수가 끝난 Worktree는 `orca worktree` / `orca orchestration worker-release`로 정리합니다.
