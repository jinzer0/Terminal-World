from pathlib import Path
import re,json,zipfile,hashlib
root=Path(__file__).resolve().parents[2];docs=root/'docs'
r=(docs/'requirements-analysis.md').read_text();m=(docs/'analysis-models.md').read_text()
fr={x[0]:set(re.findall(r'UC-\d+',x[1])) for x in re.findall(r'^\| (FR-\d+) \| (.*)$',r,re.M)}
uc={}
for match in re.finditer(r'^### (UC-\d+) .*?\n(.*?)(?=^### UC-|^## 3\.|\Z)',m,re.M|re.S):
 name,body=match.groups();uc[name]=set(re.findall(r'FR-\d+',re.search(r'관련 요구사항:\*\* ([^\n]+)',body).group(1)))
 for label in ['주 액터','목표·트리거','사전조건','성공 사후조건','기본 흐름','대안 흐름','예외 흐름','실패 사후조건']:assert label in body,(name,label)
assert len(fr)==30 and len(uc)==18,(len(fr),len(uc))
for f,us in fr.items():
 for u in us:assert f in uc[u],(f,u,'missing reverse')
for u,fs in uc.items():
 for f in fs:assert u in fr[f],(u,f,'missing reverse')
blocks=re.findall(r'```mermaid\n(.*?)```',m,re.S)
for name,block in zip(['use-case','domain-model'],blocks):assert block.strip()==(docs/'diagrams'/f'{name}.mmd').read_text().strip()
for ext in ['mmd','puml']:
 d=(docs/'diagrams'/f'use-case.{ext}').read_text();assert set(re.findall(r'UC-\d+',d))==set(uc)
mm=(docs/'diagrams/domain-model.mmd').read_text();pu=(docs/'diagrams/domain-model.puml').read_text()
assert set(re.findall(r'class (\w+)',mm))==set(re.findall(r'class (\w+)',pu))
relations=lambda s:{l.strip() for l in s.splitlines() if re.search(r'--|<\|',l)}
assert relations(mm)==relations(pu)
for path in docs.rglob('*'):
 if path.suffix not in ['.md','.mmd','.puml']:continue
 t=path.read_text();assert t.count('```')%2==0,path
 if path.suffix=='.md':
  for target in re.findall(r'\]\(([^)]+)\)',t):
   if '://' not in target and not target.startswith('#'):assert (path.parent/target.split('#')[0]).exists(),(path,target)
  table=[]
  for line in t.splitlines()+['']:
   if line.startswith('|'):
    count=len(re.split(r'(?<!\\)\|',line));table.append(count)
   elif table:
    assert len(set(table))==1,(path,table);table=[]
# Prior decision records and source code remain unchanged.
with zipfile.ZipFile(root/'research/requirements-update-2026-11-02/requirement-analysis-before.zip') as old:
 for name in ['docs/2026-10-25.md','docs/2026-10-26.md','docs/2026-10-27.md']:assert old.read(name)==(root/name).read_bytes()
baseline=json.loads((root/'research/product-direction/original-hashes.json').read_text())
source_files=[f for f in baseline if f.startswith(('src/','tests/'))]
for f in source_files:assert hashlib.sha256((root/f).read_bytes()).hexdigest()==baseline[f],f
files=sorted(p for p in docs.rglob('*') if p.is_file() and p.suffix in ['.md','.mmd','.puml'])
archive=root/'requirement-analysis.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
 for p in files:z.write(p,p.relative_to(root))
with zipfile.ZipFile(archive) as z:
 assert z.testzip() is None
 for p in files:assert z.read(str(p.relative_to(root)))==p.read_bytes()
report={'date':'2026-11-02','functionalRequirements':len(fr),'useCases':len(uc),'checks':['bidirectional FR-UC traceability','UC required fields','embedded and standalone Mermaid parity','Mermaid/PlantUML domain concepts and relationships parity','diagram UC coverage','local document links and table structure','prior decision records unchanged','source files unchanged','ZIP integrity and byte parity'],'sourceFilesUnchanged':len(source_files),'zipFiles':len(files),'diagramRendering':'Not performed; model structure and textual parity checked','sha256':{str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in files}}
(root/'research/requirements-update-2026-11-02/verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({k:v for k,v in report.items() if k!='sha256'},ensure_ascii=False,indent=2))
