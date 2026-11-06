# Terminal World 구현 계획 — RALPLAN-DR

## Summary

- 상태: **계획 완료, 구현 승인 대기**. 이번 작업은 명세·공개 메타데이터·소스의 읽기와 네이티브 계획 저장만 수행한다. 제품 파일 생성/수정, 설치, 실행, 테스트, 린트, 포매팅, 커밋, 게이트 실행은 하지 않았다.
- 기준 명세: `.gjc/_session-01a16445-c707-7474-a132-5bb7a1c81745/specs/deep-interview-terminal-world-prototype.md` 전체 요구사항과 AC1–AC8. 명세의 ‘기술 스택 미선택’은 이후 사용자 결정으로 대체된다. **TypeScript + React + Ink**, npm/Bun 설치 및 npx/bunx 실행이 확정이다. 언어를 다시 선택하지 않는다.
- 제품 목표: macOS 로컬 다크 TUI에서 닉네임으로 입장하고 내 공간을 꾸미며 로비·RoofTop·예시 사용자 터미널을 탐색한다. 직접 작성한 채팅과 대상별 방명록은 저장 성공 후 표시하고 재시작해 복구한다.
- 권고안: 작은 React reducer + Ink 화면 구성, 순수 JS JSON 원자적 저장, 단일 작성 프로세스. 마우스는 `@ink-tools/ink-mouse@2.1.0`으로 유지하며 첫 구현 단계에서 실제 TTY 통합 검증을 수행한다.
- 저장소 근거: 루트 `package.json`, `src/**`, `AGENTS.md` 탐색에서 제품 소스가 없었다. `git status --short`의 `.DS_Store`, `.agents/`, `.gjc/`, `.omx/`, `_bmad/`, 이미지와 기능 문서는 사용자 소유 미추적 자료다. 삭제·정리·포맷·일괄 git add 하지 않는다. `세부기능.md`와 이미지를 추가 요구사항으로 끌어오지 않는다.

## Intent Diff

| 항목 | 유지/구체화 | 범위 차이 |
|---|---|---|
| artifact:prototype-spec | 명세와 AC1–AC8을 구현 가능한 계약으로 연결 | 제품 구현 승인을 의미하지 않음 |
| surface:terminal-tui | 왼쪽 목록/오른쪽 콘텐츠, 다크 스타일, 실제 키보드와 마우스 | 웹 모사·격자 지도 아님 |
| integration:connection | 로컬 실행 및 명확한 예시/로컬 표기 | SSH·서버·실제 전달 없음 |
| constraint:one-at-a-time | 제품 질문을 다시 열지 않고 기술 기본값 명시 | 새 범위 결정이 필요할 때만 승인 요청 |
| 최신 스택 결정 | TS/React/Ink와 npm/Bun/npx/bunx 배포 계약 채택 | 명세의 오래된 미선택 문구만 대체 |
| 마우스 | 클릭·휠 유지, 증거 기반 go/no-go | ‘Ink 코어에 없음’을 삭제 근거로 삼지 않음 |

## Intent Reconciliation

`stage-01-intent.md`(stage `intent`, stage_n `1`, SHA256 `[REDACTED]`)의 항목 4를 반영한다. 사용자는 마우스가 객관적으로 불가능할 경우 제거하도록 이미 조건부 허용했다. 실행 승인 후 G1의 실제 증거와 architect 검토로 수정 가능한 통합 결함 및 단일 TTY 미지원을 배제하고 조건이 충족되면, 재승인 요청 없이 그 사전 허용을 적용한다. 정확한 이유·증거·키보드 전용으로 조정한 AC6/범위를 기록하고 한계를 보고한다. 현재 제거 조건을 충족하는 증거는 없으므로 마우스는 계속 범위에 포함한다. 다른 계획 결정은 변경하지 않는다.

## Decision Drivers

### 원칙 4개

1. **자기표현 우선, 완결된 작은 제품**: 내 공간 저장/재실행을 먼저 end-to-end로 만들되 채팅·방명록을 누락하지 않는다.
2. **로컬 진실성**: 예시 데이터와 내가 쓴 로컬 데이터를 구분하고 저장 전에는 ‘보냈음/저장됨’으로 보이지 않는다.
3. **단일 소유와 명시적 경계**: 개인 테마는 해당 터미널 콘텐츠에만 적용하고 저장소·입력·렌더링을 작은 모듈로 분리한다.
4. **증거에 비례하는 호환성 주장**: 공개 peer/engine 범위는 후보 적합성일 뿐 실측 증명이 아니다. 실패 시 데이터·초안·터미널 상태를 우선 보존한다.

### 우선순위 상위 3개

1. **D1 데이터 신뢰성**: 프로필/메시지/대상별 방명록 복구와 실패 시 비파괴 처리.
2. **D2 macOS 실제 조작 품질**: 한글, 폭, 포커스, 리사이즈, 마우스와 키 입력 공존.
3. **D3 설치 없이 시작하기 쉬운 배포**: 사전 컴파일된 JS/bin을 npm/Bun과 npx/bunx로 동일하게 실행, 네이티브 SQLite 빌드 회피.

가정: 한 macOS 계정당 로컬 프로필 하나, 닉네임 변경/다중 프로필/삭제 UI는 만들지 않는다. 한글 IME의 조합 자체는 터미널이 담당하며 앱은 전달된 Unicode와 붙여넣기를 처리한다. Bun은 우선 설치/실행 도구이며 Bun-native 런타임은 필수가 아니다. 이 기본값으로 추가 제품 인터뷰 없이 진행한다.

## Options

모든 선택지는 확정된 TypeScript + React + Ink 안의 대안이다.

| 선택지 | 구성/장점 | 비용/제약 | 판정 |
|---|---|---|---|
| **O1 reducer + JSON 스냅샷** | React reducer가 포커스·화면·초안 관리, `node:fs/promises`가 전체 상태 원자적 교체. DB/네이티브 모듈 없음. 작은 로컬 데이터에 단순하고 npm/Bun 설치 부담 낮음 | 전체 파일 재기록, 파일 손상 검증과 단일 작성자 잠금 직접 필요, 대량 데이터에 부적합 | **채택**. 이번 한 사용자·짧은 로컬 기록에 적합 |
| **O2 같은 Ink UI + SQLite 저장소** | 프로필/채팅/방명록 테이블, 트랜잭션과 대상 인덱스로 원자성·조회가 명확. 데이터가 커져도 전체 재기록 불필요 | `better-sqlite3` 같은 외부 드라이버는 macOS/Node ABI·Bun·prebuilt 부재 때 네이티브 빌드 검증이 필요. `node:sqlite`는 선택한 Node 하한에서 일관된 안정 API라고 가정할 수 없고 `bun:sqlite`는 Bun-native에 묶임 | 기술적으로 유효하나 **이번에는 비채택**. SQLite가 불가능하다는 뜻이 아니라 현재 규모와 배포 우선순위에서 비용이 큼 |

별도 상태관리 프레임워크, 라우터, ORM, 플러그인 계층은 도입하지 않는다. O1을 완결된 설계로 구현하며 ‘나중에 SQLite로 옮기기 위한’ 추상 저장소/마이그레이션 계층도 만들지 않는다. 실제 요구가 바뀌기 전에는 O2로 전환하지 않는다.

### 의존성·런타임 결정 [T01]

직접 런타임 의존성은 `ink: 8.0.0`, `react: 19.3.0`, `@ink-tools/ink-mouse: 2.1.0`, `string-width: 8.3.0` 네 개로 정확히 고정한다. 마우스 패키지의 전이 의존성 `xterm-mouse: 1.0.0`도 lock에서 확인한다. 개발 의존성은 `typescript: 5.9.3`, `@types/react: 19.3.0`, `@types/node: 22.18.6`만 우선 추가한다. 테스트는 Node 내장 test/assert와 Ink의 렌더 스트림을 사용해 전용 러너/PTY 네이티브 패키지를 필수화하지 않는다. 추가 패키지는 첫 검증에서 실제 필요가 입증된 경우에만 명시적으로 선택한다.

- `ink@8.0.0` 공개 메타데이터: Node `>=22`, React `>=19.3.0`. package `engines.node`는 `>=22`로 설정한다. 이는 선언된 하한이며 Node 22.0.0부터 모든 패치에서 검증됐다는 주장이 아니다. 최소 메이저 Node 22의 검증에 쓴 정확한 패치와 Node 24 대조 결과를 기록하고 전이 엔진 제약도 확인한다.
- `@ink-tools/ink-mouse@2.1.0`: Node `>=20`, peer Ink `>=6`/React `>=17`. 공개 배포 타입/JS에 `MouseProvider`, `useOnClick`, `useOnWheel`이 존재한다. README의 Ink `^6.6.0`/React `^19.2.3` 문구보다 **버전 지정 npm 메타데이터**를 우선한다. Ink8과의 실제 통합은 아직 미검증이다.
- 입력 컴포넌트 후보 `ink-text-input@6.0.0`도 검토했으나 배포 소스는 UTF-16 인덱스 기반 삭제/커서 이동과 일반 입력 추가를 사용한다. 요구되는 grapheme 삭제·폭·마우스 잡음 차단을 그대로 보장하지 못하므로 기본 의존성에 넣지 않는다. 복잡한 에디터 대신 아래의 단일행 제한 입력만 작은 모듈로 구현한다.
- `Intl.Segmenter`로 grapheme 경계를, `string-width`로 터미널 셀 너비를 측정한다. UTF-16 length를 글자 수/너비로 사용하지 않는다. 직접 ANSI 너비 라이브러리나 범용 터미널 에뮬레이터는 작성하지 않는다.
- npm lock(`package-lock.json`)을 정식 잠금으로 둔다. Bun 설치 검증은 같은 패키지와 tarball 대상으로 별도 소비자 폴더에서 수행하며, 이번 계획은 Bun의 미검증 최소 버전을 호환 하한으로 선언하지 않는다. 향후 증거에는 Node/npm/Bun/터미널의 실제 버전을 기록한다.

## In scope / out of scope

**포함**: 닉네임 최초 진입/자동 복구, 고정 다크 대시보드, 로비와 예시 사용자 방문, 소개·상태·ASCII·개인 테마 편집, RoofTop 로컬 채팅, 예시 터미널별 로컬 방명록, 키보드와 마우스, 저장 실패 안내/비파괴 정책, npm/Bun 설치와 실행 아티팩트.

**제외**: SSH/인증/회원가입/네트워크/서버/실제 접속 상태/자동 답장/원격 방명록 전달, 지도/캐릭터/확대축소, Cafe 게시판/Focus Room 타이머, 레이아웃·ASCII 직접 편집기, 협업/tmux/일정/코드/GitHub 연동, CRT 효과, Linux/Windows 호환 보장, Bun-native 보장, 레지스트리 게시, 사용자 자료 정리. 앱 동작 중 fetch/socket/telemetry를 추가하지 않는다. 패키지 매니저의 의존성 다운로드는 앱의 원격 커뮤니티 동작과 별개다.

## File-level changes

현재 제품 소스가 없으므로 아래만 새 제품 변경 대상으로 한다. 경로 목록은 구현 경계이며 파일마다 같은 역할의 병렬 계층을 추가하지 않는다. 아래 T ID는 리뷰/테스트에서 안정적으로 참조한다.

| ID | 파일 대상 | 책임 |
|---|---|---|
| T01 | `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore` | 정확한 버전·ESM·빌드/패키지/bin 계약. ignore는 생성물/node_modules만, 사용자 자료는 손대지 않음 |
| T02 | `src/cli.tsx` | Node shebang, `--help`/`--version`/`--no-mouse`, TTY 검사, 저장소 시작/종료, Ink render/unmount. `--help`/`--version`은 저장 경로/잠금을 생성하지 않음 |
| T03 | `src/model.ts` | schema v1 타입/엄격한 런타임 검증, 안정 ID/검증 한도, 메시지 생성. 불필요한 validator 라이브러리 없음 |
| T04 | `src/catalog.ts` | 정확한 예시 사용자·seed 메시지·ASCII·테마 상수. 실행마다 재생성하는 랜덤 예시 없음 |
| T05 | `src/storage.ts` | 데이터 경로, 크기 검사, 잠금, load/commit/close, 원자적 쓰기/불확실 결과 처리 |
| T06 | `src/App.tsx` | reducer와 저장 명령 연결. committed 상태/초안/오류/포커스/선택/scroll을 분리. 성공 응답만 committed 상태에 적용 |
| T07 | `src/ui/Shell.tsx` | 프레임·목록·하단 도움말·리사이즈/최소 크기·공용 팔레트 |
| T08 | `src/ui/Views.tsx` | Lobby/RoofTop/PersonalTerminal 세 소형 뷰와 대상별 기록. 개인 테마 경계 |
| T09 | `src/ui/Input.tsx` | 단일행 grapheme 입력·가로 viewport·폼·취소/저장/전송. 전역 키를 텍스트로 넣지 않음 |
| T10 | `src/ui/mouse.tsx` | 실제 DOM ref 클릭·휠 어댑터, 좌표/이중 이벤트 방어, 입력 공존과 cleanup. 필요한 조정은 이 경계에 제한 |
| T11 | `tests/model.test.ts`, `tests/storage.test.ts`, `tests/app.test.tsx` | Unicode·불변식·장애·포커스·테마·대상 격리·confirmed write 계약 |
| T12 | `tests/package.test.mjs` | tarball 목록/bin/shebang/실행권한/소스 없이 실행과 격리된 소비자 설치 검사 |

`dist/`와 `.test-dist/`는 컴파일 생성물이다. root에 별도 계획 문서/README/작업 문서를 만들지 않는다. 런타임 설명은 `--help`, 화면 도움말, 오류 메시지에 포함하고 검증 증거는 승인된 GJC 워크플로 아티팩트로 남긴다. T12는 테스트용 임시 홈/설치 prefix/소비자 폴더만 사용하고 실제 사용자 데이터를 덮어쓰지 않는다.

### 데이터 스키마·경로 [T03–T05]

고정 기본 경로: `path.join(os.homedir(), 'Library', 'Application Support', 'Terminal World')`. 파일은 `state.json`, 잠금 디렉터리는 `state.lock/owner.json`, 동일 디렉터리 임시 파일은 `state.<operation-uuid>.tmp`이다. cwd·프로젝트·npx 캐시·패키지 설치 위치를 데이터 위치로 사용하지 않는다. 디렉터리 mode 0700, 새 상태/임시/owner 파일 mode 0600. 테스트는 저장소 생성 함수에 임시 경로를 주입하며 제품 설정 옵션으로 확장하지 않는다.

```ts
// JSON에 저장하는 구조. 모든 날짜는 UTC ISO 8601, UI는 기기 로컬 시각으로 표시.
type StateV1 = {
  schemaVersion: 1;
  revision: number; // 초기 1, 성공한 commit마다 +1
  profile: {
    id: 'user:local'; nickname: string;
    introduction: string; status: string;
    asciiPresetId: 'ascii:cat' | 'ascii:mountain' | 'ascii:plant' | 'ascii:planet';
    themeId: 'theme:slate' | 'theme:violet' | 'theme:teal';
    createdAt: string; updatedAt: string;
  };
  chatMessages: Array<{
    id: string; // crypto.randomUUID(), 재시도에서는 같은 ID
    origin: 'local'; authorId: 'user:local'; roomId: 'space:rooftop';
    text: string; createdAt: string;
  }>;
  guestbookEntries: Array<{
    id: string; origin: 'local'; authorId: 'user:local';
    targetTerminalId: 'terminal:example:mina' | 'terminal:example:jun' | 'terminal:example:sol';
    text: string; createdAt: string;
  }>;
};
```

예시는 catalog에만 있으며 state.json에 복제하거나 사용자의 기록과 섞어 seed하지 않는다. profile이 없는 정상 최초 실행은 **파일이 아예 없을 때만**이다. JSON null/누락 profile/다른 버전/모르는 ID는 최초 실행으로 간주하지 않고 오류다. 엄격한 필드·enum·날짜·고유 ID·작성자·대상·revision·길이 검증을 수행한다. 이전 버전 호환/자동 마이그레이션은 만들지 않는다.

저장 파일 최대 16 MiB, 채팅 최대 10,000개, 방명록 전체 최대 10,000개로 고정한다. 한도 도달 시 새 추가를 거절하고 이유를 표시한다. 자동 삭제/rolling history는 없다. 기록 정렬은 배열 삽입 순서이며 시계 역행으로 순서가 바뀌지 않는다. profile 작성자 이름을 로컬 기록에 사용하고 닉네임 변경 UI는 없다.

### 안정 ID·정확한 초기 콘텐츠 [T04]

- 공간: `space:lobby` → 로비, `space:rooftop` → RoofTop.
- 본인: `user:local`, `terminal:local`. 최초 프로필 기본값: 소개 `나만의 작은 터미널입니다.`, 상태 `둘러보는 중`, `ascii:cat`, `theme:slate`.
- 예시 사용자 **3명**, 로비와 사이드바 모두 `예시 사용자 · 실제 접속 아님` 표시:

| 사용자/터미널 ID | 닉네임 | 소개 / 상태 | ASCII / 테마 |
|---|---|---|---|
| `example:mina` / `terminal:example:mina` | Mina | 작은 화면에 취향을 모읍니다. / 별을 보는 중 | `ascii:cat` / `theme:violet` |
| `example:jun` / `terminal:example:jun` | Jun | 천천히 한 줄씩 만듭니다. / 산책 생각 중 | `ascii:mountain` / `theme:slate` |
| `example:sol` / `terminal:example:sol` | Sol | 초록빛 작은 공간입니다. / 쉬어 가세요 | `ascii:plant` / `theme:teal` |

- RoofTop 예시 메시지 **2개**: `seed:rooftop:welcome`, 작성자 `example:mina`, 본문 `RoofTop에 오신 것을 환영해요.`; `seed:rooftop:local-only`, 작성자 `example:jun`, 본문 `이곳의 새 메시지는 내 기기에만 저장돼요.`. 둘 다 `origin:example`, 시각은 `예시`로 표시한다. 실행할 때 현재 시각을 붙이지 않으며 자동 응답하지 않는다.
- 초기 방명록 **0개**. 내 터미널에서는 내 프로필만 편집하고, 예시 터미널에서만 방명록 작성 버튼을 제공한다. 예시 프로필/테마는 읽기 전용이다.
- ASCII 프리셋 **4개**, 아래 코드 블록의 줄 그대로 사용한다. 최대 폭 11셀, 최대 높이 3줄. 직접 입력·붙여넣기·파일 업로드 없음.

`ascii:cat` — 고양이
```text
 /\_/\
( o.o )
 > ^ <
```
`ascii:mountain` — 산
```text
    /\
 /\/  \/\
/        \
```
`ascii:plant` — 새싹
```text
  \ | /
   \|/
  [___]
```
`ascii:planet` — 행성
```text
   .---.
--(  o  )--
   '---'
```

### 팔레트·테마·레이아웃 [T07–T08]

공용 팔레트: 배경 `#0F172A`, 패널 `#111827`, 본문 `#E5E7EB`, 보조 `#94A3B8`, 경계 `#334155`, 선택 배경 `#1E293B`, 포인트 `#38BDF8`, 성공 `#34D399`, 오류 `#F87171`. 색상만으로 상태를 구분하지 않고 `선택`, `저장 중`, `실패`, `예시`, `로컬` 문구/커서를 병행한다.

개인 테마 **3개**, 토큰 순서 `배경/본문/보조/포인트/경계`:
- `theme:slate`: `#111827 / #E5E7EB / #94A3B8 / #38BDF8 / #334155`.
- `theme:violet`: `#1E1B2E / #EDE9FE / #B8AED6 / #C4B5FD / #4C4067`.
- `theme:teal`: `#102A2A / #D9F3EE / #93BBB3 / #5EEAD4 / #28534E`.

테마 provider를 App/root에 두지 않는다. 방문 중인 `PersonalTerminal`의 오른쪽 콘텐츠 상자 안에만 해당 소유자의 토큰을 전달한다. 사이드바·상단 제목/전역 상태·하단 도움말·로비·RoofTop은 언제나 공용 팔레트다. 편집 중 미리보기 역시 내 개인 콘텐츠 안에서만 이루어지며 Esc는 committed 테마로 복원한다.

- 권장 **100×30**, 지원 최소 **80×24** 셀. 전체 높이는 현재 TTY rows를 넘지 않는다.
- 상단 2줄(앱/현재 경로 및 `로컬 프로토타입 · 원격 전달 없음`), 하단 2줄(포커스별 키 설명/저장 상태), 가운데 `rows-4`줄. 가운데는 왼쪽 **24셀**(경계 포함), 간격 **1셀**, 오른쪽 `columns-25`셀(경계 포함). 각 패널 내부 좌우 패딩 1셀, 오른쪽 최소 내부 폭 51셀.
- 왼쪽 순서 6항목: 로비, RoofTop, 내 터미널, Mina, Jun, Sol. 선택 커서와 현재 열린 항목을 구분한다. 오른쪽은 고정 헤더, 스크롤 가능한 본문, 필요한 경우 composer/행동줄로 나눈다. 메시지는 한글 셀 폭을 기준으로 줄바꿈, ASCII는 원문 줄 유지. 임의의 자식 패널/레이아웃 편집은 없음.
- 최소보다 작아지면 안전 안내 화면 `80×24 이상으로 늘려 주세요`와 현재 크기/종료키만 보여주고 클릭·전송·일반 입력을 중지한다. committed 상태·초안·포커스·선택은 보존하고 크기 회복 후 복원한다. pending 쓰기 자체는 중단하지 않는다. 리사이즈마다 줄바꿈·viewport·scroll offset·hit region을 다시 계산하고 offset을 범위 안으로 clamp한다.
- 내용이 긴 프로필·메시지는 본문 viewport에서 스크롤한다. 입력은 가로 viewport로 caret을 보이게 유지한다. 넓은 문자를 반으로 자르지 않는다. 모든 행을 무제한 렌더해서 터미널 scrollback에 흘리지 않는다.

### 키보드·마우스·입력 계약 [T06, T09–T10]

포커스는 하나만 활성화한다: `sidebar`, `content`, `form:<field-or-button>`, `composer:<target>`. 화면에는 포커스 이름과 현재 가능한 키를 항상 표시한다.

| 상황 | 키보드 | 마우스 |
|---|---|---|
| sidebar | ↑↓ 선택 커서, Enter 열기, Tab content, Shift+Tab 역방향 | 행 클릭으로 선택+열기+sidebar 포커스. 휠은 커서만 상하 이동, 자동 열기 없음 |
| content 탐색 | ↑↓ 행동/로비 사용자 이동, Enter 실행, PgUp/PgDn 본문 한 viewport-1줄 스크롤, Home/End 처음/끝, Tab sidebar | 로비 사용자 클릭 방문, 버튼 클릭 실행, 본문 클릭 content 포커스, 본문 휠 3줄 이동 |
| 내 터미널 편집 | 편집 버튼 Enter → 소개/상태/ASCII/테마/저장/취소 순환, Tab/Shift+Tab 필드 이동, preset 필드 ↑↓ 선택, 저장 버튼 Enter 또는 Ctrl+S 전체 폼 저장 | 필드·프리셋·테마·저장·취소 클릭. preset 클릭은 한 번만 변경 |
| 텍스트 필드 | 일반 문자 그대로, ←→ grapheme 이동, Home/End 행 처음/끝, Backspace 앞 grapheme 삭제, Delete 뒤 grapheme 삭제 | 입력 상자 클릭은 입력 포커스만. 좌표 caret 배치/드래그 선택은 제외 |
| RoofTop/예시 방명록 | 작성 버튼 Enter로 composer, 텍스트 중 Enter 전송, Esc 미전송 작성 취소, Tab 전송/취소 버튼 이동 | 작성/전송/취소 클릭. 휠은 기록만 스크롤하고 입력/전송하지 않음 |
| 처음 닉네임 | 텍스트 입력, Enter 또는 입장 버튼 저장 후 진입, Esc 종료 | 입력/입장/취소 클릭 |

- Tab은 sidebar/content 전환이 기본이며 폼/작성기 안에서는 그 폼의 필드와 버튼만 순환한다. Esc로 편집/작성기를 닫으면 이전 content 행동에 포커스 복원한다. content의 Esc는 로비로 돌아가고 로비의 Esc는 sidebar 포커스만 옮긴다. sidebar의 Esc는 로비를 연다.
- 편집 중 소개/상태의 Enter는 다음 필드로 이동하고 전송하지 않는다. 단일행 작성기의 Enter만 전송한다. 채팅/방명록에서 Ctrl+S는 보내지 않고 Enter 안내를 표시한다. 방향키는 입력 필드에 포커스가 있으면 sidebar를 움직이지 않는다. 일반 `q`, `e`, 숫자 등 문자를 전역 단축키로 소비하지 않는다.
- dirty 편집/작성기에서 sidebar나 다른 사용자를 클릭해도 즉시 이동·저장하지 않는다. 현재 입력을 보존하고 `먼저 저장/전송하거나 Esc로 취소하세요` 표시. Tab으로도 폼 밖으로 나가지 않는다. Esc의 명시적 취소만 해당 초안을 폐기한다. 리사이즈·포커스 이동·실패는 초안을 폐기하지 않는다.
- Ctrl+C는 모든 상태에서 종료. dirty 초안은 미저장이라는 안내 후 종료하고 원래 데이터는 유지한다. 쓰기 진행 중에는 새 키/클릭을 무시하고 종료 요청을 큐에 기록하여 결과를 확인하고 cleanup 후 종료한다. SIGTERM도 정상 cleanup 경로를 사용한다. 강제 종료/SIGKILL에서 cleanup을 보장하지 않는다.
- 저장/전송은 단일 pending만 허용한다. pending 중 버튼/Enter 연타로 중복 항목을 만들지 않는다. committed 리스트에는 **저장 promise 성공 뒤에만** 한 건 추가하고 작성기를 비운다. 실패 시 리스트/프로필은 유지하고 초안/operation UUID를 보존해 같은 버튼으로 재시도한다. 성공 표시: `로컬 저장 완료 · 원격 전달 없음`.
- 마우스는 `MouseProvider`와 실제 Ink DOM ref별 `useOnClick/useOnWheel`을 쓴다. 겹치는 부모/자식 handler를 피하고 같은 물리 클릭당 한 동작만 적용한다. 초기에는 `cacheInvalidationMs=0`으로 레이아웃마다 현재 bounds를 사용한다. 화면 밖/잘린 행은 handler를 등록하지 않는다. 오른쪽/아래 경계와 인접 항목 double hit를 첫 probe에서 검사하고 필요하면 T10에서 반열린 경계 판정을 보강한다.
- 입력 소유권을 T09/T10에서 집중 관리한다. 마우스 escape packet은 텍스트·커서 이동·전송 이벤트로 흘러들지 않도록 **실측으로 검증**한다. 단순히 완성된 문자열에서 ESC만 지우는 방식은 조각난 패킷/숫자 잡음을 막지 못하므로 금지한다. 라이브러리의 입력 공존 방식부터 확인하고 불충분하면 작은 스트림 경계 어댑터로 한 번만 분류하며 일반 Unicode/방향키/붙여넣기를 보존한다. 범용 자체 마우스 프로토콜 스택은 만들지 않는다.
- 제품 옵션 `--no-mouse`는 사용자의 명시적 수동 비활성화이며 마우스 요구사항 삭제가 아니다. TTY 유무는 검사할 수 있지만 TERM명/`isSupported`/`isTracking` 같은 휴리스틱을 ‘실제 클릭 지원 자동 감지’로 표시하지 않는다. 화면은 `마우스 사용 설정됨`까지만 말하고 사용자에게 조작 확인과 키보드 대안을 안내한다.

검증/정규화 한도(글자 수=grapheme, 저장 직전 NFC):

| 값 | 한도/규칙 |
|---|---|
| 닉네임 | trim 후 1–16글자, 표시 폭 최대 24셀. 예시 닉네임과 겹쳐도 ID/본인·예시 라벨로 구분 |
| 소개 | 0–160글자, 단일행 입력 후 본문 자동 줄바꿈. 빈 값 허용 |
| 상태 | 0–40글자, 단일행. 빈 값 허용 |
| 채팅 | trim 후 1–400글자, 단일행 작성/본문 줄바꿈 |
| 방명록 | trim 후 1–200글자, 단일행 작성/본문 줄바꿈 |

IME/붙여넣기 한글, 결합문자, emoji ZWJ를 grapheme 단위로 처리한다. C0/C1, ESC/ANSI, DEL, 줄바꿈/CR/Tab, Unicode line/paragraph separator와 bidi 제어는 텍스트 데이터에 허용하지 않는다. 키 이벤트의 Tab/Esc/Ctrl+C 등과 텍스트 검증을 구분한다. 제어문자 포함 붙여넣기나 길이 초과 삽입은 삽입 전체를 거절하고 기존 초안을 유지한다. 조용히 잘라 저장하지 않는다. 저장 시 다시 검증하고 이유를 필드 가까이 표시한다. preset/theme은 지정 enum 외 값 불가다.

### 저장·오류·동시성 정책 [T05–T06]

1. 저장 디렉터리 확인 → 원자적 `mkdir(state.lock)` → owner에 pid/시작 ISO/무작위 소유 토큰 기록 → 파일 읽기·검증 순서. lock owner 기록 실패도 사용자 파일은 건드리지 않고 본인이 만든 잠금만 정리한다. 활성 앱은 하나다.
2. 두 번째 프로세스는 잠금 충돌 시 데이터를 수정하지 않고 경로와 ‘다른 실행 또는 이전 비정상 종료 잠금’ 오류를 출력한다. PID만 보고 잠금을 자동 삭제하지 않는다(PID 재사용/동시 시작 방지). 정상 종료 시 소유 토큰을 대조해 본인 잠금만 해제한다.
3. 비정상 종료 후 잠금 복구 안내: 모든 Terminal World 실행이 종료됐는지 사용자가 확인한 뒤 lock 디렉터리를 별도 이름으로 옮기고 재실행한다. 앱은 자동 회수/삭제/steal하지 않는다. state.json·남은 tmp는 지우지 않는다. 실제 경로와 owner 정보를 오류에 제공한다.
4. 각 변경은 현재 committed revision에서 candidate를 만들고 메모리 단일 큐로 직렬화한다. 쓰기 전 디스크 revision을 비교해 예상 밖 외부 변경이면 충돌로 중단한다. 수동 파일 편집과 앱 동시 실행은 지원하지 않으며 잠금 무시 도구까지 안전하게 병합한다고 주장하지 않는다.
5. schema 검증 → 크기/개수 검사 → 동일 디렉터리에 `wx` 임시 파일 생성 → 전체 쓰기 → file sync/close → 원자 rename(state.json) → 부모 디렉터리 sync → 성공 응답. 그 뒤에만 App의 committed 상태/성공 문구/기록 리스트를 갱신한다. 최초 닉네임도 이 성공 이후 입장한다. cwd가 아닌 macOS 로컬 파일시스템 기준으로 검증한다.
6. rename 이전 실패는 기존 state.json 불변. 본인이 만든 실패 tmp만 정리할 수 있고 기존 사용자 tmp는 자동 제거하지 않는다. ENOSPC/EACCES/I/O 오류는 경로와 이유를 보여주고 초안/기존 committed 값을 보존한다. 성공을 가장하는 메모리 전용 fallback은 없다.
7. rename 이후 디렉터리 sync 등에서 실패하면 ‘저장 결과 불확실, 디스크에 반영됐을 수 있음’ 표시. 성공으로 렌더하지 않고 추가 mutation을 중지한다. 동일 candidate/UUID와 파일을 다시 읽어 비교하고 sync까지 재확인한 경우만 성공 처리한다. 일치하지 않거나 읽기 실패면 원본을 덮어쓰지 않고 종료/수동 복구 안내. UUID를 새로 발급해 같은 글을 중복 전송하지 않는다.
8. JSON 손상/스키마 불일치/16 MiB 초과/지원하지 않는 버전/알 수 없는 예시 대상은 파일을 보존하고 오류 화면으로 중단한다. 빈 신규 계정이나 예시 데이터로 조용히 대체하지 않는다. 자동 reset·마이그레이션·부분 salvage·백업 덮어쓰기는 없음. 안내는 앱 종료 후 해당 파일의 복사본을 확보하고 유효한 사용자 사본을 복원하라는 명시적 절차다.
9. Ctrl+C/정상 종료는 pending 처리 완료 후 unmount, raw mode·커서·마우스 tracking 복원, 잠금 해제를 시도한다. 예외도 cleanup 경로를 거친다. cleanup 실패는 경로와 경고를 남기며 state.json을 삭제하지 않는다. 강제 종료 시 atomic 저장 전/후 중 유효한 전체 상태를 유지하는지 장애 테스트로 확인한다.

## Sequencing and dependencies

모든 단계는 **별도 실행 승인 후** 시작한다. 각 단계는 돌아가는 수직 슬라이스를 유지하고 선행 완료 없이 여러 미완성 프레임워크를 쌓지 않는다.

| 단계 | 결과/대상 | 의존성/완료 판단 |
|---|---|---|
| M0 실제 TTY go/no-go | T01/T02/T07/T09/T10의 최소 실행 껍질: 2개 목록·스크롤·한글 입력·mouse provider·resize·cleanup, 사전 컴파일 JS | 맨 먼저 수행. macOS 실제 TTY에서 아래 G1/G2 기록. 영구 실험 앱/별도 아키텍처를 남기지 않고 같은 제품 껍질에 통합. 마우스 제거의 선결 결론을 내리지 않음 |
| M1 내 공간 수직 슬라이스 | T03–T09: 최초 닉네임 저장→내 터미널→소개/상태/4 ASCII/3 테마 편집→종료/복구 | M0 통합 가능성 확보. 저장 오류/취소/한글/개인 테마 경계까지 작동. AC1/AC3/AC7 일부 |
| M2 월드 탐색 완결 | catalog 3명, 로비·6항목 sidebar·방문 테마·small screen/resize·모든 키보드/마우스 동작 | M1, 예시/로컬 라벨과 UI 상태 확정. AC2/AC3/AC6 |
| M3 로컬 참여 완결 | RoofTop 2 seed+직접 채팅, 3대상 방명록, 성공 후 반영·실패 초안·대상 격리·재시작 | M1 저장 계약+M2 대상 탐색. AC4/AC5/AC7. 어떤 자동 응답/네트워크도 추가하지 않음 |
| M4 아티팩트/수용 증거 | T11/T12와 전체 시연, pack tarball을 격리 소비자에서 npm/Bun local/global/npx/bunx 실행 | M3 전체 동작. AC1–AC8 증거 및 미검증 항목 표시. publish 없음 |

테스트는 마지막에만 작성하지 않는다. 각 M 단계에서 해당 T11의 단위/통합 증거를 추가하고 마지막 M4는 패키지 경로와 통합 시나리오를 확인한다. 이 문서 작성 중에는 위 어느 단계도 실행하지 않았다.

## Acceptance criteria

기존 AC1–AC8을 축소하지 않고 다음 관찰 조건으로 검증한다.

| AC | 안정 대상 | 통과 조건/테스트 연결 |
|---|---|---|
| **AC1 진입** | T02/T03/T05/T06/T09 | 빈 임시 홈에서 닉네임 필수·한도 오류→유효 이름 저장 성공 후 입장. 실패면 입장/프로필 생성 성공 표시 없음. 재시작 시 재질문 없이 같은 이름으로 터미널/내 글 표시. V1/V2/V4/V6 |
| **AC2 탐색** | T04/T06/T07/T08/T10 | 6항목에서 Enter/클릭으로 로비·RoofTop·내 터미널·3명 방문. 제목/열린 ID/본문이 일치하고 예시 라벨 존재. V3/V4 |
| **AC3 꾸미기** | T04/T06/T08/T09 | 소개/상태/4프리셋/3테마 저장·취소·재시작 확인. Mina/Jun/Sol 고유 테마 표시. 내 테마 변경 전후 공용/좌측 토큰 동일. V1/V3/V4 |
| **AC4 공용 공간** | T04/T05/T06/T08/T09 | 로비 사용자 방문, RoofTop 2개 예시 구분, 내 글은 nickname+로컬 표기와 함께 confirmed write 뒤 정확히 한 번 추가. 실패/연타/재시도/재시작에서도 중복 없음. 원격 상태/답장 없음. V2/V3/V4 |
| **AC5 방명록** | T03/T05/T06/T08 | Mina에 쓴 글은 Mina에만, Jun/Sol과 섞이지 않음. 세 대상 각각 작성/복구 검사. 내/예시 프로필 편집 권한 구분. 로컬 저장·원격 미전달 명시. V1/V2/V3/V4 |
| **AC6 조작** | T02/T07/T09/T10 | 기본키/입력/폼/save/cancel/send, 클릭·휠·resize·Ctrl+C/cleanup 실제 TTY 검증. 입력 중 글자 도난/마우스 packet 잡음/중복 액션 0. 최소 크기 복구 시 초안 보존. V3/V4 및 G1/G2 |
| **AC7 재실행** | T03/T05/T06 | 프로필 5필드·직접 채팅·세 대상 방명록 저장→정상 종료→재실행 결과 동일. 예시 seed 중복/재생성 없음. 손상/권한/동시 실행은 데이터 비파괴. V2/V4/V6 |
| **AC8 범위 준수** | T01–T12 | Non-Goals 코드/의존성/표시가 없으며 no-mouse 또는 Bun-native 미검증을 전체 호환/원격 기능으로 과장하지 않음. 아티팩트에 사용자 자료/로컬 데이터 없음. V5/V6 |

AC6의 마우스는 단순 난점이나 단일 TTY 미지원만으로 ‘키보드 대체로 완료’ 처리할 수 없다. 실행 승인 후 G1의 객관적 증거와 architect 검토로 수정 가능한 통합 문제 및 단일 TTY 미지원을 배제하고 진정한 불가능성이 확인된 경우에는 사용자가 이미 부여한 조건부 허용을 적용한다. 두 번째 사용자 승인은 요구하지 않는다. 그때 정확한 이유와 증거, 키보드 전용으로 조정한 AC6 및 마우스 제외 범위를 기록하고 한계를 보고한다. 조정된 AC6는 모든 탐색·편집·스크롤·저장·취소·전송의 키보드 등가 조작과 입력·resize·Ctrl+C/cleanup 검증을 유지한다. 현재는 제거 조건을 충족하는 증거가 없어 위 AC6의 마우스 포함 범위를 유지한다.

## Verification

### 현재 확보한 근거와 한계

- 정확한 명세의 목표/Constraints/Non-Goals/AC1–AC8/Planning Decisions/Handoff를 읽었다. root 제품 파일 부재와 미추적 사용자 자료는 read-only 탐색/git status로 확인했다.
- 아래 공개 자료는 메타데이터/소스 검토 근거이며 **설치/컴파일/실행 증거가 아니다**. macOS+Ink8+mouse, Bun 설치 실행, 한글 IME는 아직 검증하지 않았다.
- [Ink 8.0.0 버전 메타데이터](https://registry.npmjs.org/ink/8.0.0), [React 19.3.0](https://registry.npmjs.org/react/19.3.0), [mouse 2.1.0 메타데이터](https://registry.npmjs.org/@ink-tools%2fink-mouse/2.1.0), [배포 mouse JS](https://unpkg.com/@ink-tools/ink-mouse@2.1.0/dist/index.js), [배포 타입](https://unpkg.com/@ink-tools/ink-mouse@2.1.0/dist/index.d.ts), [README의 오래된 peer 문구](https://raw.githubusercontent.com/neiromaster/ink-tools/main/packages/ink-mouse/README.md).
- [string-width 8.3.0](https://registry.npmjs.org/string-width/8.3.0), [TypeScript 5.9.3](https://registry.npmjs.org/typescript/5.9.3), [React types 19.3.0](https://registry.npmjs.org/@types%2freact/19.3.0), [Node types 22.18.6](https://registry.npmjs.org/@types%2fnode/22.18.6), [검토 후 기본 제외한 text-input 소스](https://unpkg.com/ink-text-input@6.0.0/build/index.js).
- [Bun bunx 공식 shebang 설명](https://bun.sh/docs/pm/bunx), [npm exec](https://docs.npmjs.com/cli/v11/commands/npm-exec/), [npm pack](https://docs.npmjs.com/cli/v11/commands/npm-pack/).

## Escalation/Risk Gate

아래는 **미래 구현의 판단표**다. 이번 계획 단계에서는 모든 게이트/러너/포매터를 건너뛰었으며 통과 주장도 하지 않는다.

| Gate | 시행 시점/객관적 증거 | 실패 시 정책 |
|---|---|---|
| G0 승인 | 제품 실행의 명시적 사용자 승인 | 승인 전 설치·probe·테스트·소스 작성 금지 |
| **G1 마우스 통합 go/no-go** | M0의 실제 macOS TTY에서 최소 20회 목록/버튼 클릭이 정확히 1동작씩, 경계/여백 오클릭 0, 스크롤 20회 방향·한도 정확, 입력 focus 후 한글/ASCII 타이핑 중 클릭·휠 잡음/전송 0, 100×30↔80×24↔70×20↔100×30 왕복 5회 후 재계산 즉시 정확, 종료/예외 후 커서·raw/mouse 상태 복구. TTY/버전/화면·이벤트 기록을 워크플로 아티팩트로 남김 | 먼저 현재 Orca와 macOS의 다른 mouse-reporting TTY(예: Terminal.app)를 비교하고 ref/layout/cache/input/프로토콜 문제를 분리·수정. 특정 터미널 미지원 또는 수정 가능한 결함을 ‘보편적으로 불가능’이라 부르지 않음. 작은 어댑터/설정 수정으로 해결되면 유지. 수정 가능한 통합 문제 및 단일 TTY 미지원을 배제하고 지원 가능한 조합에서도 불가능함을 재현·근거화한 뒤 architect 검토로 확인된 경우에만, 사용자가 이미 부여한 조건부 허용에 따라 마우스를 제거한다. 재승인은 요청하지 않는다. 정확한 이유·증거와 키보드 전용으로 조정한 AC6/범위를 기록하고 한계를 보고한다. 현재는 제거를 정당화하는 증거가 없으므로 마우스를 유지 |
| **G2 Unicode/포커스** | M0/M1 실제 IME+붙여넣기와 단위 테스트: 한글/결합/ZWJ 삭제·caret·가로 viewport, Tab/Enter/Esc, 최소 크기 전환 후 초안 유지 | 입력 모듈의 좁은 결함 수정. 키보드 전용으로 mouse 성공을 가장하거나 텍스트 손실을 허용하지 않음 |
| G3 저장 신뢰성 | M1/M3 저장 오류 주입, rename 전/후 실패, pending 중 종료, 두 프로세스 충돌, 손상 파일 hash 불변 | 잘못된 성공/중복/데이터 손실이면 진행 중단하고 T05 수정. 메모리 fallback/조용한 reset 금지 |
| G4 배포 | M4 동일 tarball의 npm/Bun local/global/npx/bunx 설치/실행, shebang/권한/Node dependency 확인 | Node shebang 경로와 Bun-native를 구분. Bun 매니저 경로 실패는 재현/수정 전 배포 완료 주장 금지. 게시하지 않음 |
| G5 최종 범위 | AC1–AC8 및 T01–T12 변경 목록/패키지 파일 리뷰 | 누락/확장은 수정. 사용자 자료 변경은 중단하고 소유자와 조정 |

‘불가능하면 마우스 삭제 가능’이라는 사용자 허용은 존재하지만 단순 구현 난점이나 Ink 코어 API 부재는 조건 충족이 아니다. 수동 `--no-mouse`와 모든 행동의 키보드 등가 조작은 항상 제공하고, 성공한 마우스 경로를 자동 지원 탐지인 것처럼 포장하지 않는다.

## Verification Plan

### 승인 후 테스트 묶음

| ID | 방법/구체 시나리오 | 연결 |
|---|---|---|
| V1 모델/Unicode | 닉네임 0/1/16/17 grapheme 및 24/25셀, 소개 160/161, 상태40/41, 채팅400/401, 방명록200/201, 공백·제어·ANSI·bidi·한글 NFC·결합·ZWJ·잘못된 enum/ID/date/중복ID 검사. 과도 입력을 거절해 이전 초안 유지 | AC1/3/5 |
| V2 저장 통합 | 임시 홈 roundtrip, 처음 파일 없음과 손상 구분, EACCES/ENOSPC/짧은 쓰기/rename 실패/sync 실패 주입, 잠금 동시성/소유 토큰/비정상 종료, max count·16 MiB, revision 충돌, 실패 원본 bytes 비교, uncertain 재시도 idempotency, 기존 tmp 보존 | AC1/4/5/7 |
| V3 UI/명령 통합 | Ink 가짜 입력/출력 스트림+reducer 테스트. deferred commit을 resolve하기 전 리스트0/초안유지→resolve 후1, reject 후0/초안유지, 연타/재시도 중복0. 6 routes, 대상별 방명록, theme scope, Tab/Esc/키 입력/스크롤 clamp, dirty navigation 차단, 소형 화면 복귀 | AC2/3/4/5/6 |
| V4 실제 TTY | G1/G2 체크와 전체 권장 시연: 새 닉네임→소개/상태/ASCII/테마 저장→세 예시 방문 및 테마 비교→세 대상별 서로 다른 방명록→RoofTop 입력→Ctrl+C→동일 홈 재실행→동일 내용. 취소/저장 실패·크기 변환 추가. 키보드-only와 mouse 모두 별도로 확인 | AC1–AC7 |
| V5 범위/패키지 정적 검사 | Non-Goals와 네트워크 API/의존성 부재, `예시`/`로컬` 라벨, 4/3/3/2 고정 catalog 수, root 테마 누출 없음, package 파일 allowlist 및 사용자 자료 미포함 | AC3/8 |
| V6 tarball 소비자 | 사전 컴파일 JS만 담긴 동일 tgz를 독립 prefix/홈·서로 다른 cwd에서 npm/Bun local/global 및 npx/bunx로 실행, runtime --help/version/no-TTY exit와 실제 TTY 진입/재시작. 소스/tsc/tsx 없이 설치 후 실행. Node22 메이저와 Node24 대조, 사용한 정확한 Node/npm/Bun 버전 기록 | AC1/7/8 및 D3 |

### 빌드/패키지/실행 계약 [T01–T02, T12]

- 패키지명 `terminal-world-prototype`, 버전 `0.1.0`, 실행명 **`terminal-world`**. registry 이름 사용 가능 여부나 게시 사실을 주장하지 않는다. 게시 승인 전 `private: true`로 두고 **pack/install/tarball 실행만** 검증한다.
- `type: module`, `bin: { "terminal-world": "dist/cli.js" }`, `files: ["dist"]`, `engines.node: ">=22"`. `tsconfig`는 strict/NodeNext/ES2022/react-jsx를 사용하고 내부 import에 빌드 후 `.js` 경로가 유효하도록 작성한다. npm 자체 package metadata 자동 포함 외 `src`, tests, workflow, PNG, 사용자 state가 tgz에 들어가면 실패다.
- `src/cli.tsx` 선두 `#!/usr/bin/env node`를 `dist/cli.js`에도 유지한다. 패키지 안 bin은 실행권한을 가지도록 빌드/pack 결과를 검증한다. npm bin shim만으로 원본 권한 문제를 덮지 않는다.
- `build`: `tsc -p tsconfig.json`. `prepack`: `npm run build`. 사용자 install 때 TS 컴파일하는 prepare/postinstall은 두지 않는다. 릴리스 아티팩트에 precompiled JS가 있어 설치 후 TS 실행기·컴파일러·네이티브 빌드 도구 없이 시작해야 한다. `--help`에 Node 필요와 Bun 도구/런타임 구분을 표시한다.
- stdin/stdout 실제 TTY가 아니면 인터랙티브 UI를 시작하지 않고 설명과 비정상 종료코드를 반환한다. `--help`/`--version`은 pipe에서도 동작한다. 앱 실행마다 네트워크 최신 버전 확인을 하지 않는다.
- `test`: tests 전용 tsconfig 없이 `tsc` CLI 옵션으로 `src`+tests를 `.test-dist`에 컴파일한 뒤 `node --test` 실행(정확한 파일/옵션은 T01 script에서 고정). `test:package`: `node tests/package.test.mjs`. `typecheck`는 향후 승인 범위에서만 `tsc --noEmit`. 린터/포매터 신규 도입은 계획하지 않는다.

아래 명령은 **승인 후 실행 예시이며 지금 실행하지 않았다**. `$TGZ`는 `npm pack --json`이 반환한 **절대 tarball 경로**, `$PREFIX`와 cwd는 테스트 전용 디렉터리다. 전역 설치는 시스템 전역이 아닌 독립 prefix/global-dir+bin-dir로 격리한다. 각각 별도 테스트 홈을 사용한다.

1. 생산자: `npm ci`, `npm run build`, `npm test`, `npm run test:package`, `npm pack --json`. tgz 경로·파일 목록·sha256을 증거로 남기고 같은 tgz를 다음 모든 경로에 쓴다. `npm publish`는 실행하지 않는다.
2. npm 로컬 소비자: 빈 소비자 프로젝트에서 `npm install "$TGZ"`, `npm exec -- terminal-world`. 별도 cwd로 옮겨도 저장 위치가 홈 기준인지 확인한다.
3. npm 전역 소비자: `npm install --global --prefix "$PREFIX" "$TGZ"`, 이후 해당 `$PREFIX/bin/terminal-world` 실행. 실제 사용자 전역 패키지를 덮어쓰지 않는다.
4. npx 아티팩트 직접 실행: 빈 cwd에서 `npx --yes --package "$TGZ" terminal-world`. registry의 동명 패키지를 우연히 실행하지 않도록 tarball 명시와 빈 캐시를 사용한다.
5. Bun 로컬 소비자: 독립 프로젝트에서 `bun add "$TGZ"`, `bunx --no-install terminal-world`. 배포 bin이 Node shebang을 따라 실행되는지 확인한다.
6. Bun 전역 소비자: 테스트 전용 `BUN_INSTALL_GLOBAL_DIR`/`BUN_INSTALL_BIN`을 사용해 `bun add --global "$TGZ"`, 생성된 격리 bin 경로 실행. 설치된 Node로 shebang이 해석되는지 확인한다.
7. bunx 아티팩트 직접 실행: 빈 cwd/격리 캐시에서 `bunx --package "$TGZ" terminal-world`. 버전별 Bun이 tarball package spec을 처리하는지는 여기서 실제 확인한다. 실패하면 local-installed bin 테스트로 대신 통과 처리하지 않고 해당 호출/소비자 계약을 고쳐 같은 경로를 재검증한다.
8. Node 없는 소비자 환경: `--help`/진입이 Node 부재로 실패하는 이유를 확인한다. Bun이 설치됐다는 이유로 Node 불필요라고 안내하지 않는다. **일반 bunx는 Node shebang을 존중해 Node를 실행**하며, `bunx --bun ...`은 별도의 Bun-native 강제 실행이다. 후자는 탐색 검증을 하더라도 이번 필수 수용/호환 보장에 포함하지 않는다.

장래 게시가 별도 승인된다면 `npm install -g terminal-world-prototype`, `bun add -g terminal-world-prototype`, `npx --package terminal-world-prototype terminal-world`, `bunx --package terminal-world-prototype terminal-world`가 동일 bin 계약을 사용한다. 현 단계에서는 이 registry 호출을 실제 동작/게시 완료로 광고하지 않는다. tarball 검증으로 설치 구조를 증명하고 게시 절차 자체는 범위 밖으로 남긴다.

### 역할 인계

- 실행 승인 후 **executor**가 M0→M4 순서로 구현한다. 작은 저장소이므로 UI/저장 공통 파일을 여러 구현자에게 동시에 맡기지 않는다.
- **architect**는 G1 입력·마우스 공존과 G3 저장 실패/cleanup 계약을 읽기 전용으로 검토한다. **critic**은 이 계획의 T ID/AC 매핑과 범위 축소 여부를 검토한다. 지금 모든 게이트/리뷰 실행을 시작하는 것은 아니다.
- **autoresearch**는 G1에서 실제로 재현되는 좁은 통합 문제에 한해서 필요할 때 사용한다. 스택 재선택이나 장기 조사로 제품을 대체하지 않는다. **ultragoal** 자동 실행은 승인 전 사용하지 않고, 승인 후에도 명시된 M0–M4/AC1–AC8 범위만 대상으로 한다.

## Risks and mitigations

| 위험 | 영향 | 완화/남는 한계 |
|---|---|---|
| mouse 패키지의 Ink 내부 Yoga node 의존, 경계 포함 판정, 지원 추정 상태 | Ink8의 layout/입력 동작과 충돌 가능 | 배포 소스에서 내부 좌표 의존을 확인했으며 G1을 먼저 수행. ref 기반/비겹침/현재 bounds/명시적 T10 어댑터. 메타데이터만으로 성공 주장하지 않음 |
| mouse와 일반 입력의 스트림 경합 | escape 조각이 글이나 전송으로 오염 | M0에서 한글 입력 중 클릭·휠·resize 혼합. 불충분한 ESC 치환 대신 입력 경계 분류를 검증. 미해결이면 증거와 함께 중단 |
| CJK/emoji 폭·IME·terminal 특성 차이 | caret/줄바꿈/클릭 좌표 어긋남 | Segmenter+string-width, 실제 macOS IME와 resize 확인. 성공한 터미널/버전만 지원 증거로 기록 |
| JSON 전체 재기록·강제 종료·디스크 오류 | 저장 실패/불확실 상태 | 제한 크기·atomic rename+sync·confirmed response·단일 lock·동일 UUID 재시도·실패 초안 보존. 외부 편집/파일시스템 고장까지 완전 복구한다고 주장하지 않음 |
| 강제 종료 후 남는 lock | 재실행 차단 | PID 자동 탈취 없이 owner/경로와 수동 복구 안내. 데이터 삭제 없는 보수적 선택 |
| 손상 파일에 자동 fallback 유혹 | 사용자의 작성물이 사라진 것처럼 보임 | 최초 파일 부재만 초기화. 손상/새 버전은 비파괴 오류 및 사본 복구 안내 |
| 개인 테마의 전역 전파 | 사용자 확정 범위 위반 | PersonalTerminal만 토큰 수신, 공용 팔레트 불변 테스트 |
| Node/Bun 역할 혼동·네이티브 모듈 설치 | bunx 사용자 시작 실패/부정확한 지원 주장 | 순수 JS 저장과 사전 컴파일 JS, Node>=22 선언, 정확한 설치 도구/런타임 버전별 tarball 증거. Bun-native 요구는 추가하지 않음 |
| 패키지에 사용자 자료 혼입 | 프라이버시/저장소 훼손 | `files:[dist]`, pack 목록·정적 검사, isolated home/prefix, 실제 사용자 디렉터리 불변 |

완료 판정은 실제 승인 후의 AC1–AC8 증거와 tarball 소비자 결과로만 한다. 현재 산출물은 구현 가능한 계획이며 제품 완성·테스트 통과·실행 승인으로 해석하지 않는다.

## ADR

- **Decision**: 사용자 선택인 TypeScript + React + Ink를 전제로 작은 reducer/UI와 순수 JS JSON 스냅샷 저장(O1), 단일 작성자 잠금, 저장 성공 후 화면 반영을 채택한다. Node shebang을 가진 사전 컴파일 JS/bin을 npm/Bun/npx/bunx로 배포하고 마우스는 유지한다. 상태는 구현 승인 대기다.
- **Drivers**: D1 로컬 데이터 신뢰성, D2 macOS 실제 조작 품질, D3 네이티브 설치 마찰이 적은 실행 경로.
- **Alternatives considered**: 같은 Ink UI에 SQLite 저장(O2)은 트랜잭션/조회에 유리하나 이번 규모에서는 드라이버·런타임 검증 비용이 더 크다. `ink-text-input`은 검토한 배포 소스의 grapheme/입력 격리 한계 때문에 기본 의존성에서 제외한다. 언어 재선택은 대안에 포함하지 않는다.
- **Why chosen**: 한 계정·작은 로컬 프로필/기록에 가장 작은 완결 구조이며 테마·예시·사용자 저장 데이터 경계를 명시할 수 있다. 마우스 패키지의 공개 API/메타데이터는 후보 근거이되 실제 지원 증거는 아니므로 M0에서 먼저 검증한다.
- **Consequences**: JSON 전체 재기록·보수적 잠금 복구·엄격한 크기/스키마 검증을 부담한다. Node가 필요하고 일반 bunx 지원과 Bun-native 호환은 별개다. 개인 테마는 개인 콘텐츠에만 적용한다. 원격 동작·게시·자동 마이그레이션은 없다.
- **Follow-ups**: 실행 승인 후 M0–M4와 G1–G5/V1–V6에서 AC1–AC8 증거를 확보한다. 마우스의 진정한 불가능성이 객관적 증거와 architect 검토로 확인될 때만 기존 조건부 허용을 적용해 사유·키보드 전용 AC6/범위·한계를 기록하며 재승인은 요구하지 않는다. 현재는 그 조건을 충족하는 증거가 없다.
