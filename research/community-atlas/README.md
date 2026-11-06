# Terminal World — Community Atlas

실존 커뮤니티의 첫 가치, 교환 구조와 반복 사용 원리를 살펴보고 Terminal World의 커뮤니티 방향을 결정하는 독립 리서치 웹페이지다. 이전 `product-direction` 보고서와 기존 제품 코드는 수정하지 않는다.

## 열기

`index.html`을 브라우저에서 직접 연다. 실행 시 서버·빌드·외부 라이브러리·웹 폰트·네트워크 요청이 필요하지 않다. 근거 링크를 누를 때만 외부 사이트로 이동한다.

## 갱신

Python 3 표준 라이브러리만 사용한다.

```sh
python3 research/community-atlas/build.py
```

빌더는 `analysis-head.html`, `analysis-directions.html`, `analysis-tail.html`, `knowledge.json`, `creative.json`, `learning.json`, `korea.json`, `terminal.json`과 UI 소스 `shell.html`, `style.css`, `app.js`를 읽어 `index.html` 하나로 묶는다. 합친 본문은 `analysis.html`에도 저장한다. 조사 원자료는 변경하지 않는다. JSON은 `#atlas-data`에 내장하며 실행 중 `fetch()`하지 않는다. 누락 입력·중복 커뮤니티/HTML ID·내부 링크 누락·외부 런타임 자산·미치환 표식이 있으면 실패한다.

## 탐색 기능

- 5개 분류·검색·심층 조사 필터로 커뮤니티 탐색
- 최대 3개 커뮤니티를 같은 기준으로 비교, Esc로 비교창 닫기
- 자료 유형·주장 검색, 원래 조사 발견과 범위 기록 펼치기
- 시스템 테마 감지, 수동 밝음/어두움/자동 선택과 로컬 저장
- 모바일 목차, 키보드 포커스·현재 섹션 표시
- 인쇄 시 모든 커뮤니티·출처·세부 설명을 표시하고 인쇄 후 탐색 조건 복원

원자료는 DOM의 `textContent`로 출력하고 외부 링크는 HTTP/HTTPS만 허용한다. 임의 점수·인기 순위·유지율 추정은 추가하지 않는다. ‘심층 조사’는 조사 범위이며 제품 우수성 표시가 아니다.

## 근거 해석

공식 페이지 접근은 실제 로그인·운영 건전성·사용자 활동의 확인과 다르다. 개별 사용자 의견은 대표 표본이 아니다. 이식 원리와 터미널 적합성은 분석이며 실제 수요는 인터뷰와 행동 실험으로 확인해야 한다. 분류별 검색 질의·제외 범위·한계는 페이지 하단에서 원자료 구조대로 확인한다.

## 검증

```sh
node --check research/community-atlas/app.js
python3 -m py_compile research/community-atlas/build.py
python3 research/community-atlas/build.py
```

생성 후 데스크톱·360px 모바일에서 테마, 필터, 3개 비교 제한, Esc/포커스 복귀, 목차, 인쇄 전후 상태를 확인한다. 빌더의 정적 검사는 브라우저 렌더 검사를 대신하지 않는다.

## 이번 실행의 검증 결과 (2026-10-30)

85개 사례·28개 심층 사례·9개 후보·145개 근거 기록(144개 고유 URL)을 내장했다. 전체 웹의 전수조사나 시장 표본은 아니다.

`node qa/check-interactions.cjs`는 실제 함수의 검색·필터·최대 3개 비교·초기화·아이디어 정렬·인쇄 준비와 복구를 최소 DOM fixture로 검사한다. 정적 빌드와 JavaScript 문법 검사는 통과했다. 제품 원본 30개는 해시가 일치한다. 상세 결과는 `qa/verification.json`에 기록했다.

이번 실행에서는 CUA가 `Local browser use is disabled in Work settings`를 반환하여 실제 브라우저 화면을 검수하지 못했다. 360px 레이아웃, 실제 키보드 포커스, 테마 저장, native dialog, PDF 출력은 미검증이다. 로직 검사 통과를 화면 검수 완료로 해석하지 않는다.
