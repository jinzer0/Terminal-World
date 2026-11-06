import json, concurrent.futures, urllib.request, urllib.error
from pathlib import Path
P=Path(__file__).parent
sources=json.loads(P.joinpath('research-data.json').read_text())['sources']
def check(s):
 req=urllib.request.Request(s['url'],headers={'User-Agent':'Mozilla/5.0'})
 try:
  with urllib.request.urlopen(req,timeout=15) as r:
   r.read(256)
   return {'id':s['id'],'url':s['url'],'status':r.status,'finalUrl':r.url}
 except urllib.error.HTTPError as e: return {'id':s['id'],'url':s['url'],'status':e.code,'note':'HTTP access restriction or failure; source reading was done separately through web research.'}
 except Exception as e: return {'id':s['id'],'url':s['url'],'status':None,'note':type(e).__name__}
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex: result=list(ex.map(check,sources))
P.joinpath('link-check.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'total':len(result),'http2xx':sum(200<=r['status']<300 for r in result if r['status']),'restrictedOrFailed':[{'id':r['id'],'status':r['status'],'note':r.get('note')} for r in result if not r['status'] or r['status']>=300]},ensure_ascii=False))
