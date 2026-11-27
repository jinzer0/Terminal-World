# Terminal-World 인터페이스 및 화면 설계 명세

- 작성일: 2026-11-28 (Asia/Seoul)
- 상태: **확정 (2단계 공통 구조 설계 산출물)**
- 기준 문서: [요구사항 분석 명세](requirements-analysis.md), [유스케이스·도메인 모델](analysis-models.md), [설계 결정 기록](design-decisions.md), [아키텍처 명세](architecture-spec.md)

> 본 문서는 SSH TUI(2.5D 아바타 자유 이동 맵 + 목록 탐색), 비대화형 업무 CLI, MCP 서버의 사용자 접점 규격을 정의한다. 세 인터페이스는 [아키텍처 명세](architecture-spec.md)의 동일한 공통 업무 서비스를 호출한다.

---

## 1. SSH TUI 화면 및 2.5D 아바타 자유 이동 맵 설계

### 1.1 지원 화면 크기 및 자동 폴백 (FR-06, NFR-06)

| 터미널 크기 | 동작 |
|---|---|
| **`120×30` 이상 (권장)** | **2.5D 아바타 자유 이동 맵**을 기본 탐색 뷰로 표시. 언제든 `m` 키로 **목록 탐색 뷰**와 상호 전환 |
| **`80×24` ~ `119×29` (최소)** | **목록 탐색 뷰**를 기본으로 표시(`m` 키로 축소 맵 뷰포트 전환 가능하되 필수 안내가 겹치지 않도록 보장) |
| **`80×24` 미만** | 화면 확대 안내 오버레이 표시(작성 중인 초안 상태 유지, `Ctrl+C` 종료 가능) |

### 1.2 2.5D 아바타 자유 이동 맵 구조 (확정 결정 반영)

확대/축소 없이(`FR-06`) 고정 타일 크기에서 **카메라 뷰포트 패닝**을 지원하는 2.5D 아이소메트릭/입체감 타일 맵으로 구성한다.

```text
┌─────────────────── TERMINAL WORLD · 2.5D MAP (m: 목록 전환 · ?: 도움말) ───────────────────┐
│                                                                                            │
│    ╔═══════╗        ╔══════════╗        ╔══════════╗        ╔══════════╗        ╔════════╗ │
│    ║ LOBBY ║        ║  FOCUS   ║        ║   CAFE   ║        ║ ROOFTOP  ║        ║ LIVING ║ │
│    ║ (4명) ║        ║  (2명)   ║        ║ (7게시판)║        ║  (채팅)  ║        ║ (AFK)  ║ │
│    ╚═══╤═══╝        ╚════╤═════╝        ╚════╤═════╝        ╚════╤═════╝        ╚═══╤════╝ │
│       [문]              [문]                [문]                [문]               [문]    │
│  ······●·················●···················●···················●··················●····  │
│                                     @mina                                                  │
│                         ★ @you (14,7)                                                      │
│  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ 개인 터미널 구역 ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ │
│    ┌─────────┐      ┌─────────┐      ┌─────────┐      ┌─────────┐                         │
│    │ @mina   │      │ @jun    │      │ @sol    │      │ @you    │   (신규 가입 시 자동    │
│    │ [green] │      │ [dark]  │      │ [amber] │      │ [light] │    슬롯 확장·패닝)      │
│    └────┬────┘      └────┬────┘      └────┬────┘      └────┬────┘                         │
├────────────────────────────────────────────────────────────────────────────────────────────┤
│ 인접 공간: [CAFE] 7개 게시판 · 최근 글 12건 · Enter로 입장                                  │
│ 상태: 온라인(2) · 자리비움(1) · 게스트(1) │ 방향키 이동 · Enter 진입 · m 목록 · / 명령      │
└────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **좌표계 및 이동 규칙**:
  - 월드 맵은 정수 타일 격자 `(x, y)`로 구성되며, 상단 행에 **5개 공용 공간 건물**(Lobby, Focus Room, Cafe, RoofTop, Living Room)과 **오픈소스 이슈 탐색소(또는 Lobby/Cafe 진입 연계)**, 하단 구역에 **회원별 개인 터미널 슬롯(`grid_slot`)**이 격자로 자동 배치된다.
  - 회원이 많아져 화면 폭/높이를 넘으면 **플레이어 아바타(`★ @you`)를 중심으로 카메라 뷰포트가 부드럽게 패닝**한다(확대/축소 없음).
  - `↑` `↓` `←` `→` (또는 텍스트 입력 중이 아닐 때 `h/j/k/l`): 1타일 이동. 건물 벽·맵 경계는 충돌 처리.
  - 문 타일(`[문]`) 위에 서거나 공간 건물과 1타일 인접 시 하단 HUD에 **간략 정보**(공간명, 현재 인원/상태, 테마/한 줄 상태)가 표시되며 **`Enter`로 전체 화면 상세 진입**, **`Esc`로 맵(또는 목록)에 복귀**한다.
  - 다른 온라인 회원의 아바타(`@닉네임`)는 실시간 `RealtimeHub` 이벤트로 맵 상에 표시된다(Living Room에 있는 회원은 자리비움 배지 표시, 재접속 시작 위치는 Lobby 앞).
- **목록 탐색 뷰 (`m` 키 전환)**:
  - 공용 공간 5개 + 오픈소스 이슈 탐색 + 내 터미널 + 공개 개인 공간 목록 + 보관된 방명록(`탈퇴한 사용자의 공간`)을 `↑`/`↓` + `Enter`로 동일 권한·동일 진입 경로로 탐색한다.

### 1.3 전체 화면 IA (UC-01~UC-18 매핑)

| 화면 | 진입 경로 | 주요 기능 및 관련 UC |
|---|---|---|
| **진입 / 인증 게이트** | SSH 접속 직후 | 게스트 둘러보기 / 로그인 / 회원가입(자동 로그인 + 32자리 복구 코드 1회 표시 및 보관 확인) / 계정 복구 (`UC-01`, `UC-02`, `UC-11`) |
| **월드 맵 / 목록 탐색** | 진입 후 기본 | 2.5D 아바타 이동(`120×30+`) ↔ 목록(`m` 토글), 공간 진입 (`UC-03`) |
| **Lobby** | 공용 공간 | 현재 접속자(회원 목록·온라인/자리비움 + 게스트 인원수), 게시 중 공지 목록/본문, 관리자 공지 작성·수정·종료 (`UC-08`) |
| **Focus Room** | 공용 공간 | 집중 시작/중단(목표 시간 없음, `HH:MM:SS`), 현재 구간·당일 누적, 본인 상세 구간 이력, 공개 일별 랭킹(공동 순위) (`UC-09`) |
| **Cafe (7개 게시판)** | 공용 공간 | 게시판 선택(`자유`·`개발 질문`·`정보 공유`·`MCP`·`Skills`·`opensource`·`프로젝트/공모전 모집`), 글 목록/본문/작성/수정/삭제, 댓글, 신고 (`UC-06`, `UC-13`) |
| **모집 필터 & 북마크** | Cafe 모집 게시판 | 유형·역할·기술·참여 방식·모집 상태 필터, 마감, 관심 글 저장/해제, 내 저장 목록(비공개), 공개 연락처 안내 (`UC-18`) |
| **오픈소스 탐색** | 월드/목록/Cafe 연계 | 탭 분리: ① **기여 이슈 탐색**(중소규모·신생 우선, 언어/분야/키워드, 선정 근거·확인 시점, **AI 데모 설명** 및 원문 URL) / ② **공개 인기 저장소**(누적 스타 순위) (`UC-17`) |
| **RoofTop** | 공용 공간 | 로그인 회원 실시간 채팅 송수신(최근 100개, 14일 보관), 미확인 전송 재시도(중복 방지), 신고, 관리자 메시지 삭제 (`UC-07`, `UC-13`) |
| **Living Room** | 공용 공간 | 입장 시 해당 세션 자리 비움 전환, 통합 상태 표시, 다른 공간 이동 시 해제 (`UC-10`) |
| **개인 공간 (내 것 / 타인)** | 월드/목록 | 고정 레이아웃(ASCII 40×12 + 4테마 + 닉네임·소개·기술 스택·상태·HTTPS URL) + 방명록 조회/작성/수정/삭제. 본인 공간에서 편집·저장 전 미리보기 (`UC-04`, `UC-05`) |
| **보관 방명록** | 목록 탐색 하단 | `탈퇴한 사용자의 공간` 목록(새 작성 불가, 기존 작성자 수정/삭제·관리자 삭제만 허용) (`UC-05`) |
| **계정 · 보안 · 연동 관리** | 전역 단축키 `a` | 비밀번호 변경, 복구 코드 재발급(현재 비밀번호 확인), **CLI/MCP 6자리 승인 코드 입력·승인**, 내 연동 자격 목록 조회/회수, 내 신고 처리 결과 조회, 회원 탈퇴(비밀번호+안내+최종 확인) (`UC-02`, `UC-11`, `UC-12`, `UC-13`, `UC-15`, `UC-16`) |
| **관리자 패널** | 전역 단축키 `g` (관리자 전용) | 접수된 신고 검토(`삭제`/`조치 없음` + 사유), 전체 삭제 이력 조회(90일 보존, 권한 회수 시 즉시 차단) (`UC-13`, `UC-14`) |

### 1.4 공통 TUI 입력기 및 테마 규격
- **테마 4종 (`FR-08`)**: 기존 `src/catalog.ts`의 3테마를 `dark`(기본) · `light` · `green` · `amber` 4종으로 교체하고 256색 호환 팔레트를 적용한다.
- **신규 공용 UI 컴포넌트**:
  - `MultilineInput`: 게시글 본문(10,000자), 자기소개(500자), 댓글/방명록/사유(1,000자), ASCII 아트 직접 입력(40열×12줄, 실시간 열×줄 카운터 표시) 지원.
  - `SecretInput`: 비밀번호·복구 코드 마스킹 입력(`*`), 붙여넣기 허용, 제어문자 차단.
  - `ConfirmDialog`: 회원 탈퇴·콘텐츠 삭제·자격 회수용 최종 확인 모달.
  - `PreviewPane`: 프로필·ASCII·4테마 저장 전 미리보기(공개 상태 미변경).

---

## 2. 비대화형 업무 CLI 규격 (FR-26, FR-28, UC-15)

### 2.1 실행 구조 및 입출력 규약

```text
terminal-world [전역 옵션] <resource> <action> [옵션]
```

- **전역 옵션**:
  - `--server <url>`: 서버 브릿지 주소 (기본 `http://127.0.0.1:4310`)
  - `--json`: 구조화된 JSON 출력 (`stdout`에는 순수 결과만, 진행/진단 메시지는 `stderr`로 분리)
  - `--cursor <token>` / `--limit <n>`: 목록 페이지 이어받기
  - `--idempotency-key <uuid>`: 쓰기 재시도 중복 방지 키
  - `--help` / `--version`
- **표준 JSON 응답 봉투(`--json`)**:
  ```json
  {
    "ok": true,
    "data": {},
    "meta": { "cursor": null, "hasMore": false, "checkedAt": "2026-11-28T01:25:00.000Z" }
  }
  ```
  실패 또는 미확인 전송 시:
  ```json
  {
    "ok": false,
    "error": {
      "code": "AUTH_REVOKED | INVALID_INPUT | FORBIDDEN | RATE_LIMITED | EXTERNAL_UNAVAILABLE | UNCERTAIN_DELIVERY",
      "field": "title",
      "message": "사람이 읽는 안내 메시지"
    }
  }
  ```
- **종료 코드(Exit Code)**:
  - `0`: 성공 (결과 없음 포함 — `data.items: []`와 오류를 명확히 구분)
  - `2`: 입력·인수 검증 오류 (`INVALID_INPUT`)
  - `3`: 인증 실패·만료·회수·권한 부족 (`AUTH_*`, `FORBIDDEN`)
  - `4`: 대상 없음·상태 충돌·한도 초과 (`NOT_FOUND`, `CONFLICT`, `RATE_LIMITED`)
  - `5`: 서버·외부(GitHub) 통신 장애 (`EXTERNAL_UNAVAILABLE`)
  - `6`: 쓰기 결과 미확인 (`UNCERTAIN_DELIVERY` — 자동 재전송 금지, 동일 `--idempotency-key`로 사용자 재시도 안내)

### 2.2 전체 명령 트리 (UC-01~UC-18 대응)

| 리소스 | 명령 | 비고 / 민감 입력 처리 |
|---|---|---|
| `serve` | `terminal-world serve [--ssh-port 2222] [--bridge-port 4310] [--data-dir ...] [--mcp-http]` | 통합 서버 기동 |
| `tui` | `terminal-world tui [--no-mouse]` | 로컬 개발/단독 실행용 진입(기존 로컬 프로토타입과 별도 플래그 구분) |
| `auth` | `signup`, `login`, `logout`, `approve <code>`, `grants list`, `grants revoke <id>`, `refresh`, `change-password`, `recover`, `recovery-code reissue`, `withdraw` | 비밀번호·복구 코드·최종 확인은 **명령 인수 금지**, TTY 직접 프롬프트 또는 `--password-fd`만 허용(셸 히스토리/로그 노출 차단). 승인 시 기본 7일(최대 30일, 관리자 4시간) + Access/Refresh 로테이션 자격 저장(`~/.config/terminal-world/credentials.json`, 권한 `0600`) |
| `world` | `spaces`, `lobby`, `presence`, `enter <spaceId>` | 단발 조회는 Presence 미생성 |
| `profile` | `get <nickname>`, `edit [--intro-file ...] [--stack ...] [--status ...] [--url ...] [--ascii-file ...] [--theme ...] [--preview]` | `--preview`는 저장 없이 변경 예정 값 출력 |
| `guestbook` | `list <nickname>`, `archived`, `create <nickname>`, `update <id>`, `delete <id>` | `--body` 또는 `--body-file` / `stdin` |
| `board` | `list`, `posts <board>`, `post get <id>`, `post create <board>`, `post update <id>`, `post delete <id>`, `comment create <postId>`, `comment update <id>`, `comment delete <id>` | 7개 게시판 공통 |
| `recruit` | `list [--type ...] [--role ...] [--skill ...] [--mode ...] [--state open\|closed]`, `create`, `update <id>`, `close <id>`, `bookmark add\|remove\|list` | `FR-31` 필수 항목 검증 + 공개 안내 확인 플래그 `--ack-public` |
| `notice` | `list`, `get <id>`, `create`, `update <id>`, `end <id>` | 운영 명령은 관리자 범위 + 현재 관리자 권한 확인 |
| `chat` | `history [--limit 100]`, `send --text ...`, `watch` | `watch`는 명시적 지속 세션(SSE → NDJSON) |
| `focus` | `status`, `start --attach`, `stop`, `history`, `ranking [--date YYYY-MM-DD]` | `start --attach`는 지속 연결 소유(단절 시 마지막 heartbeat까지 기록) |
| `report` | `create <kind> <id> --reason ...`, `mine` | 1회 중복/3분 30건 제한 동일 적용 |
| `admin` | `reports list`, `reports review <id> --outcome deleted\|no_action --reason ...`, `deletions list`, `delete <kind> <id> --reason ...`, `backup`, `restore <file>` | 매 호출 시 DB의 현재 관리자 권한 검증 |
| `oss` | `popular [--lang ...]`, `issues [--lang ...] [--topic ...] [--q ...]`, `issue get <repo#num>`, `issue explain <repo#num>` | `explain` 결과에 `mode: "demo"`, `sourceCheckedAt`, `demoAuthoredAt` 명시 |

---

## 3. MCP 서버 규격 (FR-27, FR-28, UC-16)

### 3.1 전송 방식 및 실행
- **1차 기본 전송 (`stdio`)**: `terminal-world mcp` — `stdout`에는 UTF-8 JSON-RPC MCP 메시지만 출력하고 모든 로그는 `stderr`로 보낸다. 로컬 Bridge HTTP API를 통해 공통 서버와 통신하므로 로컬 데이터 사본을 만들지 않는다.
- **확장 전송 (`Streamable HTTP`)**: `terminal-world serve --mcp-http` — 동일한 도구 정의(`src/mcp/tools.ts`)를 MCP `2025-11-25` Streamable HTTP 엔드포인트(`/mcp`)로 노출한다.
- **세션 구분**: MCP 초기화(`initialize`)나 HTTP 스트림 연결 자체는 커뮤니티 온라인/집중 세션을 만들지 않는다.

### 3.2 보호된 인증 및 자격 수명 (AI 컨텍스트 비노출)
- **도구 인수에 비밀번호·복구 코드·토큰 원문을 절대 받지 않는다.**
- 보호된 도구가 유효한 자격 없이 호출되면, MCP 서버는 `auth_start_approval` 도구(또는 오류 메타데이터)를 통해 **6자리 원타임 승인 코드**를 발급하고 사용자에게 안내한다:
  > "SSH TUI의 `[a] 계정/연동 관리` 또는 `terminal-world auth approve <CODE>`에서 직접 로그인·범위 확인 후 승인해 주세요."
- 승인 완료 후 MCP 어댑터가 `auth_poll_approval`로 **Access Token + Refresh Token**을 수신하여 로컬 보안 저장소(`0600`)에 보관하고, 만료 전 자동 Refresh 로테이션을 수행한다(일반 승인 최대 30일, 관리자 최대 4시간 절대 상한 준수; Refresh 재사용 탐지 시 즉시 재승인 요구).
- 가입·복구·비밀번호 변경·회원 탈퇴 등 민감 입력이 필요한 작업은 AI에게 입력을 요청하지 않고 **사용자 직접 인증 절차(CLI/SSH)로 인계**하는 안내 응답(`HANDOFF_REQUIRED`)을 반환한다.

### 3.3 MCP 도구 카탈로그 (전송 무의존 `src/mcp/tools.ts`)

| 그룹 | 도구명 | 필요 범위 | 설명 |
|---|---|---|---|
| **인증·연동** | `auth_status`, `auth_start_approval`, `auth_complete_approval`, `auth_list_grants`, `auth_revoke_grant` | guest / read / write | 현재 자격 상태·범위·만료 확인, 6자리 승인 코드 발급/완료, 본인 연동 조회/회수 |
| **공간·프로필** | `world_list_spaces`, `lobby_get_overview`, `profile_get`, `profile_preview_update`, `profile_update` | guest / write | 공간 목록, 접속자·공지 요약, 프로필 조회, 변경 예정 미리보기, 본인 프로필 저장 |
| **방명록** | `guestbook_list`, `guestbook_list_archived`, `guestbook_create`, `guestbook_update`, `guestbook_delete` | guest / write | 방명록 및 보관 목록 조회, 작성/수정/삭제 |
| **게시판·댓글** | `board_list`, `post_list`, `post_get`, `post_create`, `post_update`, `post_delete`, `comment_create`, `comment_update`, `comment_delete` | guest / write | 7개 게시판·게시글·댓글 전체 업무 |
| **모집·북마크** | `recruitment_search`, `recruitment_create`, `recruitment_update`, `recruitment_close`, `recruitment_bookmark_set`, `recruitment_bookmark_list` | guest / write | 조건 필터 검색, 모집 작성/마감, 본인 관심 글 저장/해제/조회 |
| **채팅·집중·상태** | `chat_history`, `chat_send`, `session_open_live`, `session_move_space`, `session_close_live`, `focus_status`, `focus_start`, `focus_stop`, `focus_history`, `focus_ranking` | read / write | 채팅 조회·전송(멱등키 지원), 명시적 지속 세션 개설/이동(Living Room)/종료, 집중 추적·기록·랭킹 |
| **신고·관리** | `report_create`, `report_list_mine`, `admin_notice_manage`, `admin_report_list`, `admin_report_review`, `admin_delete_content`, `admin_deletion_history` | write / admin | 신고 및 본인 결과 조회, 관리자 공지/검토/삭제/삭제 이력 |
| **오픈소스·데모 AI** | `oss_list_popular_repos`, `oss_search_issues`, `oss_get_issue`, `oss_explain_issue_demo` | guest | 공개 인기 저장소, 중소규모·신생(365일)·트렌드(7일) 이슈 탐색, 명시적 데모 AI 설명 |

### 3.4 오류 구분 및 프롬프트 인젝션 방어
- **프로토콜 오류 vs 업무 오류**: JSON-RPC 형식·존재하지 않는 도구는 MCP 프로토콜 오류로, 권한 부족·입력 검증 실패·자격 회수·GitHub 한도 초과는 `isError: true` + 구조화된 업무 오류 JSON(`code`, `field`, `message`)으로 반환한다.
- **프롬프트 인젝션 방어(5.15절)**: 게시글·댓글·방명록·채팅·GitHub 이슈 본문·AI 설명 필드는 구조화된 응답에서 `untrustedContent: true` 메타데이터로 감싸 반환하며, MCP 서버가 외부 텍스트 내용에 따라 자동으로 추가 쓰기 도구를 연쇄 호출하지 않는다. 삭제·탈퇴 등 파괴적 도구 호출에는 명시적 `confirm: true`와 사유(`reason`)를 요구한다.
