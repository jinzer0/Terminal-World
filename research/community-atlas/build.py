#!/usr/bin/env python3
"""Build the self-contained Community Atlas. Python standard library only."""
import json
import re
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent
GROUPS = [('knowledge', '지식·기술'), ('creative', '창작·취향'), ('learning', '학습·공동 성과'), ('korea', '한국 커뮤니티'), ('terminal', '터미널·가상 세계')]
REQUIRED = ['id', 'name', 'description', 'url', 'status', 'statusEvidence', 'job', 'firstValue', 'repeatLoop', 'exchange', 'coldStart', 'friction', 'transfer', 'terminalFit', 'sources', 'notes']
LANDSCAPE = '''<section class="section" id="landscape" aria-labelledby="landscape-title">
<div class="section-head"><p class="eyebrow">02 / COMMUNITY LANDSCAPE</p><h2 id="landscape-title">유명한 공간에서, 작은 교환의 원리까지</h2><p class="section-lead">서비스를 복제하기보다 사용자가 무엇을 주고받고 왜 돌아오는지 비교한다. 카드를 펼치면 근거와 해석의 경계를 확인할 수 있다.</p></div>
<div class="notice"><strong>읽는 법</strong><p>심층 조사는 더 자세한 근거를 확보한 대상을 뜻하며, 제품 우수성 순위가 아니다. ‘이식할 원리’와 ‘터미널 적합성’은 분석이며 실제 수요는 추가 검증이 필요하다.</p></div>
<div class="atlas-controls"><div id="category-filters" class="category-filters" role="group" aria-label="커뮤니티 분류"></div><div class="search-row"><label class="search-field"><span aria-hidden="true">⌕</span><span class="sr-only">커뮤니티 검색</span><input id="community-search" type="search" placeholder="이름, 과업, 교환 방식으로 검색" autocomplete="off"></label><label class="deep-control"><input type="checkbox" id="deep-only"> 심층 조사만 보기</label></div></div>
<div class="list-meta"><p id="community-count" role="status" aria-live="polite"></p><p>최대 3개를 선택해 같은 기준으로 비교</p></div><div class="community-grid" id="community-grid"></div></section>'''
SOURCES = '''<section class="section" id="sources" aria-labelledby="sources-title"><div class="section-head"><p class="eyebrow">08 / EVIDENCE & LIMITS</p><h2 id="sources-title">주장까지 추적하는 근거 지도</h2><p class="section-lead">같은 URL이라도 뒷받침하는 주장이 다르면 각각 보존했다. 공식 문서의 접근 가능성과 실제 서비스의 정상 운영·활성 이용·유지율은 서로 다른 사실이다.</p></div><div class="notice"><p>공개 웹 자료는 선택 편향이 있다. 사용자 의견은 개별 사례이며 전체 이용자를 대표하지 않는다. 제품 간 유지율과 수요 크기를 추정하지 않았다. 실제 고객 인터뷰와 행동 실험은 이 보고서 이후의 검증 과제다.</p></div><div class="search-row atlas-controls"><label class="search-field"><span aria-hidden="true">⌕</span><span class="sr-only">출처 검색</span><input type="search" id="source-search" placeholder="서비스·자료 제목·주장 검색"></label><label>자료 유형 <select id="source-filter"><option value="all">전체 유형</option></select></label></div><p class="list-meta" id="source-count" role="status" aria-live="polite"></p><div class="source-list" id="source-list"></div><div class="section-head"><h3>조사 발견과 범위 원자료</h3><p>분류별 발견, 검색 질의, 제외 항목과 한계를 원래 구조대로 확인한다. 문장·객체가 혼합된 기록도 생략하지 않는다.</p></div><div id="research-appendix"></div></section>'''

class Audit(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
        self.anchors = []
        self.external_assets = []
    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if 'id' in attrs: self.ids.append(attrs['id'])
        if tag == 'a' and attrs.get('href', '').startswith('#'): self.anchors.append(attrs['href'][1:])
        if tag in ('script', 'link', 'img') and (attrs.get('src') or attrs.get('href')):
            self.external_assets.append(attrs.get('src') or attrs.get('href'))

def main():
    groups, communities, ids = [], [], set()
    for group_id, title in GROUPS:
        path = ROOT / f'{group_id}.json'
        if not path.exists(): raise SystemExit(f'Missing research input: {path.name}')
        bundle = json.loads(path.read_text())
        for community in bundle['communities']:
            missing = [key for key in REQUIRED if key not in community]
            if missing: raise SystemExit(f"{community.get('id')}: missing {missing}")
            if community['id'] in ids: raise SystemExit(f"Duplicate community id: {community['id']}")
            ids.add(community['id'])
            for url in [community['url'], *[s['url'] for s in community['sources']]]:
                if urlparse(url).scheme not in ('http', 'https'): raise SystemExit(f'Unsafe URL: {url}')
            communities.append({**community, 'groupId': group_id, 'groupTitle': title})
        groups.append({'id': group_id, 'title': title, 'findings': bundle.get('findings', []), 'coverage': bundle.get('coverage', {}), 'communities': bundle['communities']})
    parts = ['analysis-head.html', 'analysis-directions.html', 'analysis-tail.html']
    for part in parts:
        if not (ROOT / part).exists(): raise SystemExit(f'Missing research input: {part}')
    analysis = '\n'.join((ROOT / part).read_text() for part in parts)
    (ROOT / 'analysis.html').write_text(analysis)
    if analysis.count('<!--LANDSCAPE-->') != 1: raise SystemExit('analysis.html must contain exactly one <!--LANDSCAPE--> marker')
    content = analysis.replace('<!--LANDSCAPE-->', LANDSCAPE) + SOURCES
    payload = {'checkedAt': '2026-10-30', 'groups': groups, 'communities': communities}
    packed = json.dumps(payload, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\/').replace('\u2028', '\\u2028').replace('\u2029', '\\u2029')
    html = (ROOT / 'shell.html').read_text()
    for marker, value in [('<!-- CONTENT -->', content), ('/* INLINE_CSS */', (ROOT / 'style.css').read_text()), ('/* INLINE_DATA */', packed), ('/* INLINE_JS */', (ROOT / 'app.js').read_text())]:
        if html.count(marker) != 1: raise SystemExit(f'Expected exactly one marker: {marker}')
        html = html.replace(marker, value)
    audit = Audit(); audit.feed(html)
    duplicate = {i for i in audit.ids if audit.ids.count(i) > 1}
    if duplicate: raise SystemExit(f'Duplicate HTML IDs: {duplicate}')
    missing = set(audit.anchors) - set(audit.ids)
    if missing: raise SystemExit(f'Missing anchor targets: {missing}')
    for section in ['overview','landscape','mechanisms','directions','recommendation','mvp','validation','sources']:
        if section not in audit.ids: raise SystemExit(f'Missing report section: {section}')
    if audit.external_assets: raise SystemExit(f'Unexpected external runtime assets: {audit.external_assets}')
    if re.search(r'/\* INLINE_|<!-- CONTENT -->|<!--LANDSCAPE-->', html): raise SystemExit('Unresolved build marker')
    target = ROOT / 'index.html'; target.write_text(html)
    sources = [s for c in communities for s in c['sources']]
    print(json.dumps({'output': str(target), 'bytes': target.stat().st_size, 'communities': len(communities), 'deep': sum(c.get('depth') == 'deep' for c in communities), 'sourceRecords': len(sources), 'uniqueSourceUrls': len({s['url'] for s in sources}), 'findings': sum(len(g['findings']) for g in groups), 'groups': len(groups), 'staticValidation': 'passed'}, ensure_ascii=False, indent=2))

if __name__ == '__main__': main()
