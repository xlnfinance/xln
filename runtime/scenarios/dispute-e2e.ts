/**
 * Dispute E2E Scenario (unilateral dispute path)
 *
 * Verifies:
 * 1) disputeStart freezes account immediately (local shadow state)
 * 2) DisputeStarted/DisputeFinalized are handled unilaterally (no j_event_claim path)
 * 3) account unfreezes after finalize and business traffic resumes
 */

import type { Env } from '../types';
import type { JAdapter } from '../jadapter/types';
import { bootScenario, registerEntities, fundEntities } from './boot';
import {
  getProcess,
  converge,
  syncChain,
  processJEvents,
  assert,
  findReplica,
  usd,
  enableStrictScenario,
} from './helpers';

const USDC = 1;

type Registered = { id: string; signer: string; name: string };

function jEventClaimCount(account: any): number {
  const frames = Array.isArray(account?.frameHistory) ? account.frameHistory : [];
  let count = 0;
  for (const frame of frames) {
    const txs = Array.isArray(frame?.accountTxs) ? frame.accountTxs : [];
    for (const tx of txs) {
      if (tx?.type === 'j_event_claim') count += 1;
    }
  }
  return count;
}

async function mineUntilHeight(jadapter: JAdapter, targetHeight: number): Promise<void> {
  const providerAny = jadapter.provider as any;
  if (typeof providerAny?.send !== 'function') {
    throw new Error('dispute-e2e requires RPC provider with evm_mine support');
  }
  let current = Number(await jadapter.provider.getBlockNumber());
  let guard = 0;
  while (current < targetHeight) {
    await providerAny.send('evm_mine', []);
    current = Number(await jadapter.provider.getBlockNumber());
    guard += 1;
    if (guard > 2000) {
      throw new Error(`mineUntilHeight guard tripped: current=${current}, target=${targetHeight}`);
    }
  }
}

export async function runDisputeE2E(_existingEnv?: Env): Promise<Env> {
  console.log('\n' + '='.repeat(80));
  console.log('  DISPUTE E2E SCENARIO (UNILATERAL)');
  console.log('='.repeat(80));

  const process = await getProcess();
  const { env, jadapter, jurisdiction } = await bootScenario({
    name: 'dispute-e2e',
    signerIds: ['2', '3'],
    seed: 'dispute-e2e-deterministic',
  });
  env.quietRuntimeLogs = true;
  const restoreStrict = enableStrictScenario(env, 'dispute-e2e');

  try {
    const [alice, hub] = await registerEntities(
      env,
      jadapter,
      [
        { name: 'Alice', signer: '2', position: { x: -20, y: -30, z: 0 } },
        { name: 'Hub', signer: '3', position: { x: 20, y: -30, z: 0 } },
      ],
      jurisdiction,
    ) as Registered[];

    await fundEntities(env, jadapter, [
      { id: alice.id, tokenId: USDC, amount: usd(2_000_000) },
      { id: hub.id, tokenId: USDC, amount: usd(2_000_000) },
    ]);

    // Open Alice<->Hub bilateral account
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'openAccount',
        data: { targetEntityId: hub.id, tokenId: USDC, creditAmount: usd(10_000) },
      }],
    }]);
    for (let i = 0; i < 4; i++) await process(env);
    await converge(env, 12);

    // Seed at least one settled bilateral frame (ensures counterparty dispute proof metadata is present)
    await process(env, [{
      entityId: hub.id,
      signerId: hub.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: alice.id,
          tokenId: USDC,
          amount: usd(100),
          route: [hub.id, alice.id],
          description: 'dispute-seed-payment',
        },
      }],
    }]);
    for (let i = 0; i < 6; i++) await process(env);
    await converge(env, 12);

    const aliceAccountPre = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAccountPre = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!!aliceAccountPre && !!hubAccountPre, 'Alice↔Hub account missing', env);
    assert(
      !!aliceAccountPre!.counterpartyDisputeProofHanko,
      'Missing counterpartyDisputeProofHanko before disputeStart',
      env,
    );

    const aliceClaimCountBefore = jEventClaimCount(aliceAccountPre);
    const hubClaimCountBefore = jEventClaimCount(hubAccountPre);

    // Start dispute: local freeze must happen immediately (before on-chain event returns)
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'disputeStart',
        data: { counterpartyEntityId: hub.id, description: 'safety-freeze-check' },
      }],
    }]);

    const aliceAccountFrozen = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    assert(aliceAccountFrozen?.status === 'disputed', 'disputeStart must freeze account immediately', env);
    assert(!aliceAccountFrozen?.pendingFrame, 'pendingFrame must be cleared on freeze', env);
    assert(!aliceAccountFrozen?.pendingAccountInput, 'pendingAccountInput must be cleared on freeze', env);
    assert((env as any).jReplicas.size > 0, 'jReplicas missing', env);
    assert(
      (findReplica(env, alice.id)[1].state.jBatchState?.batch?.disputeStarts?.length || 0) > 0,
      'disputeStart was not added to jBatch',
      env,
    );

    // Broadcast disputeStart and process unilateral j-events
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);
    await syncChain(env, 5);
    await processJEvents(env);
    await converge(env, 12);

    const aliceAfterStart = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAfterStart = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!!aliceAfterStart?.activeDispute, 'Alice activeDispute not set after DisputeStarted', env);
    assert(!!hubAfterStart?.activeDispute, 'Hub activeDispute not set after DisputeStarted', env);
    assert(aliceAfterStart?.status === 'disputed', 'Alice status must remain disputed after start', env);
    assert(hubAfterStart?.status === 'disputed', 'Hub status must be disputed after start', env);

    // Business txs must be blocked while disputed (only j_event_claim/reopen_disputed allowed).
    // Keep this in sync with runtime/account-tx/apply.ts disputed gate.
    const frameBeforeBlockedTraffic = Number(aliceAfterStart?.currentHeight || 0);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: hub.id,
          tokenId: USDC,
          amount: usd(5),
          route: [alice.id, hub.id],
          description: 'must-fail-while-disputed',
        },
      }],
    }]);
    for (let i = 0; i < 4; i++) await process(env);
    await converge(env, 6);
    const frameAfterBlockedTraffic = Number(findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.currentHeight || 0);
    assert(
      frameAfterBlockedTraffic === frameBeforeBlockedTraffic,
      `Disputed account accepted business tx unexpectedly (${frameBeforeBlockedTraffic} -> ${frameAfterBlockedTraffic})`,
      env,
    );

    // Dispute path is unilateral at entity-layer: no new bilateral j_event_claims should appear.
    const aliceClaimCountAfterStart = jEventClaimCount(aliceAfterStart);
    const hubClaimCountAfterStart = jEventClaimCount(hubAfterStart);
    assert(
      aliceClaimCountAfterStart === aliceClaimCountBefore,
      `Unexpected j_event_claim growth on Alice during disputeStart (${aliceClaimCountBefore} -> ${aliceClaimCountAfterStart})`,
      env,
    );
    assert(
      hubClaimCountAfterStart === hubClaimCountBefore,
      `Unexpected j_event_claim growth on Hub during disputeStart (${hubClaimCountBefore} -> ${hubClaimCountAfterStart})`,
      env,
    );

    // Mine to challenge timeout and finalize dispute
    const timeoutBlock = Number(aliceAfterStart?.activeDispute?.disputeTimeout || 0);
    const currentBlock = Number(await jadapter.provider.getBlockNumber());
    assert(timeoutBlock > currentBlock, `Expected future timeout block, got timeout=${timeoutBlock}, current=${currentBlock}`, env);
    await mineUntilHeight(jadapter, timeoutBlock);

    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'disputeFinalize',
        data: { counterpartyEntityId: hub.id, description: 'timeout-finalize' },
      }],
    }]);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{ type: 'j_broadcast', data: {} }],
    }]);
    await syncChain(env, 5);
    await processJEvents(env);
    await converge(env, 12);

    const aliceAfterFinalize = findReplica(env, alice.id)[1].state.accounts.get(hub.id);
    const hubAfterFinalize = findReplica(env, hub.id)[1].state.accounts.get(alice.id);
    assert(!aliceAfterFinalize?.activeDispute, 'Alice activeDispute must clear after DisputeFinalized', env);
    assert(!hubAfterFinalize?.activeDispute, 'Hub activeDispute must clear after DisputeFinalized', env);
    assert(aliceAfterFinalize?.status === 'active', 'Alice account must reactivate after finalize', env);
    assert(hubAfterFinalize?.status === 'active', 'Hub account must reactivate after finalize', env);

    const aliceOnChainNonce = Number(aliceAfterFinalize?.onChainSettlementNonce || 0);
    const hubOnChainNonce = Number(hubAfterFinalize?.onChainSettlementNonce || 0);
    assert(
      Number(aliceAfterFinalize?.proofHeader?.nonce || 0) >= aliceOnChainNonce + 1,
      'Alice proofHeader.nonce must be onChain+1 after finalize',
      env,
    );
    assert(
      Number(hubAfterFinalize?.proofHeader?.nonce || 0) >= hubOnChainNonce + 1,
      'Hub proofHeader.nonce must be onChain+1 after finalize',
      env,
    );

    const aliceClaimCountAfterFinalize = jEventClaimCount(aliceAfterFinalize);
    const hubClaimCountAfterFinalize = jEventClaimCount(hubAfterFinalize);
    assert(
      aliceClaimCountAfterFinalize === aliceClaimCountBefore,
      `Unexpected j_event_claim growth on Alice during disputeFinalize (${aliceClaimCountBefore} -> ${aliceClaimCountAfterFinalize})`,
      env,
    );
    assert(
      hubClaimCountAfterFinalize === hubClaimCountBefore,
      `Unexpected j_event_claim growth on Hub during disputeFinalize (${hubClaimCountBefore} -> ${hubClaimCountAfterFinalize})`,
      env,
    );

    // Business resumes after finalize: direct payment should work again.
    const frameBeforeResume = Number(aliceAfterFinalize?.currentHeight || 0);
    await process(env, [{
      entityId: alice.id,
      signerId: alice.signer,
      entityTxs: [{
        type: 'directPayment',
        data: {
          targetEntityId: hub.id,
          tokenId: USDC,
          amount: usd(10),
          route: [alice.id, hub.id],
          description: 'post-dispute-resume',
        },
      }],
    }]);
    for (let i = 0; i < 6; i++) await process(env);
    await converge(env, 10);
    const frameAfterResume = Number(findReplica(env, alice.id)[1].state.accounts.get(hub.id)?.currentHeight || 0);
    assert(frameAfterResume > frameBeforeResume, 'Account did not progress after dispute finalize', env);

    console.log('✅ dispute-e2e passed');
    return env;
  } finally {
    restoreStrict();
  }
}
