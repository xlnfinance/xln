import pathlib,json,subprocess,hashlib,stat,urllib.request,time,os,sys
r=pathlib.Path('/root/xln');base=pathlib.Path('/root/xln-deployment-evidence/996773462/backend-rollback');phase=sys.argv[1];assert phase in ['rollback','restore'],'EXACT_PHASE_REQUIRED'
current='9967734624cd70bebf4bb60992791efc5a36cdc5';previous='efb6f5d4181114457cf3d62077c5d624b9fef9b3';source,target=(current,previous) if phase=='rollback' else (previous,current)
assert len(sys.argv)==3 and sys.argv[2]==source,'EXACT_EXPECTED_SOURCE_REQUIRED'
out=base/phase;pin='/root/.local/share/xln/toolchains/bun-1.4.0/bun';started=time.monotonic();steps=[]
def step(name):
 record={'step':name,'elapsedSeconds':round(time.monotonic()-started,3),'at':int(time.time()*1000)};steps.append(record);(out/'switch-progress.json').write_text(json.dumps(steps,indent=2)+'\n');print(json.dumps(record),flush=True)
def run(args,timeout=10):return subprocess.check_output(args,cwd=r,text=True,timeout=timeout)
def health():
 with urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=2) as f:return json.load(f)
def pm2():return json.loads(run(['pm2','jlist']))
def protected():
 for n,v in json.loads(pathlib.Path('/root/xln-deployment-evidence/f3a14e652/private-preservation.json').read_text())['files'].items():
  p=pathlib.Path(n);assert hashlib.sha256(p.read_bytes()).hexdigest()==v['sha256'] and stat.S_IMODE(p.stat().st_mode)==v['mode'],'PROTECTED_FILE_CHANGED'
def clean(expected):
 assert run(['git','rev-parse','HEAD']).strip()==expected,'SOURCE_HEAD_CHANGED'
 assert run(['git','symbolic-ref','--short','HEAD']).strip()=='main','MAIN_REQUIRED'
 assert not run(['git','status','--porcelain=v1','--untracked-files=all']),'DIRTY_SOURCE'
 assert not any(line[:1].islower() or line.startswith('S ') for line in run(['git','ls-files','-v']).splitlines()),'HIDDEN_INDEX_PATH'
def descendants(pid):
 rows={}
 for p in pathlib.Path('/proc').glob('[0-9]*/status'):
  try: rows[int(p.parent.name)]=int(next(x.split()[1] for x in p.read_text().splitlines() if x.startswith('PPid:')))
  except (OSError,StopIteration):pass
 result={pid}
 while True:
  added={child for child,parent in rows.items() if parent in result}-result
  if not added:return sorted(result)
  result|=added
clean(source);assert not (out/'switch-progress.json').exists(),'DRILL_PHASE_ALREADY_STARTED'
assert not pathlib.Path('/var/lib/xln/rdb/core/.mesh-reset-once').exists();protected()
proof=json.loads((base/'compatibility.json').read_text());assert (proof['current'],proof['previous'])==(current,previous)
assert not run(['git','diff','--name-only',previous,current,'--',*proof['unchangedProtocolStorageContractRuntimePaths']]),'DURABLE_OR_CONTRACT_CHANGE'
run(['git','merge-base','--is-ancestor',previous,current]);run(['git','merge-base','--is-ancestor',current,'origin/main']);run(['git','bundle','verify',str(base/'source.bundle')])
for n in run(['git','diff','--name-only','--diff-filter=A',source,target]).splitlines():assert not os.path.lexists(r/n),'UNTRACKED_TARGET_COLLISION:'+n
rows=pm2();server=next(x for x in rows if x['name']=='xln-server');e=server['pm2_env'];expected_pid=1069917 if phase=='rollback' else json.loads((base/'rollback'/'switch-result.json').read_text())['newServerPid']
assert e['status']=='online' and e['pm_cwd']==str(r) and e['pm_exec_path']==str(r/'scripts/operations/start-server.sh')
assert server['pid']==expected_pid,'SERVER_OWNER_CHANGED';owned=descendants(expected_pid)
assert all(os.readlink('/proc/'+str(pid)+'/exe')==pin for pid in owned),'OWNED_EXECUTABLE_CHANGED'
assert e['treekill'] is False and e.get('kill_timeout')==60000,'BASELINE_POLICY_CHANGED'
unrelated={x['name']:{'pid':x['pid'],'status':x['pm2_env']['status']} for x in rows if x['name']!='xln-server'}
h=health();assert h['coreOk'] and h['systemOk'] and h['source']['gitHead']==source and not h['source']['dirty']
assert h['marketMaker']['quiescence']=={'accountMempoolTxs':0,'pendingAccountFrames':0,'pendingRuntimeWork':0}
assert (out/'before.json').is_file() and (base/'previous-web.tar.gz').is_file(),'PRESERVATION_MISSING'
errorlog=pathlib.Path(e['pm_err_log_path']);logstat=errorlog.stat();offset=logstat.st_size;step('guards-and-preservation-confirmed')
# Stop only the already identified managed owner, allowing its canonical drain.
print(run(['pm2','stop','xln-server'],20),flush=True)
assert all(not pathlib.Path('/proc',str(pid)).exists() for pid in owned),'OWNED_PROCESS_REMAINS'
step('owned-runtime-tree-drained');clean(source);protected()
# Both commits are preserved by the verified bundle/origin ancestry. No hard
# reset, clean, force push, new branch/worktree, data or credential mutation.
if phase=='rollback':print(run(['git','reset','--keep',target]),flush=True)
else:print(run(['git','-c','merge.autostash=false','merge','--ff-only','--no-overwrite-ignore',target]),flush=True)
clean(target);step('exact-compatible-source-selected')
print(run(['pm2','restart','xln-server','--no-treekill','--kill-timeout','60000'],10),flush=True);step('same-managed-runtime-started')
while time.monotonic()-started<53:
 try:
  h=health()
  if h['coreOk'] and h['systemOk']:break
 except (OSError,ValueError):pass
 time.sleep(.5)
else:raise RuntimeError('COMPATIBLE_RELEASE_NOT_READY_WITHIN_OBSERVATION_BUDGET')
step('current-checkpoint-wal-recovery-ready');protected();clean(target)
assert h['source']['gitHead']==target and not h['source']['dirty'],'RUNNING_SOURCE_MISMATCH'
rows=pm2();now=next(x for x in rows if x['name']=='xln-server')
for x in rows:
 if x['name'] in unrelated:assert unrelated[x['name']]=={'pid':x['pid'],'status':x['pm2_env']['status']},'UNRELATED_OWNER_CHANGED'
new_owned=descendants(now['pid']);assert all(os.readlink('/proc/'+str(pid)+'/exe')==pin for pid in new_owned)
expected_web=json.loads((base/'preflight.json').read_text())['webFiles']
web={str(p.relative_to(r)):hashlib.sha256(p.read_bytes()).hexdigest() for root in ['frontend/build','ui/dist'] for p in (r/root).rglob('*') if p.is_file()};assert web==expected_web,'WEB_BYTES_CHANGED'
assert errorlog.stat().st_ino==logstat.st_ino and errorlog.stat().st_size>=offset,'ERROR_LOG_ROTATED'
with errorlog.open('rb') as f:f.seek(offset);delta=f.read()
log=out/'private-shutdown-error.log';log.write_bytes(delta);log.chmod(0o600)
text=delta.decode(errors='replace');markers={n:text.count(n) for n in ['NAPI FATAL ERROR','Bun has crashed','panic:','quiesce.post_failed','quiesce.refused','shutdown failed:','child.stop_timeout_sigkill']}
result={'source':source,'target':target,'elapsedSeconds':round(time.monotonic()-started,3),'managedRecoveryDurationMs':h['reset']['completedAt']-h['reset']['startedAt'],'dataReset':False,'oldServerPid':expected_pid,'newServerPid':now['pid'],'ownedBefore':owned,'ownedAfter':new_owned,'pinnedBun':pin,'protectedFilesUnchanged':True,'unrelatedProcessesUnchanged':True,'webFilesUnchanged':len(web),'failureMarkers':markers,'errorDeltaSha256':hashlib.sha256(delta).hexdigest(),'stages':steps}
(out/'switch-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result),flush=True);assert not any(markers.values()),'SHUTDOWN_DIVERGENCE'
