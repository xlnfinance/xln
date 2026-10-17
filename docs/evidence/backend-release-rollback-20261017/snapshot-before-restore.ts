import { RemoteRuntimeAdapter } from '/root/xln/core/api/runtime-adapter/remote';
import type { RuntimeAdapterViewFrame } from '/root/xln/core/api/public/runtime-module';
import type { RuntimeAdapterFrameSummary } from '/root/xln/core/api/runtime-adapter/resolve';
import { safeStringify } from '/root/xln/core/protocol/serialization';
import { writeFileSync, readFileSync } from 'node:fs';
import { strict as assert } from 'node:assert';
const out='/root/xln-deployment-evidence/996773462/backend-rollback/restore';const phase=process.argv[2];assert(phase==='before'||phase==='after');
const health=await(await fetch('http://127.0.0.1:8080/api/health')).json();assert(health.coreOk&&health.systemOk);assert.equal(health.source.gitHead,'efb6f5d4181114457cf3d62077c5d624b9fef9b3');assert.equal(health.source.dirty,false);
const accessResponse=await fetch('http://127.0.0.1:8080/api/runtime-import?access=admin');assert.equal(accessResponse.status,200,'OPERATOR_MANIFEST_DENIED');const access=await accessResponse.json();assert.equal(access.ok,true);
const previous=phase==='after'?JSON.parse(readFileSync(out+'/before.json','utf8')):null;const hubs=[];
for(const hub of health.hubs){
 const adapter=new RemoteRuntimeAdapter();
 try{
  const entryAccess=access.manifest.entries.find((e:any)=>e.label===hub.name);assert(entryAccess&&typeof entryAccess.token==='string','HUB_INSPECT_CAPABILITY_MISSING');
  await adapter.connect({mode:'remote',authKey:entryAccess.token,runtimeId:hub.runtimeId,wsUrl:`ws://127.0.0.1:${hub.apiPort}/rpc`,requestTimeoutMs:5000});
  const current=await adapter.read<RuntimeAdapterViewFrame>('view-frame',{entityId:hub.entityId,accountsLimit:100});assert(current.activeEntity);assert.equal(current.activeEntity.accounts.nextCursor,null,'ACCOUNTS_TRUNCATED');
  const accounts=current.activeEntity.accounts.items.map(a=>{assert.equal(Boolean(a.pendingFrame),false,'PENDING_ACCOUNT');assert.equal(a.mempoolCount,0,'ACCOUNT_MEMPOOL');return {left:a.state.leftEntity,right:a.state.rightEntity,height:a.currentHeight,root:a.currentFrame.accountStateRoot,balances:Array.from(a.state.deltas,([tokenId,d])=>({tokenId,collateral:String(d.collateral),ondelta:String(d.ondelta),offdelta:String(d.offdelta),leftCreditLimit:String(d.leftCreditLimit),rightCreditLimit:String(d.rightCreditLimit)})).sort((a,b)=>a.tokenId-b.tokenId)};}).sort((a,b)=>(a.left+a.right).localeCompare(b.left+b.right));
  const prior=previous?.hubs.find((h:any)=>h.name===hub.name);const height=prior?.height??current.height;
  const frame=await adapter.read<RuntimeAdapterFrameSummary>(`frame/${height}`);
  const entry={name:hub.name,runtimeId:adapter.runtimeId,entityId:hub.entityId,height:current.height,historicalFrame:{height:frame.height,frameHash:frame.frameHash,postStateHash:frame.postStateHash},accounts};
  if(prior){writeFileSync(out+'/comparison-'+hub.name+'.json',safeStringify({actual:entry,expected:prior},null,2)+'\n');assert(current.height>=prior.height,'RUNTIME_HEIGHT_REGRESSED');assert.deepEqual(entry.historicalFrame,prior.historicalFrame,'COMMITTED_FRAME_CHANGED');assert.deepEqual(accounts,prior.accounts,'FINANCIAL_ACCOUNTS_CHANGED');}
  hubs.push(entry);
 }finally{adapter.disconnect();}
}
assert.equal(hubs.length,3);writeFileSync(out+'/'+phase+'.json',safeStringify({phase,at:Date.now(),source:health.source,hubs},null,2)+'\n');console.log(safeStringify({phase,hubs:hubs.map(h=>({name:h.name,height:h.height,accounts:h.accounts.length,frameHash:h.historicalFrame.frameHash})),sameCommittedFramesAndAccounts:phase==='after'}));
