# Terminal-World 요구사항 분석 산출물

- 최초 확정일: 2026-10-28
- 개정일: 2026-11-02
- 분석 방법: OOA/D(객체지향 분석 및 설계)
- 범위: SSH TUI·CLI·MCP 기반 다중 사용자 커뮤니티의 요구사항과 개념 모델

## 1. 산출물 구성

| 산출물 | 문서 | 내용 |
|---|---|---|
| 문제 정의 | [요구사항 분석 명세](requirements-analysis.md) 2절 | 개발 배경·문제·서비스 목표 G-01~G-07 |
| 시스템 범위 | [요구사항 분석 명세](requirements-analysis.md) 3~4절 | 시스템 경계·기본 및 확장 기능·액터와 권한 |
| 기능 요구사항 | [요구사항 분석 명세](requirements-analysis.md) 5절 | FR 30개·업무 규칙·서비스 정책 |
| 비기능 요구사항 | [요구사항 분석 명세](requirements-analysis.md) 6절 | NFR-06 호환성 |
| 제약조건 | [요구사항 분석 명세](requirements-analysis.md) 7절 | CON-01~CON-04 |
| 유스케이스 모델 | [유스케이스 및 도메인 모델](analysis-models.md) 1절 | 액터·시스템 경계·UC 18개의 참여 관계 |
| 유스케이스 상세 명세 | [유스케이스 및 도메인 모델](analysis-models.md) 2절 | 목표·조건·기본 및 대안·예외 흐름·관련 FR |
| 도메인 모델 | [유스케이스 및 도메인 모델](analysis-models.md) 3절 | 개념·속성·관계·다중성·업무 규칙 |

기능 요구사항 표와 유스케이스별 관련 FR 목록에서 양방향으로 추적할 수 있다.

## 2. 도식 파일

| 모델 | Mermaid | PlantUML |
|---|---|---|
| 유스케이스 | [use-case.mmd](diagrams/use-case.mmd) | [use-case.puml](diagrams/use-case.puml) |
| 도메인 | [domain-model.mmd](diagrams/domain-model.mmd) | [domain-model.puml](diagrams/domain-model.puml) |

모델 문서의 Mermaid 도식과 독립 Mermaid·PlantUML 파일은 같은 모델을 나타낸다.

## 3. 결정 기록

| 문서 | 내용 |
|---|---|
| [2026-10-25](2026-10-25.md) | 분석 산출물 범위 결정 |
| [2026-10-26](2026-10-26.md) | 서비스 정책 결정과 변경 이력 |
| [2026-10-27~28](2026-10-27.md) | 당시 범위·제외 항목·문서 검증 기록 |
| [2026-11-02](2026-11-02.md) | CLI·MCP·이슈 탐색 확정, 모집 게시판 유지, 보류·제외 범위 반영 |

## 4. 공유본

`requirement-analysis.zip`은 이 안내·요구사항·모델·도식·결정 기록을 같은 상대 경로로 묶는다. 최신 문서와 ZIP의 내용 일치를 검증한다.
