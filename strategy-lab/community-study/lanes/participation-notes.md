# 참여·제작 공동체 조사: 함께 만드는 일이 재방문의 이유가 되는 구조

기준일: 2026-10-30. 범위는 참여·학습·제작·공동 목표·호혜 교환 공동체 20개다. 웹 전체 전수 조사나 성공 원인 분석이 아니다. 각 사례의 구조화된 원장은 [participation.json](participation.json)이며, 아래는 통합 담당자가 사용할 해석과 실험 제안이다. 기존 개인 메모 피벗을 전제하지 않는다.

## 핵심 판단

Terminal World의 강한 참여 이유 후보는 **“내가 만든 작은 것이 다른 사람에게 실제로 쓰이고, 나도 다른 사람의 결과물을 시험하고 개선하는 공동 제작 동아리”**다. 접속 자체·상태·방의 이름보다, 참여 직후 할 일이 있고 그 결과를 기다리는 사람이 있는지가 중요하다. 이는 본 사례에서 유도한 제품 가설이다. 해당 가설의 인과효과나 Terminal World 수요는 아직 검증하지 않았다.

같은 대화·링크·타이머만 제공하면 Discord 대비 이전 이유는 약하다. 터미널이 유리하려면 결과물이 CLI 프로그램·실행 기록·테스트·리믹스처럼 터미널에서 바로 경험할 수 있는 대상이어야 한다. SSH라는 접속 방식은 가치 제안이 아니라 공동의 경험을 제공하는 전달 수단이다. 이 주장 역시 검증 대상이다.

## 조사 방법과 근거 수준

1. 코딩 훈련, 창작 행사, 시민 과학, 집중, 습관·운동, 취향·교환의 서로 다른 구조를 의도적으로 포함했다.
2. 공식 소개에서 시작한 뒤 실제 규칙·참여 안내·운영 공지로 이동했다. 각 등록 사례마다 공식 본문을 최소 한 개 읽었다.
3. 독립 원문으로 참여 경험을 보완했다. Kean의 개인 블로그, Advent of Code Reddit, 전 NaNoWriMo 지역 운영자 Judy Mohr의 글, Habitica 파티 모집 스레드 네 개다. 운영자가 쓴 부담·축소 공지도 별도 음성 근거로 삼았다.
4. 광고성 수치·회원 수·성적 향상·취업 성과를 수요나 효과의 증명으로 쓰지 않았다. 공식 페이지의 “도움이 된다”는 말도 설계 의도로 취급한다.
5. 관찰된 기능과 분석한 동기를 분리했다. JSON의 entryHook·returnLoop·density·operatingCost·terminalTransfer에는 연구자의 해석이 포함된다. 모든 사례의 hypothesis가 이 한계를 명시한다.

개별 후기는 자기 선택 표본이다. 순위 경쟁에 관심 있는 사용자, 남은 참여자, 떠난 운영자의 목소리는 전체를 대표하지 않는다. 익명 계정의 부정행위 주장은 사실 확인된 적발 통계가 아니다. 공식 운영 공지도 운영자가 공개하기로 한 범위만 보여 준다. 인터뷰·실제 가입·모집·메시지 발송·행사 운영은 실행하지 않았다.

## 조사 범위와 확인 상태

| 분야 | 포함 사례 | 확인 범위 |
|---|---|---|
| 제작·학습 | Hack Club, Exercism, Codewars, freeCodeCamp | 작업물·질문·멘토링·기여 순환 |
| 대회·시즌 | Advent of Code, Codeforces, LeetCode, Kaggle, itch.io jams, Ludum Dare | 공동 일정·결과물·평가·운영 부담 |
| 집필·지속성 | NaNoWriMo / NaNo 2.0 | 원 조직 종료와 의식·지역 관계의 분리 |
| 공익 기여 | Zooniverse, iNaturalist, Folding@home | 작은 기여가 공동 산출물로 합쳐짐 |
| 집중·습관 | Focusmate, Study Together, Habitica | 약속·출석·동료 구조·기능 축소 |
| 활동·취향·교환 | Strava, Letterboxd, Postcrossing | 이미 하는 활동에 관계를 붙이는 구조 |

- `observed-active`는 공개 안내나 활동 흔적이 관찰됐다는 뜻이다. 계정으로 기능을 실행해 검증한 상태나 서비스 건전성 보증이 아니다.
- **NaNoWriMo 원 비영리 조직은 종료된 역사적 사례**다. NaNo 2.0은 별도 자원봉사 그룹이다. 원 도메인과 종료 YouTube 영상 본문 접근은 실패했다. 종료는 [후속 그룹의 공식 FAQ](https://nano2.org/faq/)와 [전 지역 운영자의 원문](https://judylmohr.com/2024/11/01/goodbye-nanowrimo/)로 교차 확인했다. 후속 그룹의 원인 설명은 원 조직 당사자의 공식 해명이 아니다.
- **Ludum Dare는 `unclear`**다. [2025 취소 공지 자체가 복귀로 정정](https://ludumdare.com/news/taking-a-break/)됐고 [공식 뉴스](https://ludumdare.com/news/)에도 복귀 제목이 있다. 영구 종료라고 쓰면 오류다. 최신 2026 일정과 ldjam 세부 규칙은 확인하지 못했다.
- **Study Together는 신규 이용자를 StudyStream으로 안내**한다. 기존 홈페이지에 남은 모든 기능이 현재 StudyStream과 일치한다고 검증하지 않았다. [공식 홈페이지](https://www.studytogether.com/)
- Habitica 현재 기능 페이지는 본문 추출 실패다. 파티 설명은 공식 검색 본문과 실제 모집 글로 보조했다. 공개 사회 기능 종료는 [공식 릴리스](https://github.com/HabitRPG/habitica/releases/tag/v5.0.0), 최근 코드 기여 중단은 [공식 저장소](https://github.com/HabitRPG/habitica) 본문으로 확인했다. 오래된 길드 설명을 현재 기능으로 재사용하면 안 된다.
- Kaggle 동적 문서의 본문은 추출되지 않아 [Google/Kaggle의 2026 공식 발표](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-kaggle-community-hackathons/)를 최종 근거로 썼다. LeetCode는 주간 대회 안내 본문만 확인했으며 실제 대회 상세는 동적 추출에 실패했다.
- 후보 Geocaching은 페이지를 열었지만 다른 20개로 범위를 충족해 최종 비교에 포함하지 않았다. BOINC 대신 Folding@home을 조사했다.

## 사례를 관통하는 다섯 원리

### 1. 존재감보다 ‘사회적 대상’이 먼저다

Hack Club의 프로젝트, Exercism의 수정 코드, itch.io의 게임, iNaturalist의 관찰은 “무엇을 이야기할지”를 제공한다. 그 대상에 질문·시험·해석·개선이 붙는다. 개발 중 상태와 접속 시간은 누군가가 반응할 이유가 약하다. [Hack Club 참여 안내](https://slack.hackclub.com/), [Exercism](https://exercism.org/), [itch.io jam 안내](https://itch.io/docs/creators/game-jams), [iNaturalist 소개](https://www.inaturalist.org/pages/about)

**Terminal World 상호작용 제안:** “디버깅 중” 대신 “이 작은 도구의 빈 입력 처리를 시험해 줄 사람”을 표시한다. 원시 활동을 자동 수집하지 않고 공유자가 대상·요청·실행 예시를 선택한다. 받은 구체 피드백과 실제 수정이 핵심 결과다.

### 2. 공동 마감은 같은 시간에 할 일을 만든다

Advent of Code와 창작 행사는 같은 공개·마감 시점으로 대화거리를 맞춘다. Focusmate는 예약과 시작/종료 체크인으로 한 사람을 기다리는 상대를 만든다. 상시 접속 밀도가 작아도 정해진 시점에 모을 수 있다는 전이 가설이다. [AoC 소개](https://adventofcode.com/2025/about), [Focusmate 참여 구조](https://www.focusmate.com/how-it-works/)

**제안:** 빈 Focus Room을 늘리는 대신 금요일 20시 “작은 도구 완성·시연”과 다음 이틀 피드백 기간을 둔다. 정시 접속이 어려운 사람도 비동기 제출·리뷰로 참여하게 한다. 매일 새 콘텐츠를 약속하지 않는다.

### 3. 내 결과물을 봐 줄 관객은 자동으로 생기지 않는다

itch.io는 작품 노출·평가 불균형을 다루는 대기열을 제공한다. Postcrossing은 내가 보낸 기여가 도착 확인된 후 다른 사람에게서 받을 기회를 연결한다. 이들은 호혜를 플랫폼 흐름으로 구체화한다. 작은 행사에는 대기열이 부적합할 수 있다는 공식 경고도 함께 적용해야 한다. [itch.io 평가 대기열](https://itch.io/docs/creators/game-jams), [Postcrossing 교환 구조](https://www.postcrossing.com/about)

**제안:** 제출물별 최소 리뷰를 목표로 운영자가 수동 배정하되, 리뷰 횟수보다 “실행됨·문제 발견·개선 제안”을 확인한다. 처음에는 의무 교환과 자유 선택을 교차 시험한다. 토큰 획득을 위한 빈 댓글은 인정하지 않는다. 피드백은 보장된 권리라고 선언하기 전에 공급 시간을 측정한다.

### 4. 소비자에서 기여자로 이동할 작은 역할이 필요하다

Codewars는 출제·해법·중재를 회원이 만들고, Exercism은 멘토로 환원하도록 초대한다. Zooniverse는 작은 분류를 실제 연구 산출물에 연결한다. 기능이 아니라 “다음에는 내가 도울 차례”라는 역할 사다리의 후보를 보여 준다. [Codewars](https://www.codewars.com/about), [Exercism 멘토 가이드](https://exercism.org/docs/using/feedback/guide-to-being-mentored), [Zooniverse](https://www.zooniverse.org/about)

**제안:** 신입 → 첫 제출자 → 실행 확인자 → 초보 리뷰어 → 미션 공동 출제자. 숙련 순위보다 각각의 실제 기여를 인정한다. 숙련자에게 모든 답을 요구하지 않고, 초보도 사용성·설명 오류를 발견할 수 있게 한다.

### 5. 관계는 운영 조직과 저장 도구보다 오래갈 수 있어야 한다

NaNoWriMo의 지역 운영자는 조직과 결별한 뒤에도 외부 행사·도구로 집필 관계를 이어 갔다. Letterboxd는 이미 하는 감상에 기록·발견을 연결한다. 따라서 새 앱에 모든 활동을 가두는 것보다 기존 작업과 관계를 계속할 수 있게 하는 편이 검증할 가치가 있다. [Judy Mohr 원문](https://judylmohr.com/2024/11/01/goodbye-nanowrimo/), [Letterboxd 소개](https://letterboxd.com/about/what-is-letterboxd/)

**제안:** 회원 작품·피드백을 내보내고 저장소 링크를 유지한다. Terminal World 사용을 중단해도 산출물과 소그룹 관계가 남게 한다. 기록이 쌓인다는 이유만으로 반복 사용을 강요하지 않는다.

## 심층 사례와 반례가 바꾸는 설계

| 심층 사례 | 확인한 강한 구조 | 확인한 반례·부담 | 적용 판단 |
|---|---|---|---|
| Hack Club | 제작 도전·또래 신입 환대·진행 공개 | 위압적인 첫 진입, 보상/보호/중재 필요 | 과제와 환영 담당자를 함께 마련한다. 보상 규모는 복제하지 않는다. |
| Exercism | 코드 수정에 붙는 사람의 관점과 후속 대화 | 자원봉사 지연·멘토 미심사·갈등 | 기다림을 표시하고 작은 조언부터 주고받는다. 즉답을 약속하지 않는다. |
| Advent of Code | 공동 공개·개인 목표·친구 모임 | 제작자 시간·공격·순위 스트레스 | 한정 시즌과 회고를 빌리고 글로벌 속도 순위는 뺀다. |
| itch.io jams | 만들기 뒤 플레이·평가가 계속됨 | 인기 쏠림·조작·실행 호환성·작은 행사 대기열 한계 | 비경쟁 결과물 교류회와 수동 배정부터 시험한다. |
| NaNoWriMo | 공동 의식·지역 진행자가 도구를 넘어 존속 | 원 조직 종료·신뢰/지원에 대한 전 운영자 비판 | 안전과 운영자 지원·내보내기를 제품의 일부로 본다. |
| Ludum Dare | 반복 행사와 후원 | 취소 뒤 복귀; 운영자의 재정·건강·가족 부담 | 실패/폐쇄로 단정하지 않고 인력 의존성을 반례로 쓴다. |
| Habitica | 목표·시간대·파티 성격의 명시 | 공개 사회 기능 종료·2026 코드 기여 접수 중단 | 모든 사람을 같은 방에 넣기보다 참여 성격을 드러낸다. |
| Postcrossing | 직접 맞교환이 아닌 확인 가능한 호혜 | 지연·비용·품질의 위험 | 다른 사람의 도구를 실제 써 보는 교환을 검증한다. |

위 표의 사실 출처와 구체 실험은 JSON deepDives 8개에 각각 보존했다. **부정 근거를 검토했다고 전부 실패라고 분류하지 않는다.** AoC는 잘못된 경쟁을 제거했고, Ludum Dare는 취소를 정정했으며, Habitica는 범위를 축소했다. 상황에 맞춰 줄이는 능력도 운영 설계다.

## 개별 경험·운영 부담 원문에서 확인한 것

- [Kean의 AoC 회고](https://keanw.com/2025/12/winding-down.html): 연례 풀이를 코딩 연습 의식으로 삼았고 짧아진 시즌을 긍정적으로 평가했다. “항상 더 많은 콘텐츠가 낫다”의 반례인 한 사람의 경험이다. 글의 과거 행사 일수 표현은 공식 자료와 섞지 않았다.
- [AoC 순위 논의](https://www.reddit.com/r/adventofcode/comments/1oba8vr/leaderboard_in_2025/): 작성자는 글로벌 순위를 목표로 준비했지만 AI 부정 의심 때문에 학습 목표 변경을 고려했다. 경쟁이 일부에게 강한 동기인 동시에 참여를 훼손할 수도 있다는 긴장을 보여 준다. 부정행위가 실제 얼마나 있었는지는 확인하지 않았다.
- [Judy Mohr의 NaNoWriMo 회고](https://judylmohr.com/2024/11/01/goodbye-nanowrimo/): 지역 운영·지원에 대한 불만과 탈퇴, 별도 지역 행사 지속을 직접 서술했다. 논쟁적 사건의 세부를 독립 확정하지 않고 운영자 경험과 이탈 이유로만 사용했다.
- [Habitica 파티 모집](https://www.reddit.com/r/habitica/comments/1u9b5fw/monthly_megathread_habitica_party_recruitment/): 시간대·목표·교류 성격이 적합성 기준이며 한 사람은 교류가 외부 앱으로만 빠지는 파티를 원하지 않았다. Terminal World 내 교류를 원하는 사람이 얼마나 되는지 증명하지 않는다.
- [AoC 공식 운영 설명](https://adventofcode.com/2025/about), [Exercism 공식 가이드](https://exercism.org/docs/using/feedback/guide-to-being-mentored), [Ludum Dare 운영자 공지](https://ludumdare.com/news/taking-a-break/), [Habitica 공식 릴리스](https://github.com/HabitRPG/habitica/releases/tag/v5.0.0)는 각각 제작 부담·응답 지연·운영자 생활·사회 기능 축소를 직접 확인할 수 있는 원문이다.

## Terminal World로 연결할 세 방향

세 방향 모두 사람이 공동 결과물을 만들고 주고받는 **커뮤니티**다. 일반 게시판·메모 도구로 바꾼 제안이 아니다. 명칭과 세부 UI는 가설이며 새로 구현했다고 주장하지 않는다.

| 방향 | 공동 가치와 구체 상호작용 | 첫 방문 이유 | 돌아올 이유 | 터미널의 필요 조건 |
|---|---|---|---|---|
| 제작 동아리 / Shipyard | 같은 제약으로 CLI 장난감·작은 도구를 만들고 서로 실행·리뷰·리믹스한다. | 준비된 30분 과제와 함께할 코호트 | 내 작품 사용 반응·리뷰 답변·다음 도전 | 작업물을 그 자리에서 경험하는 공통 실행/시연 흐름이 웹 링크보다 짧아야 한다. |
| 협동 재현실 / Repro Commons | 공개 도구의 버그·환경 문제를 함께 재현하고 검증된 재현 꾸러미를 만든다. | 내 구체 오류에 대한 타인의 재현 | 공동 해결 결과·내가 도울 새 재현·지원 환경 축적 | 명령·입출력·환경 차이를 안전하고 정확히 주고받는 이점이 있어야 한다. |
| 시즌 길드 / Terminal Season | 한정 기간의 독자 미션을 각자 풀고 친구에게 해법·시각화를 설명하며 공동 전시를 만든다. | 같은 시작일과 끝낼 수 있는 작은 시즌 | 다음 공개·친구 회고·최종 전시 | 단순 문제 링크가 아니라 풀이를 시험·시각화하는 경험이 있어야 한다. |

이 lane에서는 제작 동아리가 다른 두 방향을 담을 수 있는 **첫 실험 후보**다. 하지만 “재미있어 보인다”를 수요 증거로 바꾸지 않는다. 개인의 결과물 전시 욕구, 타인 작품을 써 볼 의향, 무보상 피드백 공급이 모두 통과해야 한다. 특히 시험할 작품이 빈약하면 공동 실행 환경을 만들어도 이유가 약하다.

## 강한 결합 원리와 검증 실험

**제작 → 사용 → 구체 반응 → 개선 → 다음 제작**을 한 번의 공동 시즌으로 묶는 것이 제안하는 결합 원리다. 누구든 타인의 결과물에 실제 영향을 줄 수 있어야 한다. 타이머 랭킹이나 접속 수는 보조 신호다.

아래는 아직 실행하지 않은 실험 설계다. 숫자는 성공 사례에서 도출한 통계가 아니라 소규모 졸업팀이 다음 개발 투자를 결정하기 위한 사전 기준이다.

1. **기존 성인 동아리 8–12명, 진행자 2명, 2주**로 시작한다. 임의 공개 모집보다 관계·수준이 어느 정도 있는 집단으로 cold start를 제한한다. 한 명이 빠져도 행사를 이어 갈 진행자를 둔다.
2. 동일 난이도의 작은 과제 두 개와 미리 만든 시범 작품을 준비한다. 한 주는 현재 Discord/저장소 방식, 다른 주는 터미널의 제출·시연·피드백 흐름을 쓴다. 소그룹별 순서를 교차해 새로움·순서 효과를 줄인다. 완전한 통제 실험은 아니다.
3. 자유 작품 선택과 수동 리뷰 배정을 나눠 본다. 각 작품에 구체 피드백이 몰리지 않는지 확인한다. 도움을 받으려면 억지 리뷰부터 하게 하는 구조가 오히려 이탈을 만드는지도 묻는다.
4. **관찰 단위**는 접속이 아니라 제출 작품, 타인의 실행 성공, 유용함을 수신자가 확인한 피드백, 반영된 수정, 새 미션의 자발 참여다. 같은 사람의 여러 메시지를 여러 명으로 세지 않는다.
5. **예비 통과 조건:** 참여자의 과반이 최소 한 번 타인 작품을 실제 사용하고, 제출 작품 대부분이 48시간 안에 구체 피드백 한 개 이상을 받으며, 다음 시즌 참가자 중 일부가 진행자의 독촉 없이 역할을 다시 맡는다. 과반·대부분의 정확한 분모와 기준은 모집 전에 고정한다. 8–12명 결과를 모집단 비율로 일반화하지 않는다.
6. **중단/변경 신호:** 시범과 도움을 제공해도 작품이 안 나오거나, 리뷰가 진행자 두 사람에게만 의존하거나, 터미널 흐름이 기존 방식보다 실패/설명 부담을 키우거나, 다음 참여 의사가 실제 행동으로 이어지지 않으면 구현 확대를 멈춘다. 콘텐츠·대상·일정을 먼저 바꾸고 필요하면 터미널 전달 방식을 포기한다.
7. 서버에서 임의 코드를 실행하는 플랫폼은 이 실험의 선행 조건이 아니다. 사전 검토한 시범 도구·기록된 입출력 또는 이용자 로컬 실행으로 검증한다. 공통 실행 환경이 필요하다는 수요가 확인된 뒤에 격리·자원 제한·권한·삭제·운영 비용을 별도로 설계한다.

### 물어볼 질문

- 지난달 완성하지 못한 작은 제작물은 무엇이며, 누구의 어떤 반응이 있었다면 끝냈을 것인가?
- 이미 쓰는 Discord/저장소 흐름에서 결과물을 올린 뒤 실제로 어떤 일이 일어났는가?
- 남의 도구를 마지막으로 직접 실행해 본 시점과 그 이유는 무엇인가?
- 다른 사람의 작품을 시험할 때 무엇이 귀찮거나 불안한가?
- 별점과 “좋아요” 대신 어떤 피드백을 받았을 때 다시 만들고 싶었는가?
- 정해진 리뷰 배정·공동 마감·순위 중 무엇이 부담이고 무엇이 약속으로 느껴지는가?
- 이번 실험에서 터미널 때문에 쉬워진 일과 어려워진 일은 무엇인가?
- 다음 주 스스로 다시 맡을 역할은 무엇이며 실제로 언제 하겠는가?

“이 서비스를 쓸 것인가”라는 추상 찬성보다 실제 과거 행동과 다음 자발 행동을 우선한다.

## 통합 시 주의할 오독

- 작동 원리를 발견한 것과 시장 수요·전환 이유를 입증한 것은 다르다.
- 공동체 소프트웨어의 기능을 공동체 자체의 성공 원인으로 취급하지 않는다.
- 상시 presence와 카메라 기반 body doubling의 작동 조건은 같지 않다.
- 경쟁을 없애면 모두 행복하다고 일반화하지 않는다. 경쟁 참가자와 학습 참가자의 선택권을 비교한다.
- 과제 수·메시지 수·실행 시간·리뷰 토큰이 실질 기여나 관계의 깊이를 보장하지 않는다.
- 익명 후기·전 운영자 비판을 사건 전체의 사실 판결처럼 인용하지 않는다.
- 후속 조직의 홈페이지를 원 조직의 공식 발표로 표기하지 않는다.
- 초기에는 관객과 환대·피드백 공급을 운영자가 준비해야 한다. “혼자 있어도 유용”만으로 커뮤니티가 되는 것은 아니다.

## 출처 원장

아래는 JSON에 채택한 원문 URL이다. 모두 2026-10-30 확인했다. 공식 검색 본문만 확인한 항목은 따로 표시했다.

1. [Hack Club](https://hackclub.com/) — official. 대상 연령과 프로젝트 중심 정체성.
2. [Join Hack Club on Slack](https://slack.hackclub.com/) — official. YSWS·Gardeners·신입 채널·scrapbook·중재.
3. [Hack Club Safety](https://hackclub.com/safety) — official. 신고와 보호 정책.
4. [Exercism](https://exercism.org/) — official. CLI·연습·자동 분석·멘토링.
5. [Guide to being mentored](https://exercism.org/docs/using/feedback/guide-to-being-mentored) — official. 수정 알림·지연·갈등 종료·미검증 멘토·환원.
6. [About Codewars](https://www.codewars.com/about) — official. 회원 출제·풀이·중재·Kumite·컬렉션.
7. [About Advent of Code 2025](https://adventofcode.com/2025/about) — official. 친구 순위·제작 부담·일수 변경·글로벌 순위 폐지.
8. [Winding down](https://keanw.com/2025/12/winding-down.html) — participant. 개인의 학습 의식·짧아진 시즌 선호.
9. [Leaderboard in 2025](https://www.reddit.com/r/adventofcode/comments/1oba8vr/leaderboard_in_2025/) — participant. 속도 목표·AI 부정 의심·학습 목표 전환 경험.
10. [About freeCodeCamp FAQ](https://www.freecodecamp.org/news/about/) — official. 비영리·프로젝트·인증·자기 속도·공개 코드/데모.
11. [Codeforces current rounds](https://codeforces.com/) — official. 2026-10-31 라운드 출제·검수·open hacks·신뢰/AI 규칙.
12. [LeetCode Contest](https://leetcode.com/contest/) — official. 매주 대회·순위; 동적 상세는 미확인.
13. [Introducing Kaggle Community Hackathons](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-kaggle-community-hackathons/) — official. 2026 공식 발표: 자료·노트북·토론·write-up·갤러리·심사.
14. [itch.io game jams](https://itch.io/jams) — official. 공개 행사 목록과 기간·제출 구조.
15. [Hosting a game jam](https://itch.io/docs/creators/game-jams) — official. 평가 대기열·작은 행사 한계·플랫폼 선택·댓글 연결·권한.
16. [Ludum Dare](https://ludumdare.com/) — official. jam 정체성; 노출 일정은 2025로 오래됨.
17. [Taking a break (updated)](https://ludumdare.com/news/taking-a-break/) — official. 재정·의료·가족 사유의 취소와 복귀 정정.
18. [Ludum Dare News](https://ludumdare.com/news/) — official. 2025-04-03 복귀 공지 목록.
19. [NaNo 2.0 FAQ](https://nano2.org/faq/) — official. 별도 자원봉사 그룹·원 조직 종료·목표/마감·16세 이상·사회 기능 없음; 원 조직 당사자 아님.
20. [Goodbye NaNoWriMo](https://judylmohr.com/2024/11/01/goodbye-nanowrimo/) — participant. 전 지역 운영자의 탈퇴·운영 부담·외부 공동체 지속 경험.
21. [About Zooniverse](https://www.zooniverse.org/about) — official. 분류·Talk·여러 기여 결합·연구 데이터와 출판 결과·참여 증명.
22. [About iNaturalist](https://www.inaturalist.org/pages/about) — official. 관찰→동정 도움→과학 데이터의 공동 가치.
23. [iNaturalist Community Guidelines](https://www.inaturalist.org/pages/community+guidelines) — official. 허위 동정·다계정·데이터 품질 규범.
24. [Folding@home](https://foldingathome.org/) — official. 작업 분배·결과 반환·포인트·팀·계정 없이 시작.
25. [How Focusmate Works](https://www.focusmate.com/how-it-works/) — official. 예약·영상·목표·종료 확인·즐겨찾기.
26. [Focusmate Community Guidelines](https://www.focusmate.com/community/) — official. 정시 출석·카메라·작업 전후 대화·안전·연령.
27. [Study Together](https://www.studytogether.com/) — official. StudyStream 합류·신규 가입 이전·기존 방/목표/도움·역할 보상.
28. [Habitica Features](https://habitica.com/static/features) — official-search-only. 검색 본문의 파티·퀘스트·챌린지; 페이지 본문 추출 실패.
29. [Guild and Tavern Retirement](https://github.com/HabitRPG/habitica/releases/tag/v5.0.0) — official. 공개 사회 기능 종료·파티 범위 유지.
30. [Habitica official repository](https://github.com/HabitRPG/habitica) — official. RPG 습관 관리·2026-08-04 코드 기여 접수 중단.
31. [Habitica Party Recruitment](https://www.reddit.com/r/habitica/comments/1u9b5fw/monthly_megathread_habitica_party_recruitment/) — participant. 규칙·시간대·교류 성격을 밝히는 모집과 off-platform 파티를 원치 않는 개인.
32. [How Group Challenges Work](https://support.strava.com/en-us/articles/15401736-how-do-group-challenges-work-on-strava) — official. 공동 목표는 순위 없음·친구 초대·기간·구독·모바일·공개 범위.
33. [What is Letterboxd?](https://letterboxd.com/about/what-is-letterboxd/) — official. 영화 일지·리뷰·목록·친구 팔로우·취향·발견.
34. [About Postcrossing](https://www.postcrossing.com/about) — official. 무작위 발송·ID 등록·받을 자격·다른 사람으로부터 수신.

미확인/접근 실패 로그: 원 NaNoWriMo 도메인과 종료 영상 본문, ldjam.com과 최신 행사 규칙, Habitica 기능 페이지 본문, Kaggle 일부 동적 문서, LeetCode 실제 대회 상세. 이 자료의 검색 요약이나 링크 존재만으로 읽었다고 주장하지 않았다. NaNoWriMo 원 종료 영상 URL은 https://www.youtube.com/watch?v=TR6NnjgeIIY 이며 검색 메타데이터만 확인했다.

## 통합 감사 정정
원 NaNoWriMo 종료는 후속 그룹 FAQ의 설명에 귀속한다. 전 지역 운영자 회고는 실제 종료의 독립 확인이 아니다. 두 원문이 같은 사실을 교차 확인했다는 해석은 사용하지 않는다.
