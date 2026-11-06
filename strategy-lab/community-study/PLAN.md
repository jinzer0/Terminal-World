# Terminal World 커뮤니티 전면 조사

기준일: 2026-10-30. 사용자 최신 지시가 우선한다. 개인 메모 도구로의 피벗을 전제하지 않는다. 터미널 **커뮤니티**의 제품 가치와 이용 동기를 강화하는 것이 목표다.

## 완료 조건

최종 상태: 2026-10-30 완료. 사례 83건·심층 29건·대안 9개·Mini PRD 3개를 통합했고 단독 HTML과 보고서를 생성했다. 브라우저 40개 검사, 핵심 색상 대비 36쌍, 반응형 화면 확인과 원본 보존 검사를 마쳤다. 검증 범위와 한계는 `../QA.md`, 독립 검수 후 수정은 `REVIEW-RESOLUTION.md`를 따른다. 사용자 인터뷰와 실제 제품 파일럿은 아직 수행하지 않았다.

1. 유명·독특한 공개 커뮤니티를 분야별로 탐색하고 등록한 모든 후보의 확인 상태와 출처를 기록한다. 웹 전체에 대한 완전한 전수 조사라고 주장하지 않는다.
2. 실제 커뮤니티와 커뮤니티 소프트웨어를 구분한다. 공식 운영 규칙·실제 활동 구조·참여자 경험을 구분하고, 수요·성공 원인·재방문율을 추정 사실로 쓰지 않는다.
3. 각 사례에 첫 참여 동기, 반복 계기, 참여자가 받는 가치와 제공하는 가치, 사회적 구조, 초기 밀도 조건, 운영 비용, 적용 가능성과 적용 금지/주의점을 남긴다.
4. 직접적으로 관련된 사례는 심층 분석한다. 개별 후기와 쇠퇴·운영 부담·실패 사례를 포함하고 긍정 자료만 모으지 않는다.
5. 사례→작동 원리→Terminal World에서의 구체적 상호작용→최초/반복 동기→실험의 추적 가능성을 확보한다. 새 이름을 붙인 일반 게시판·메모 도구를 결론으로 삼지 않는다.
6. 원래 커뮤니티 정체성을 보존하는 서로 다른 방향을 비교하고, 강한 결합 원리 하나를 제안한다. 임의 점수보다 필수 통과 조건과 미검증 가설을 공개한다.
7. 기존 HTML과 연구 보고서를 새 근거에 맞게 갱신한다. 기존 버전은 보존한다. 단독 HTML 공유·로컬 실행과 핵심 인터랙션을 검증한다.

## 작업 순서

후보 목록 및 조사 기준 → 네 가지 병렬 조사 → 증거·반례 감사 → 이용 동기 구조 비교 → 적용안과 실험 → 보고서·탐색형 HTML 갱신 → 브라우저/내용 검증.

## 병렬 파일 소유권

- terminal-maker lane: `lanes/terminal-maker.json`, `lanes/terminal-maker-notes.md`
- knowledge lane: `lanes/knowledge.json`, `lanes/knowledge-notes.md`
- participation lane: `lanes/participation.json`, `lanes/participation-notes.md`
- root: 나머지 파일, 통합, 한국/정체성/교환/실패 사례, 최종 검증.

## 공통 JSON 스키마

각 lane은 `{ "lane": "...", "checkedAt": "2026-10-30", "communities": [...], "deepDives": [...], "coverageNotes": [...] }`를 저장한다.

community 필드: `id`, `name`, `category`, `kind`(community/platform/network/event), `status`(observed-active/historical/unclear), `description`, `audience`, `entryHook`, `returnLoop`, `memberGives`, `memberGets`, `socialObject`, `mechanisms`(배열), `density`, `operatingCost`, `risk`, `terminalTransfer`, `doNotCopy`, `evidenceLevel`(official/official+participant/limited), `sources`(배열: url,title,type,claim,accessedAt), `hypothesis`(동기와 전이 판단은 관찰에서 유도한 분석이며 인과·수요 입증 아님).

deepDive 필드: `communityId`, `observedDesign`, `contributionCycle`, `entryAndReturn`, `governance`, `negativeEvidence`, `terminalExperiment`, `sources`. 각 핵심 주장에 출처를 가까이 붙인다. 한국어로 작성하고 영어 제품명은 유지한다.

공식 페이지 본문을 읽고 확인한 사실만 기록한다. 검색 결과만 있으면 limited로 명시한다. 후기 없으면 없다고 쓰고 만들어내지 않는다. 스크린샷·가입·메시지 전송은 필수 아님. 외부 커뮤니티에 글/메시지 작성 금지.
