// Proposed tests/e2e/recovery/e2e-brainvault-financial-recovery.spec.ts.
// Real local mesh, real sovereign H2, existing production adapter and operator kill.
import { allowDebugIncident, expect, test } from '../../global-setup.mts';
import { API_BASE_URL, ensureE2EBaseline, getHealth } from '../../utils/e2e-baseline';
import { RemoteRuntimeAdapter } from '../../../core/api/runtime-adapter/remote';
import type { RuntimeInput } from '../../../core/runtime/types';
import type { StorageAccountDoc, StorageEntityCoreDoc } from '../../../core/storage/types';
import { deriveDelta } from '../../../core/account/utils';
import { BRAINVAULT_V1_SPEC_ID } from '../../../brainvault/src/core/primitives/spec';

test('restored native custody owner spends its received balance exactly once', { tag: '@resilience' }, async ({ page }) => {
  test.setTimeout(180_000);
  const health = await ensureE2EBaseline(page, { requireHubMesh: true, minHubCount: 3 });
  const response = await page.request.get(`${API_BASE_URL}/api/runtime-import?access=admin`);
  expect(response.ok()).toBe(true);
  const manifest = await response.json() as { manifest: { entries: Array<{label:string;wsUrl:string;token:string}> } };
  const connect = async (name: string) => {
    const entry = manifest.manifest.entries.find(row => row.label.toLowerCase() === name.toLowerCase())!;
    expect(entry).toBeTruthy();
    const runtimeId = health.hubs!.find(row => row.name === name)!.runtimeId!;
    const adapter = new RemoteRuntimeAdapter();
    await adapter.connect({ mode:'remote',wsUrl:entry.wsUrl,authKey:entry.token,runtimeId });
    return adapter;
  };
  let h1 = await connect('H1');
  const h2 = await connect('H2');
  const send = async (adapter: RemoteRuntimeAdapter, input: RuntimeInput) => {
    await expect.poll(() => adapter.commandReady, {timeout:30_000}).toBe(true);
    return adapter.send(input, {commandId:`custody-pay-${crypto.randomUUID()}`,commandSequence:adapter.nextCommandSequence!});
  };
  try {
    const owner = await h1.deriveBrainVault({specId:BRAINVAULT_V1_SPEC_ID,name:'remote-financial-recovery',
      passphrase:'Local-regression-only-42!',shardInput:1,workers:1});
    expect(owner.created).toBe(true);
    expect(owner.height).toBeGreaterThan(0);
    const hubId = health.hubs!.find(row => row.name === 'H2')!.entityId!;
    const hub = await h2.read<StorageEntityCoreDoc & {signerId:string}>(`/entity/${hubId}`);
    const path = (entity:string,peer:string) => `/entity/${entity}/account/${peer}`;
    const left = owner.entityId.toLowerCase() < hubId.toLowerCase();
    const ownerInput = (entityTxs: RuntimeInput['entityInputs'][number]['entityTxs']): RuntimeInput => ({
      runtimeTxs:[],entityInputs:[{entityId:owner.entityId,signerId:owner.ethereumAddress,entityTxs}]});
    const hubInput = (entityTxs: RuntimeInput['entityInputs'][number]['entityTxs']): RuntimeInput => ({
      runtimeTxs:[],entityInputs:[{entityId:hubId,signerId:hub.signerId,entityTxs}]});
    // The owner extends real bilateral credit; H2 pays 2 USDC into that account.
    // No collateral/deposit claim: this is the existing credit-funded payment path.
    await send(h1,ownerInput([{type:'openAccount',data:{targetEntityId:hubId,tokenId:1,
      creditAmount:100_000_000n,disputeConfig:{leftResponseSeconds:3600,rightResponseSeconds:3600}}}]));
    const readPair = async () => Promise.all([
      h1.read<StorageAccountDoc>(path(owner.entityId,hubId)),h2.read<StorageAccountDoc>(path(hubId,owner.entityId))]);
    await expect.poll(async () => {
      try { const pair=await readPair(); return pair.every(a=>a.currentHeight>0 && !a.pendingFrame); }
      catch(error) { if((error as {code?:string}).code==='E_NOT_FOUND') return false; throw error; }
    },{timeout:30_000}).toBe(true);
    const baseline = await readPair();
    const initialDelta = deriveDelta(baseline[0].state.deltas.get(1)!,left).delta;
    const pay = (target:string,from:string,amount:bigint) => ({type:'directPayment' as const,
      data:{targetEntityId:target,tokenId:1,amount,route:[from,target],deliveryMode:'direct' as const,
        description:'native-custody-real-payment'}});
    await send(h2,hubInput([pay(owner.entityId,hubId,2_000_000n)]));
    const fundedDelta = initialDelta + (left ? 2_000_000n : -2_000_000n);
    const settled = async (expected:bigint) => {
      const pair=await readPair();
      return pair.every(a=>!a.pendingFrame && deriveDelta(a.state.deltas.get(1)!,left).delta===expected)
        && pair[0].currentHeight===pair[1].currentHeight
        && pair[0].currentFrame.accountStateRoot===pair[1].currentFrame.accountStateRoot;
    };
    await expect.poll(()=>settled(fundedDelta),{timeout:30_000}).toBe(true);
    const funded=(await readPair())[0];
    expect(deriveDelta(funded.state.deltas.get(1)!,left).outCapacity).toBeGreaterThanOrEqual(2_000_000n);
    const crash = async () => {
      const before=(await getHealth(page,API_BASE_URL))!.process!.children!.find(c=>c.role==='hub'&&c.name==='H1')!;
      expect(before.online).toBe(true);expect(before.pid).toBeGreaterThan(0);
      h1.disconnect();
      process.kill(Number(before.pid),'SIGKILL');
      await expect.poll(async()=>{
        const after=(await getHealth(page,API_BASE_URL))?.process?.children?.find(c=>c.role==='hub'&&c.name==='H1');
        return Boolean(after?.online && after.pid!==before.pid && Number(after.restartCount)>Number(before.restartCount||0));
      },{timeout:45_000}).toBe(true);
      h1=await connect('H1');
      await expect.poll(()=>h1.commandReady,{timeout:30_000}).toBe(true);
    };
    allowDebugIncident({source:'orchestrator',code:'CHILD_UNEXPECTED_EXIT',message:'child.unexpected_exit'});
    allowDebugIncident({source:'orchestrator',code:'H1_UNEXPECTED_EXIT',message:'H1_UNEXPECTED_EXIT code=null signal=SIGKILL'});
    await crash();
    const recovered=await h1.read<StorageEntityCoreDoc & {signerId:string}>(`/entity/${owner.entityId}`);
    expect(recovered.signerId).toBe(owner.ethereumAddress);
    await expect.poll(()=>settled(fundedDelta),{timeout:30_000}).toBe(true);
    expect((await readPair())[0].currentFrame.accountStateRoot).toBe(funded.currentFrame.accountStateRoot);
    await send(h1,ownerInput([pay(hubId,owner.entityId,1_000_000n)]));
    const paidDelta=fundedDelta+(left ? -1_000_000n : 1_000_000n);
    await expect.poll(()=>settled(paidDelta),{timeout:30_000}).toBe(true);
    const paid=(await readPair())[0];
    expect(paid.currentHeight).toBeGreaterThan(funded.currentHeight);
    expect(paid.currentFrame.accountStateRoot).not.toBe(funded.currentFrame.accountStateRoot);
    await crash();
    await expect.poll(()=>settled(paidDelta),{timeout:30_000}).toBe(true);
    expect((await readPair())[0].currentFrame.accountStateRoot).toBe(paid.currentFrame.accountStateRoot);
    expect((await readPair())[0].currentHeight).toBe(paid.currentHeight);
  } finally {h1.disconnect();h2.disconnect();}
});
