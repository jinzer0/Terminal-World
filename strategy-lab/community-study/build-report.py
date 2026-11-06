import json,pathlib,collections
P=pathlib.Path(__file__).parent;D=json.loads((P/'data.json').read_text());parts=[]
def add(s=''):parts.append(s)
def bullets(xs):return '\n'.join('- '+str(x) for x in xs)
def table(head,rows):
 def esc(x):return str(x).replace('|',' / ').replace('\n',' ')
 return '| '+' | '.join(head)+' |\n| '+' | '.join(['---']*len(head))+' |\n'+'\n'.join('| '+' | '.join(map(esc,row))+' |' for row in rows)
n=(P/'narrative.md').read_text();start=n.index('## 13. ');end=n.index('## 14. ',start)
n=n[:start]+'## 13. 8주 실행 후보와 통과 조건\n\n2주차 비교는 수동 프로토타입으로 본격 개발 전에 수행한다. 5–6주차에는 14일 자유 이용을 관찰한다. 학기 일정·인원에 따라 조정할 제안이다.\n\n'+table(['기간','단계','목표·산출물','통과 조건'],[(x['weeks'],x['title'],x['goal']+' / '+x['deliverable'],x['gate']) for x in D['roadmap']])+'\n\n시연은 두 회원의 실행·변형·계보·반영·응답과 권한·오류·되돌리기를 보여준다. 예시 활동을 실제 성과로 제시하지 않는다.\n\n'+n[end:]
(P/'narrative.md').write_text(n);add(n)
def fields(x,pairs):
 for label,key in pairs:add('- **'+label+':** '+(x[key] if isinstance(x[key],str) else ' / '.join(map(str,x[key]))))
add('\n---\n\n## 부록 A. 9개 콘셉트 원장\n\nA=기존 공동체 강화, B=터미널 매체 중심 재정의, C=매체 제약 없이 공동체 문제 재설계. 모든 방향은 검증 전 가설이다.\n')
for x in D['ideas']:
 add('### '+x['name']+' · '+x['strategy']+'\n\n'+x['tagline']+'\n')
 fields(x,[('타깃','target'),('문제','problem'),('시나리오','scenario'),('대신 쓸 이유','reason'),('반복 동기','repeat'),('차별성','difference'),('난도','difficulty'),('초기 가치','coldStart'),('실패','risk'),('장점','advantages'),('단점','disadvantages'),('선별','screening')])
 add('\n근거: '+', '.join('['+c['name']+']('+c['sources'][0]['url']+')' for c in D['communities'] if c['id'] in x['refs'])+'\n')
add('## 부록 B. 타깃 7집단과 JTBD\n\n중요도·빈도·모집 가능성은 가설이다. 모집·수요 측정은 수행하지 않았다.\n')
for x in D['targets']:
 add('### '+x['name']+'\n\n'+x['jtbd']+'\n');fields(x,[('불편','pain'),('현재 방식','current'),('동기','motivation'),('기회','opportunity'),('접근성','access'),('우선순위','priority'),('근거','rationale')]);add()
add('## 부록 C. 상위 세 후보 평가·가중치·Mini PRD\n\n'+D['decisionNote']+'\n')
add(table(['기준','기본 가중치','의미'],[(c['label'],str(c['weight'])+'%',c['description']) for c in D['criteria']]))
add('\n'+table(['후보']+[c['label'] for c in D['criteria']]+['총점'],[(c['name'],*c['scores'],f"{sum(s*q['weight'] for s,q in zip(c['scores'],D['criteria']))/sum(q['weight'] for q in D['criteria'])*20:.1f} / 100") for c in D['concepts']]))
for x in D['concepts']:
 add('\n### '+x['name']+'\n');add(table(['기준','점수 / 5','판단 근거'],[(q['label'],s,r) for q,s,r in zip(D['criteria'],x['scores'],x['rationale'])]));add()
 fields(x,[('비전','vision'),('핵심 가치','value'),('가상 페르소나','persona'),('문제','problem'),('핵심 기능','functions'),('첫 사용','first'),('반복','daily'),('유지','keep'),('수정','change'),('삭제','remove'),('UX','ux'),('기술 후보','tech'),('우위 가설','edge'),('위험','risk')])
add('\n## 부록 D. MVP·실험 사전 계약\n\n'+D['experiments']['limits']+'\n')
for title,items in [('최소 범위',D['mvp']['must']),('후속 범위',D['mvp']['later']),('모집·운영',D['mvp']['recruitment']),('기술 구조',D['mvp']['architecture']),('보안·운영 경계',D['mvp']['security']),('비교·관찰 절차',D['experiments']['protocol'])]:add('### '+title+'\n\n'+bullets(items)+'\n')
add('### 판단 지표\n\n'+table(['지표','분모·정의','사전 문턱'],[(m['name'],m['definition'],m['threshold']) for m in D['experiments']['metrics']]))
add('\n### 중단·변경\n\n'+bullets(D['experiments']['stop'])+'\n')
add('## 부록 E. 83개 사례 원장과 29개 심층 기록\n\n첫 참여·반복·비용·적용은 관찰 구조에 대한 해석이다. 재방문율·성공 원인으로 읽지 않는다. 상태는 건강도 점수가 아니며 근거 유형도 인과 강도 순위가 아니다.\n')
status={'observed-active':'공개 활동·운영 기록 관찰','unclear':'최근 회원 활동 미확인','historical':'역사·종료 관련 사례'}
kind={'community':'공동체','platform':'플랫폼','network':'네트워크','event':'행사'}
level={'official':'공식 구조·운영 자료','official+participant':'공식 자료와 개별 경험','limited':'접근·근거 제한'}
for i,x in enumerate(D['communities'],1):
 add(f"### {i:02d}. {x['name']}\n\n{x['description']}\n\n{x['laneLabel']} · {kind[x['kind']]} · {status[x['status']]} · {level[x['evidenceLevel']]}\n")
 fields(x,[('타깃','audience'),('첫 참여 가설','entryHook'),('반복 가설','returnLoop'),('주는 것','memberGives'),('받는 것','memberGets'),('대상','socialObject'),('장치','mechanisms'),('밀도 조건','density'),('운영 비용','operatingCost'),('위험·반례','risk'),('적용 가설','terminalTransfer'),('복제하지 않을 것','doNotCopy')])
 add('\n**자료·확인 주장**\n')
 for s in x['sources']:add('- ['+s['title']+']('+s['url']+') — '+s['claim']+' ('+s['type']+'; 확인 '+s['accessedAt']+')')
 for dd in [a for a in D['deepDives'] if a['communityId']==x['id']]:
  for s in dd['sources']:
   if s['url'] not in {v['url'] for v in x['sources']}:add('- 추가 심층 자료: ['+s['title']+']('+s['url']+') — '+s['claim'])
  add('\n**심층 기록**\n');fields(dd,[('관찰','observedDesign'),('순환','contributionCycle'),('첫·다음 참여','entryAndReturn'),('운영','governance'),('반례','negativeEvidence'),('전이 실험','terminalExperiment')])
 add()
add('## 부록 F. 접근 실패·조사 공백\n\n'+table(['후보','확인 실패','URL'],[(x['name'],x['reason'],'['+x['name']+']('+x['url']+')') for x in D['attemptedButUnverified']]))
add('\n네 후보는 분석 완료 사례 수에 포함하지 않았다. 일부 83개 사례도 본문 접근 제한으로 limited다. 소개만 읽은 사례를 실제 구성원 활동 확인으로 제시하지 않는다. 로그인 내부·비공개 모임·언어권·지역별 대표성·이탈자 표본을 포괄하지 못했다. 웹 전체의 전수 조사라고 주장하지 않는다.\n')
add(table(['근거 구분','레코드 수'],[(level[k],v) for k,v in collections.Counter(x['evidenceLevel'] for x in D['communities']).items()]))
add('\n고유 출처 URL '+str(D['meta']['sourceCount'])+'개. 모두 직접 접근에 성공한 링크 수나 독립 문헌 수는 아니다. 검색 색인·본문 접근 제한은 해당 항목에 기록했다.\n')
add('### 권고의 경계\n\n공동 제작 터미널 마을을 우선 실험한다. 기존 방을 모두 유지하거나 터미널 진입 마찰을 무시하는 제안은 아니다. 회원끼리 사용·변형·반응이 생기지 않으면 이 추천을 철회할 수 있다.\n')
report='\n'.join(parts);(P.parent/'research-report.md').write_text(report);D['reportMarkdown']=report
for path in [P/'data.json',P.parent/'research-data.json']:path.write_text(json.dumps(D,ensure_ascii=False,indent=2)+'\n')
print('Report chars',len(report),'embedded Markdown ready')
