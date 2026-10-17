import pathlib,json,subprocess,hashlib,stat,urllib.request,tarfile,os
r=pathlib.Path('/root/xln');out=pathlib.Path('/root/xln-deployment-evidence/996773462/backend-rollback')
def run(*a):return subprocess.check_output(a,cwd=r,text=True,timeout=25).strip()
def protected():
 for n,v in json.loads(pathlib.Path('/root/xln-deployment-evidence/f3a14e652/private-preservation.json').read_text())['files'].items():
  p=pathlib.Path(n);assert hashlib.sha256(p.read_bytes()).hexdigest()==v['sha256'] and stat.S_IMODE(p.stat().st_mode)==v['mode'],'PROTECTED_FILE_CHANGED'
assert run('git','rev-parse','HEAD')=='9967734624cd70bebf4bb60992791efc5a36cdc5'
assert run('git','branch','--show-current')=='main' and not run('git','status','--porcelain=v1','--untracked-files=all')
assert not (out/'preflight.json').exists() and not (out/'previous-web.tar.gz').exists(),'PRESERVATION_ALREADY_EXISTS'
assert not pathlib.Path('/var/lib/xln/rdb/core/.mesh-reset-once').exists();protected()
assert not any(line[:1].islower() or line.startswith('S ') for line in run('git','ls-files','-v').splitlines()),'HIDDEN_INDEX_PATH'
apps=json.loads(run('pm2','jlist'));server=next(x for x in apps if x['name']=='xln-server');assert server['pid']==1069917 and server['pm2_env']['status']=='online';assert os.readlink('/proc/1069917/exe')=='/root/.local/share/xln/toolchains/bun-1.4.0/bun'
request=urllib.request.Request('https://xln.finance/rpc',data=json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_chainId','params':[]}).encode(),headers={'Content-Type':'application/json'})
with urllib.request.urlopen(request,timeout=5) as response:assert json.load(response)['result']=='0x7a69'
print(run('/root/.local/share/xln/toolchains/bun-1.4.0/bun',str(out/'snapshot.ts'),'before'),flush=True)
run('git','bundle','create',str(out/'source.bundle'),'main','^90b4408c1a74b41e751820197b925c9f1d862c22')
run('git','bundle','verify',str(out/'source.bundle'))
run('git','merge-base','--is-ancestor','efb6f5d4181114457cf3d62077c5d624b9fef9b3','HEAD')
archive=out/'previous-web.tar.gz';run('bash','scripts/deployment/web-artifacts.sh','pack',str(archive))
expected={}
with tarfile.open(archive,'r:gz') as t:
 for m in t.getmembers():
  if m.isfile():
   f=t.extractfile(m);assert f;expected[m.name]=hashlib.sha256(f.read()).hexdigest()
actual={str(p.relative_to(r)):hashlib.sha256(p.read_bytes()).hexdigest() for root in ['frontend/build','ui/dist'] for p in (r/root).rglob('*') if p.is_file()};assert actual==expected,'WEB_ARCHIVE_BYTE_MISMATCH';protected()
rows=[{'name':x['name'],'pid':x['pid'],'status':x['pm2_env']['status'],'startedAt':x['pm2_env']['pm_uptime']} for x in apps]
result={'source':run('git','rev-parse','HEAD'),'chainId':31337,'serverPid':server['pid'],'processes':rows,'webArchive':str(archive),'webArchiveSha256':hashlib.sha256(archive.read_bytes()).hexdigest(),'webFiles':actual,'protectedFilesUnchanged':True,'dataReset':False}
(out/'preflight.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps({k:v for k,v in result.items() if k not in ['webFiles','processes']}|{'webFilesVerified':len(actual)}))
