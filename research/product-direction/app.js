(() => {
  'use strict';
  const data = window.REPORT;
  if (!data || !Array.isArray(data.products) || !Array.isArray(data.ideas) || !Array.isArray(data.sources) || !Array.isArray(data.criteria)) return;
  const {products, ideas, sources, voices, criteria} = data;
  const $ = (id) => document.getElementById(id);
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeUrl = (url) => { try { const u = new URL(url); return ['http:', 'https:'].includes(u.protocol) ? u.href : ''; } catch { return ''; } };
  const bySource = new Map(sources.map(s => [s.id, s]));
  const byProduct = new Map(products.map(p => [p.id,p]));
  const byIdea = new Map(ideas.map(i => [i.id,i]));
  const baseWeights = criteria.map(c => Number(c.weight));
  let weights = [...baseWeights], marketFilter = 'all', marketSelected = [], ideaSelected = [], rankingCriterion = 'total';
  let scoreDetail = null, journeyIndex = 0, toastTimer, printState = null;
  const defaults = ['resume','help','runbook'];
  const categories = {community:'커뮤니티',terminal:'SSH·터미널',collaboration:'실시간 협업',focus:'집중·코워킹',productivity:'생산성'};
  const notify = msg => { const el=$('toast'); if(!el) return; el.textContent=msg; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),3000); };
  const srcLink = (id, label) => { const s=bySource.get(id); const url=s && safeUrl(s.url); return url ? `<a class="source-cite" href="${esc(url)}" target="_blank" rel="noopener noreferrer" title="${esc(s.title)} · 새 창">${esc(label || id)} ↗</a>` : ''; };
  const srcLinks = ids => (ids || []).map(id => srcLink(id)).join(' ');
  const score = (idea, w=weights) => { const total=w.reduce((a,b)=>a+b,0); return total ? idea.scores.reduce((a,x,i)=>a+Number(x)*w[i],0)/total*20 : 0; };
  const sorted = () => [...ideas].sort((a,b)=>score(b)-score(a) || a.name.localeCompare(b.name,'ko'));
  const n = x => Number(x).toFixed(1);
  const field = (label, value) => `<p><strong>${esc(label)}</strong> ${esc(value)}</p>`;
  const compareBlock = (title, items, fields, kind) => `<div class="section-head"><div><p class="eyebrow">COMPARE · 최대 3개</p><h3>${esc(title)}</h3></div><button type="button" class="button secondary" data-clear="${kind}">선택 지우기</button></div><div class="compare-grid">${items.map(item=>`<article class="compare-item"><h4>${esc(item.name)}</h4>${fields.map(([label,key])=>`<div class="compare-field"><strong>${esc(label)}</strong>${esc(item[key])}</div>`).join('')}<button type="button" class="button secondary" data-remove="${kind}" data-id="${esc(item.id)}">비교에서 제거</button></article>`).join('')}</div>`;
  function renderDock() { const dock=$('comparison-dock'),m=$('market-dock-link'),i=$('idea-dock-link'); if(!dock||!m||!i)return; dock.hidden=!marketSelected.length&&!ideaSelected.length; m.hidden=!marketSelected.length;i.hidden=!ideaSelected.length;m.textContent=`시장 ${marketSelected.length}개 비교 보기`;i.textContent=`아이디어 ${ideaSelected.length}개 비교 보기`; }
  function renderMarket() {
    const filtered=products.filter(p=>marketFilter==='all'||p.category===marketFilter);
    $('market-results').textContent=`${filtered.length}개 서비스 표시 · 비교 ${marketSelected.length}/3`;
    $('market-grid').innerHTML=filtered.length?filtered.map(p=>`<article class="market-card"><div class="card-body"><span class="badge inference">${esc(categories[p.category]||p.category)}</span><h3>${esc(p.name)}</h3>${field('해결할 문제:',p.problem)}<details><summary>사용 이유와 한계 살펴보기</summary>${field('핵심 사용자:',p.audience)}${field('선택 이유:',p.why)}${field('경험:',p.ux)}${field('반복 사용 · 해석:',p.repeat)}${field('강점:',p.strength)}${field('한계 · 해석:',p.limitation)}${field('Terminal World 시사점 · 해석:',p.implication)}${field('확인 상태:',p.status)}<p>${srcLinks(p.sources)}</p></details></div><div class="card-footer">${(p.sources||[]).filter(id=>bySource.get(id)?.type==='공식').slice(0,1).map(id=>srcLink(id,'공식 사이트')).join('')}<button type="button" class="button secondary" data-select-market="${esc(p.id)}" aria-pressed="${marketSelected.includes(p.id)}">${marketSelected.includes(p.id)?'비교 선택 해제':'비교에 추가'}</button></div></article>`).join(''):'<p class="empty">이 분류에 표시할 서비스가 없습니다.</p>';
    document.querySelectorAll('[data-market]').forEach(b=>{const on=b.dataset.market===marketFilter;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});
    const panel=$('market-compare'); panel.hidden=!marketSelected.length;
    if(marketSelected.length) panel.innerHTML=compareBlock('선택한 서비스',marketSelected.map(id=>byProduct.get(id)).filter(Boolean),[['사용자','audience'],['문제','problem'],['선택 이유','why'],['경험','ux'],['반복 사용','repeat'],['강점','strength'],['한계','limitation'],['시사점','implication'],['확인 상태','status']],'market');
    renderDock();
  }
  function renderVoices() { if (!$('voice-grid')) return; $('voice-grid').innerHTML=(voices||[]).map(v=>`<article class="market-card"><span class="badge ${(v.sources||[]).some(id=>bySource.get(id)?.type==='연구')?'inference':'hypothesis'}">${(v.sources||[]).some(id=>bySource.get(id)?.type==='연구')?'연구 결과':'개별 의견'}</span><h3>${esc(v.title)}</h3><p>${esc(v.observation)}</p>${field('해석의 한계:',v.limit)}<p>${srcLinks(v.sources)}</p></article>`).join(''); }
  const ideaFields=[['핵심 문제','problem'],['목표 사용자','audience'],['제안 솔루션','solution'],['사용 시나리오','scenario'],['차별화 가설','difference'],['터미널의 필요성','terminal'],['재방문 동기','return'],['콜드스타트','cold'],['구현','implementation'],['핵심 위험','risk']];
  function renderIdeas() {
    const cat=$('idea-category').value, strategy=$('idea-strategy').value, sort=$('idea-sort').value;
    let list=ideas.filter(i=>(cat==='all'||i.category===cat)&&(strategy==='all'||i.strategy===strategy));
    const idx={value:0,difference:2}[sort];
    list.sort((a,b)=>(sort==='score'?score(b)-score(a):sort==='easy'?a.difficulty-b.difficulty:b.scores[idx]-a.scores[idx]) || a.name.localeCompare(b.name,'ko'));
    const currentTop=new Set(sorted().slice(0,3).map(i=>i.id));
    $('idea-results').textContent=`${list.length}개 후보 표시 · 비교 ${ideaSelected.length}/3`;
    $('idea-grid').innerHTML=list.length?list.map(i=>`<article class="idea-card ${currentTop.has(i.id)?'recommended':''}"><div class="card-body"><div class="mini-stats"><span class="badge inference">${esc(i.category)}</span><span class="tag">${esc(i.strategy)}</span>${currentTop.has(i.id)?'<span class="badge hypothesis">현재 가중 상위 3</span>':''}</div><h3>${esc(i.name)}</h3><p class="card-subtitle">${esc(i.subtitle)}</p><p>${esc(i.problem)}</p><div class="mini-stats"><span class="score-badge">현재 ${n(score(i))}점</span><span class="score-badge">문제 ${esc(i.scores[0])}/5</span><span class="score-badge">차별성 ${esc(i.scores[2])}/5</span><span class="score-badge">난이도 ${esc(i.difficulty)}/5</span></div><details><summary>시나리오와 평가 근거 보기</summary><p><strong>확신 수준:</strong> ${esc(i.confidence)}</p><p><strong>근거의 성격:</strong> ${esc(i.evidenceNote)}</p>${ideaFields.map(([label,key])=>field(label+':',i[key])).join('')}<details><summary>9개 점수와 근거</summary>${criteria.map((c,k)=>`<p><strong>${esc(c.label)} ${esc(i.scores[k])}/5</strong> · ${esc(i.reasons[k])}</p>`).join('')}</details><p>${srcLinks(i.sources)}</p></details></div><div class="card-footer"><button type="button" class="button secondary" data-select-idea="${esc(i.id)}" aria-pressed="${ideaSelected.includes(i.id)}">${ideaSelected.includes(i.id)?'비교 선택 해제':'비교에 추가'}</button></div></article>`).join(''):'<p class="empty">조건에 맞는 후보가 없습니다. 필터를 바꿔 보세요.</p>';
    const panel=$('idea-compare'); panel.hidden=!ideaSelected.length;
    if(ideaSelected.length) panel.innerHTML=compareBlock('선택한 아이디어',ideaSelected.map(id=>byIdea.get(id)).filter(Boolean),[['문제','problem'],['대상','audience'],['솔루션','solution'],['차별성','difference'],['터미널','terminal'],['재방문','return'],['콜드스타트','cold'],['구현','implementation'],['위험','risk']],'idea');
    renderDock();
  }
  function bar(item, value, max, label) { return `<div class="bar-row"><span>${esc(item.name)}</span><div class="bar-track" role="img" aria-label="${esc(item.name)} ${esc(label)} ${esc(value)} / ${max}"><div class="bar-fill" style="width:${Math.max(0,Math.min(100,Number(value)/max*100))}%"></div></div><span class="bar-value">${esc(value)}</span></div>`; }
  function makeWeights() { $('weight-controls').innerHTML=criteria.map((c,i)=>`<label class="weight-row"><span class="weight-label">${esc(c.label)} <small>${esc(c.anchor||'')}</small></span><input type="range" min="0" max="30" step="1" value="${weights[i]}" data-weight="${i}" aria-label="${esc(c.label)} 가중치"><output class="weight-value" id="weight-value-${i}">${weights[i]}</output></label>`).join('')+'<p class="small" id="weight-status" aria-live="polite"></p>'; updateWeightStatus(); }
  function updateWeightStatus() { const sum=weights.reduce((a,b)=>a+b,0); $('weight-status').textContent=sum?`현재 가중치 합 ${sum} · 합계로 나누어 100점 만점으로 환산합니다.`:'가중치 합이 0이어서 점수를 계산할 수 없습니다. 기본값으로 복원했습니다.'; }
  function renderCharts() {
    const ranked=sorted();
    const shown=rankingCriterion==='total' ? ranked : [...ideas].sort((a,b)=>b.scores[Number(rankingCriterion)]-a.scores[Number(rankingCriterion)]||a.name.localeCompare(b.name,'ko'));
    const options=`<option value="total">가중 총점</option>`+criteria.map((c,i)=>`<option value="${i}" ${String(i)===rankingCriterion?'selected':''}>${esc(c.label)}</option>`).join('');
    $('ranking-chart').innerHTML=`<label>막대 비교 기준 <select id="ranking-select">${options}</select></label>${shown.map(i=>bar(i,rankingCriterion==='total'?n(score(i)):i.scores[Number(rankingCriterion)],rankingCriterion==='total'?100:5,rankingCriterion==='total'?'가중 총점':criteria[Number(rankingCriterion)].label)).join('')}`;
    $('strategy-chart').innerHTML=['world','resume','help'].map(id=>byIdea.get(id)).filter(Boolean).map(i=>bar(i,n(score(i)),100,'대표 후보 가중 총점')).join('');
    const heads=criteria.map(c=>`<th scope="col">${esc(c.label)}</th>`).join('');
    $('score-matrix').innerHTML=`<table><thead><tr><th scope="col">후보</th>${heads}<th scope="col">가중 점수</th></tr></thead><tbody>${ideas.map(i=>`<tr><th scope="row">${esc(i.name)}</th>${i.scores.map((v,k)=>`<td data-label="${esc(criteria[k].label)}"><button type="button" class="score-badge" data-score-id="${esc(i.id)}" data-score-index="${k}" aria-label="${esc(i.name)} ${esc(criteria[k].label)} ${v}점 근거 보기">${v}/5</button></td>`).join('')}<td data-label="가중 점수">${n(score(i))}</td></tr>`).join('')}</tbody></table><div id="score-detail" class="notice" aria-live="polite">${scoreDetail?scoreDetailHtml(): '점수를 선택하면 해당 판단의 근거가 여기에 표시됩니다.'}</div>`;
    const baseRank=[...ideas].sort((a,b)=>score(b,baseWeights)-score(a,baseWeights));
    $('top-three').innerHTML=defaults.map((id,k)=>{const i=byIdea.get(id);if(!i)return '';const position=ranked.findIndex(x=>x.id===id)+1;return `<article class="ranked-card"><span class="rank-number">0${k+1}</span><span class="badge inference">기본 가중치 ${k+1}위</span><h3>${esc(i.name)}</h3><p>${esc(i.subtitle)}</p><p><strong>기본 ${n(score(i,baseWeights))}점</strong> · 현재 ${n(score(i))}점 / ${position}위</p><p>${esc(i.difference)}</p><p><strong>실패 위험:</strong> ${esc(i.risk)}</p><p>${srcLinks(i.sources)}</p></article>`;}).join('')+`<p class="small">기본 순위는 고정하여 보여줍니다. 현재 가중치 순위: ${ranked.slice(0,3).map(i=>esc(i.name)).join(' → ')}. ${ranked.slice(0,3).map(i=>i.id).join(',')===baseRank.slice(0,3).map(i=>i.id).join(',')?'기본 순위와 같습니다.':'기본 순위와 달라졌습니다.'}</p>`;
  }
  function scoreDetailHtml() { const i=byIdea.get(scoreDetail.id), k=scoreDetail.index; return i&&criteria[k] ? `<strong>${esc(i.name)} · ${esc(criteria[k].label)} ${esc(i.scores[k])}/5</strong><p>${esc(i.reasons[k])}</p><p>${esc(i.confidence)}</p>` : ''; }
  function renderSources() {
    const filter=$('source-filter').value, q=$('source-search').value.trim().toLocaleLowerCase();
    const list=sources.filter(s=>(filter==='all'||s.type===filter)&&[s.title,s.url,s.note,s.id].join(' ').toLocaleLowerCase().includes(q));
    $('source-count').textContent=`${list.length} / ${sources.length}개 출처`;
    $('source-list').innerHTML=list.length?list.map(s=>`<article class="source-item"><span class="badge ${s.type==='공식'?'fact':s.type==='연구'?'inference':'hypothesis'}">${esc(s.type)}</span> <strong>${esc(s.id)}</strong><h3><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)} ↗</a></h3><p>${esc(s.note)}</p><p class="source-meta">발행: ${esc(s.date)} · 확인: ${esc(s.checked)}</p><p class="source-url">${esc(s.url)}</p></article>`).join(''):'<p class="empty">검색 결과가 없습니다.</p>';
  }
  function attachCitations() { document.querySelectorAll('[data-source]').forEach(el=>{const s=bySource.get(el.dataset.source),url=s&&safeUrl(s.url);if(!url)return;const a=document.createElement('a');a.className='source-cite';a.href=url;a.target='_blank';a.rel='noopener noreferrer';a.title=`${s.title} · 새 창`;a.textContent=el.textContent.trim() || s.id;el.replaceWith(a);}); }
  const journey=[
    ['발견','자신의 개인 Git 프로젝트를 학업 사이에 자주 중단하는 학생이 기존 메모가 불편할 때 도구의 가설을 발견한다.'],
    ['첫 2~5분','프로젝트를 선택하고 다음 행동 한 줄을 적는다. 표시되는 선택적 저장소 상태를 검토한 뒤 기록을 저장한다.'],
    ['48시간 이후','실제 작업으로 돌아온 학생이 메모와 저장 당시 대비 현재 Git 상태 차이를 읽고 다음 행동을 스스로 결정한다.'],
    ['일주일 뒤','또 다른 과제로 중단할 때 기록할 만큼 가치가 있었는지 확인한다. 별도의 알림이나 보상이 아니라 실제 프로젝트가 계기다.'],
    ['개인 검증','종료 기록 시간과 재개 시간의 합을 평소 Markdown 방식과 비교한다. 더 빠르거나 정확한지는 측정 전까지 가설이다.'],
    ['선택적 공유','도움이 필요할 때 사용자가 내용을 직접 고르고 민감정보를 확인해 동료에게 전달한다. 동료가 없어도 개인 핵심 과업은 가능하다.']
  ];
  function renderJourney(){ $('journey-buttons').innerHTML=journey.map((j,i)=>`<button type="button" class="journey-step ${i===journeyIndex?'active':''}" data-journey="${i}" aria-pressed="${i===journeyIndex}">${i+1}. ${esc(j[0])}</button>`).join(''); $('journey-content').innerHTML=`<article class="journey-card"><span class="badge hypothesis">사용 시나리오 · 검증 전</span><h4>${esc(journey[journeyIndex][0])}</h4><p>${esc(journey[journeyIndex][1])}</p></article>`; }
  const demo={capture:['[종료 기록 · 예시]\n프로젝트: study-app\n다음 행동: 로그인 실패 테스트 추가\n막힌 점: 만료 토큰 분기 확인\n선택한 기준: branch feature/login · 변경 파일 2개\n저장 완료 (시뮬레이션)','첫 2~5분: 사용자가 한 줄을 남기고 저장할 항목을 확인한다.'],resume:['[재개 · 예시]\n저장한 다음 행동: 로그인 실패 테스트 추가\n기록 당시 branch: feature/login\n현재 branch: feature/login\n상태: 기록 당시와 비교해 변경 사항 없음 (예시)\n다음 행동은 사용자가 직접 판단','48시간 이후: 메모와 현재 상태를 함께 보고 실제로 작업을 이어가는지 검증한다.'],drift:['[브랜치 변경 · 예시]\n기록 당시 branch: feature/login\n현재 branch: main\n주의: 브랜치가 달라 다음 행동이 현재 상태에 맞는지 확인 필요\n자동 전환·복원·명령 실행 없음','상태가 달라졌다는 사실을 보여줄 뿐, 변경의 의미를 자동으로 판단하지 않는다.']};
  function renderDemo(id) {const d=demo[id]; $('demo-terminal').textContent=d[0];$('demo-caption').textContent=d[1];document.querySelectorAll('[data-demo]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.demo===id)));}
  function toggleSelection(kind,id){const selected=kind==='market'?marketSelected:ideaSelected;const index=selected.indexOf(id);if(index>=0)selected.splice(index,1);else if(selected.length<3)selected.push(id);else {notify('비교는 최대 3개까지 선택할 수 있습니다.');return;} if(kind==='market')renderMarket();else renderIdeas();const attr=kind==='market'?'data-select-market':'data-select-idea';const target=[...document.querySelectorAll('['+attr+']')].find(el=>el.getAttribute(attr)===id);if(target)target.focus();else {const panel=$(kind==='market'?'market-compare':'idea-compare');if(!panel.hidden){const next=panel.querySelector('[data-remove], [data-clear]');if(next)next.focus();}else (kind==='market'?document.querySelector('[data-market].active'):$('idea-category')).focus();}}
  document.addEventListener('click', e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.market){marketFilter=b.dataset.market;renderMarket();}
    if(b.dataset.selectMarket)toggleSelection('market',b.dataset.selectMarket);
    if(b.dataset.selectIdea)toggleSelection('idea',b.dataset.selectIdea);
    if(b.dataset.clear){if(b.dataset.clear==='market'){marketSelected=[];renderMarket();(document.querySelector('[data-select-market]')||document.querySelector('[data-market].active')).focus();}else{ideaSelected=[];renderIdeas();(document.querySelector('[data-select-idea]')||$('idea-category')).focus();}}
    if(b.dataset.remove)toggleSelection(b.dataset.remove,b.dataset.id);
    if(b.dataset.journey!==undefined){journeyIndex=Number(b.dataset.journey);renderJourney();document.querySelector(`[data-journey="${journeyIndex}"]`)?.focus();}
    if(b.dataset.demo && demo[b.dataset.demo])renderDemo(b.dataset.demo);
    if(b.dataset.scoreId){scoreDetail={id:b.dataset.scoreId,index:Number(b.dataset.scoreIndex)};const content=scoreDetailHtml();$('score-detail').innerHTML=content;$('score-dialog-body').innerHTML=content;$('score-dialog').showModal();}
  });
  document.addEventListener('change',e=>{
    if(['idea-category','idea-strategy','idea-sort'].includes(e.target.id))renderIdeas();
    if(e.target.id==='ranking-select'){rankingCriterion=e.target.value;renderCharts();$('ranking-select').focus();}
    if(e.target.id==='source-filter')renderSources();
  });
  document.addEventListener('input',e=>{
    if(e.target.id==='source-search')renderSources();
    if(e.target.dataset.weight!==undefined){const k=Number(e.target.dataset.weight);weights[k]=Number(e.target.value);if(weights.every(x=>x===0)){weights=[...baseWeights];makeWeights();notify('가중치 합은 0일 수 없어 기본값을 복원했습니다.');}else {$('weight-value-'+k).textContent=weights[k];updateWeightStatus();}renderCharts();renderIdeas();}
  });
  $('reset-weights').addEventListener('click',()=>{weights=[...baseWeights];makeWeights();renderCharts();renderIdeas();notify('기본 가중치를 복원했습니다.');});
  let manualTheme = false; try { manualTheme = ['light','dark'].includes(localStorage.getItem('tw-research-theme')); } catch {}
  function setTheme(theme,persist){if(persist)manualTheme=true;document.documentElement.dataset.theme=theme;$('theme-toggle').setAttribute('aria-label',theme==='dark'?'라이트 모드로 전환':'다크 모드로 전환');if(persist)try{localStorage.setItem('tw-research-theme',theme);}catch{} }
  $('theme-toggle').addEventListener('click',()=>setTheme(document.documentElement.dataset.theme==='dark'?'light':'dark',true));
  const media=matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener?.('change',e=>{if(!manualTheme)setTheme(e.matches?'dark':'light',false);});
  setTheme(document.documentElement.dataset.theme|| (media.matches?'dark':'light'),false);
  const menu=$('menu-toggle'),sidebar=$('sidebar');
  const mobileMenu = () => window.innerWidth <= 900;
  function closeMenu(returnFocus=false){sidebar.classList.remove('open');sidebar.inert=mobileMenu();menu.setAttribute('aria-expanded','false');menu.setAttribute('aria-label','목차 열기');if(returnFocus&&mobileMenu())menu.focus({preventScroll:true});}
  menu.addEventListener('click',()=>{if(sidebar.classList.contains('open')){closeMenu(true);return;} sidebar.inert=false;sidebar.classList.add('open');menu.setAttribute('aria-expanded','true');menu.setAttribute('aria-label','목차 닫기');sidebar.querySelector('nav a')?.focus({preventScroll:true});});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&sidebar.classList.contains('open'))closeMenu(true);});
  sidebar.querySelectorAll('a').forEach(a=>a.addEventListener('click',()=>{const target=a.hash&&document.getElementById(a.hash.slice(1));closeMenu(false);if(target){target.tabIndex=-1;target.focus({preventScroll:true});}}));
  window.addEventListener('resize',()=>{if(!mobileMenu())closeMenu(false);else if(!sidebar.classList.contains('open'))sidebar.inert=true;});
  closeMenu(false);
  const navLinks=[...sidebar.querySelectorAll('nav a')], sections=navLinks.map(a=>document.getElementById(a.hash.slice(1))).filter(Boolean);
  function updateNav(){let current=sections[0];for(const s of sections){if(s.getBoundingClientRect().top<=130)current=s;}navLinks.forEach(a=>{const active=a.hash==='#'+current?.id;a.classList.toggle('active',active);if(active){a.setAttribute('aria-current','location');$('current-section').textContent=a.textContent.replace(/^\s*\d+\s*/,'').trim();}else a.removeAttribute('aria-current');});}
  let scrollPending=false;window.addEventListener('scroll',()=>{if(!scrollPending){scrollPending=true;requestAnimationFrame(()=>{updateNav();scrollPending=false;});}},{passive:true});
  function labelTables(){document.querySelectorAll('.responsive-table table').forEach(table=>{const heads=[...table.querySelectorAll('thead th')].map(th=>th.textContent.trim());table.querySelectorAll('tbody tr').forEach(tr=>[...tr.children].forEach((cell,i)=>{if(cell.tagName==='TD'&&!cell.hasAttribute('data-label'))cell.dataset.label=heads[i]||'';}));});}
  const printIds=['market-grid','market-results','market-compare','idea-grid','idea-results','idea-compare','source-list','source-count'];
  window.addEventListener('beforeprint',()=>{if(printState)return; printState={marketFilter,cat:$('idea-category').value,strategy:$('idea-strategy').value,sort:$('idea-sort').value,source:$('source-filter').value,search:$('source-search').value,details:[...document.querySelectorAll('details')].map(d=>[d,d.open]),html:Object.fromEntries(printIds.map(id=>[id,{html:$(id).innerHTML,hidden:$(id).hidden}]))};marketFilter='all';$('idea-category').value='all';$('idea-strategy').value='all';$('source-filter').value='all';$('source-search').value='';renderMarket();renderIdeas();renderSources();document.querySelectorAll('details').forEach(d=>d.open=true);labelTables();});
  window.addEventListener('afterprint',()=>{if(!printState)return; const s=printState;printState=null;marketFilter=s.marketFilter;$('idea-category').value=s.cat;$('idea-strategy').value=s.strategy;$('idea-sort').value=s.sort;$('source-filter').value=s.source;$('source-search').value=s.search;for(const [id,v] of Object.entries(s.html)){$(id).innerHTML=v.html;$(id).hidden=v.hidden;}s.details.forEach(([d,open])=>{if(d.isConnected)d.open=open;});document.querySelectorAll('[data-market]').forEach(b=>{const on=b.dataset.market===marketFilter;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));});labelTables();});
  $('score-dialog-close').addEventListener('click',()=>$('score-dialog').close());
  $('print-button').addEventListener('click',()=>window.print());
  $('product-count').textContent=String(products.length);
  attachCitations();renderMarket();renderVoices();renderIdeas();makeWeights();renderCharts();renderSources();renderJourney();renderDemo('capture');labelTables();updateNav();
})();
