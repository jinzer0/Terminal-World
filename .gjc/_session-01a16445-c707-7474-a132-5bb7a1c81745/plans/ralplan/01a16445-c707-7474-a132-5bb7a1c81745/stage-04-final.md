# Terminal World 구현 계획 — 합의 수정본 4

- Status: pending approval; execution not approved.
- Owner session/run: 01a16445-c707-7474-a132-5bb7a1c81745.
- Planner: 10-TerminalWorldPlanner; 수정 판단/문구 출처 agent://10-TerminalWorldPlanner.
- Native transport: Planner의 필수 explicit-root writer는 unborn Git 검사에서 exit2로 실패했고 영수증이 없었다. 부모가 실제 Planner 반환 변경만 성공한 동일 루트 cwd-mode native writer로 보존한다. 직접 .gjc 파일 수정, 초기 커밋, force, 제품 변경 없음.

## Normative Plan and Change Boundary

이 수정본은 같은 run의 **stage-03-planner.md 전체**(SHA256 `[REDACTED]`)를 필수 본문으로 편입한다. 구현/검증자는 이 수정본과 해당 고정 본문을 함께 읽는다. 아래에 명시한 부분만 원문의 해당 항목을 대체하며, 나머지 RALPLAN-DR 원칙·D1–D3·O1/O2·T01–T12·스키마·카탈로그·팔레트·입력 제한·저장 정책·M0–M4·AC1–AC8·G1/G2/G4/G5·V1/V2/V4/V5/V6·배포 계약·Intent Reconciliation·ADR·위험은 **변경 없이 유지**한다. 별도 대안 계획이나 구현 범위 축소가 아니다.

## RALPLAN-DR Summary

- 원칙: 작은 완결 자기표현 제품, 로컬 데이터 진실성, 단일 소유/테마·입력·저장 경계, 증거에 비례한 호환 주장.
- Drivers: D1 저장 신뢰성, D2 macOS 실제 Unicode/키보드/마우스 조작, D3 npm/Bun 설치 및 npx/bunx 배포.
- Options: O1 작은 reducer+순수 JS JSON 스냅샷을 채택; O2 동일 Ink UI+SQLite는 유효하나 현재 규모의 네이티브 드라이버/런타임 설치 검증 비용 때문에 비채택. 언어는 사용자 선택 TS+React+Ink로 고정.

## Revised T02 — CLI and shutdown owner

T02 책임 셀을 다음으로 대체한다:

Node shebang, `--help`/`--version`/`--no-mouse`, TTY 검사, 저장소 시작/종료, `render(..., {exitOnCtrlC: false})`. Ctrl+C와 SIGTERM을 하나의 멱등 `requestShutdown` 소유자로 전달하고 pending commit 결과 확인 후에만 unmount→터미널 복원→잠금 해제를 정확히 한 번 수행. 경쟁 종료 콜백이나 pending 정리 전 `process.exit` 금지. `--help`/`--version`은 저장 경로/잠금을 생성하지 않음.

## Revised keyboard shutdown contract

기존 Ctrl+C bullet을 다음으로 대체한다:

- Ctrl+C는 모든 상태에서 종료. T02의 Ink 진입은 반드시 `render(..., {exitOnCtrlC: false})`로 자동 Ctrl+C exit를 비활성화한다. 앱의 Ctrl+C 입력과 SIGTERM은 하나의 멱등 `requestShutdown`만 호출한다. 이 소유자는 새 저장/입력을 막고 진행 중 commit의 성공·실패·불확실 결과를 먼저 확인한 뒤에만 unmount→터미널 복원→잠금 해제를 정확히 한 번 수행한다. 반복 Ctrl+C/SIGTERM은 같은 종료 promise를 공유한다. 경쟁 종료 콜백이나 pending 정리 전 `process.exit`는 두지 않는다. dirty 초안은 미저장이라는 안내 후 종료하고 원래 데이터는 유지한다. 강제 종료/SIGKILL에서 cleanup을 보장하지 않는다.

## Revised storage policy 9

9. Ctrl+C/정상 종료/SIGTERM과 예외는 T02의 단일 멱등 `requestShutdown` 경로를 사용한다. `exitOnCtrlC: false`로 Ink 자동 종료를 막고, pending commit 결과 확인 이전에는 unmount·raw mode/커서/mouse tracking 복원·잠금 해제를 하지 않는다. pending 결과 확인 후 unmount→터미널 복원→소유 잠금 해제를 정확히 한 번 시도한다. 경쟁 종료 콜백과 pending 정리 전 `process.exit`는 금지한다. cleanup 실패는 경로와 경고를 남기며 state.json을 삭제하지 않는다. 강제 종료 시 atomic 저장 전/후 중 유효한 전체 상태를 유지하는지 장애 테스트로 확인한다.

## Revised G3 — Storage reliability gate

| Gate | 승인 후 객관적 검증 | 실패 정책 |
|---|---|---|
| G3 저장 신뢰성 | M1/M3 저장 오류 주입, rename 전/후 실패, 두 프로세스 충돌, 손상 파일 hash 불변. 실제 T02 `render(..., {exitOnCtrlC: false})` 설정을 사용한 deferred commit 중 Ctrl+C 및 SIGTERM 시험: pending settle 전 unmount/터미널 복원/잠금 해제 0회, resolve 또는 reject 후 결과 확인→unmount→복원→잠금 해제 순서 및 반복 신호의 정확히 한 번 cleanup 확인 | 잘못된 성공/중복/데이터 손실/조기 종료이면 진행 중단하고 T02/T05 수정. 메모리 fallback/조용한 reset/경쟁 종료 콜백 금지 |

## Revised V3 — UI/command integration verification

| ID | 승인 후 구체 검증 | AC |
|---|---|---|
| V3 | Ink 가짜 입력/출력 스트림+reducer 테스트. deferred commit을 resolve하기 전 리스트0/초안유지→resolve 후1, reject 후0/초안유지, 연타/재시도 중복0. 6 routes, 대상별 방명록, theme scope, Tab/Esc/키 입력/스크롤 clamp, dirty navigation 차단, 소형 화면 복귀. 종료 회귀는 실제 T02 render 설정(`exitOnCtrlC: false`)과 shutdown owner를 사용: Ctrl+C는 입력 스트림으로 전달하고 SIGTERM은 격리된 자식 프로세스에 전달하여 각각 deferred commit의 resolve/reject 전 cleanup 0회, 결과 확인 후 unmount→터미널 복원→잠금 해제 순서를 기록. 반복/혼합 신호에도 동일 종료 promise와 정확히 한 번 cleanup, settle 전 `process.exit` 없음 확인. reducer-only 모의 종료로 대체하지 않음 | AC2/3/4/5/6/7 |

## Revised package artifact path and producer step

원문의 명령 목록 직전 문단과 생산자 단계1을 다음으로 대체한다. 다른 소비자 명령과 동일 tgz 계약은 유지한다.

아래 명령은 **승인 후 실행 예시이며 지금 실행하지 않았다**. `npm pack --json`의 `filename`은 tarball basename이다. 생산자는 pack-destination 디렉터리를 절대 경로로 정한 뒤 반환된 `filename`을 그 디렉터리에 대해 resolve하여 **절대 tarball 경로 `$TGZ`**를 만든다. `--pack-destination`을 생략하면 생산자의 pack 실행 cwd가 그 디렉터리다. `$PREFIX`와 cwd는 테스트 전용 디렉터리다. 전역 설치는 시스템 전역이 아닌 독립 prefix/global-dir+bin-dir로 격리한다. 각각 별도 테스트 홈을 사용한다.

1. 생산자: `npm ci`, `npm run build`, `npm test`, `npm run test:package`, `npm pack --json`. 반환 `filename`을 pack-destination 디렉터리에 대해 resolve한 절대 tgz 경로·파일 목록·sha256을 증거로 남기고 같은 tgz를 다음 모든 경로에 쓴다. `npm publish`는 실행하지 않는다.

## Review Resolutions

- 기준: stage-03-planner.md SHA256 `[REDACTED]`의 review pass 1. 검토 근거는 같은 run의 stage-03-architect.md SHA256 `[REDACTED]` 및 stage-03-critic.md SHA256 `[REDACTED]`다.
- ARCH-01 / C-N01 → T02, 키보드 종료 계약, 저장 정책9, G3/V3: 자동 종료 해제/단일 pending-aware 종료/실제 render 구성의 집중 회귀 검증을 명시했다. 기존 데이터 보존 의도를 구체화하며 새로운 기능을 추가하지 않는다.
- C-N02 → T12: filename basename을 pack destination 기준으로 resolve하는 경로 설명만 바로잡았다.
- typed conflicts: none. Architect change(T02)와 Critic add(T02)는 같은 해결 방향이며 remove 대 add/change 충돌이 없다. 필수 수정의 심각도 평가는 다르지만 처방은 양립한다.
- 이 문서는 계획 수정 주장이고 테스트 통과나 재검토 승인이 아니다. 다음 리뷰가 같은 stage4/SHA를 확인해야 한다.

## Intent Reconciliation

stage-01-intent.md(SHA256 `[REDACTED]`)와 stage3의 확정 해석을 유지한다. 사용자 후속 결정 TS+React+Ink/npm/Bun/npx/bunx가 과거 기술 미선택 문구를 대체한다. Node shebang 경로가 필수이며 Bun-native 보장은 아니다. 마우스는 유지한다. 실제 실행 승인 후 객관적인 불가능성이 확인될 때만 기존 사용자 조건부 허용으로 제거하며, 같은 허용을 재질문하지 않는다. 현재 제거 조건을 충족하는 증거는 없다. 새 제품 의도 질문이나 범위 확대는 없다.

## ADR

- Decision: 작은 reducer/Ink UI, 순수 JS JSON 스냅샷 O1, 단일 작성자 잠금, confirmed-write 화면 반영, 사전 컴파일 JS/Node bin 배포를 유지한다. T02 종료 소유권만 명시적으로 보강한다.
- Drivers: D1 데이터 신뢰성, D2 macOS 조작 품질, D3 npm/Bun 설치 및 npx/bunx 실행 마찰 최소화.
- Alternatives considered: O2 SQLite는 유효하나 현재 크기에서 런타임/드라이버 검증 비용으로 비채택. 기본 Ink 자동 Ctrl+C 종료는 pending-aware 종료 계약과 충돌하여 비채택. 언어 선택은 다시 열지 않는다.
- Why chosen: 원래 기능·데이터·테마 경계를 보존하면서 외부 라이브러리 기본 동작과 앱 종료 큐의 충돌만 제거한다.
- Consequences: Node 필요, JSON 전체 재기록/보수적 잠금 복구 부담은 유지된다. Bun-native/registry 게시/원격 서비스 지원을 주장하지 않는다. 반복 종료 요청은 동일 promise를 공유하고 commit 결과 후 cleanup한다.
- Follow-ups: 실행 승인 후 원문 M0→M4, G1–G5, V1–V6와 강화된 G3/V3를 수행한다. 현재 제품 코드·설치·테스트·실험·포맷·git 변경은 수행하지 않았다.
