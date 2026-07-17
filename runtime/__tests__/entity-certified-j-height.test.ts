import { afterEach, describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import {
  clearSignerKeys,
  deriveSignerKeySync,
  registerSignerKey,
} from '../account/crypto';
import { handleScheduledWakeEntityTx } from '../entity/tx/handlers/scheduled-wake';
import { handleDisputeFinalize, handleDisputeStart } from '../entity/tx/handlers/dispute';
import { handleHashlockPaymentEntityTx } from '../entity/tx/handlers/htlc-direct';
import { applyEntityTx } from '../entity/tx/apply';
import { initCrontab, scheduleHook } from '../entity/scheduler';
import { generateLazyEntityId } from '../entity/factory';
import { computeCanonicalEntityConsensusStateHash } from '../entity/consensus/state-root';
import { getEntityCertifiedJurisdictionHeight } from '../jurisdiction/height';
import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
} from '../protocol/dispute/proof-builder';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { createEmptyEnv } from '../runtime';
import { cloneEntityState } from '../state-helpers';
import type { EntityState, EntityTx, Env } from '../types';
import { signEntityHashes } from '../hanko/signing';
import {
  addr,
  entity,
  installJurisdictions,
  makeJurisdiction,
  makeState,
  secret,
} from './helpers/cross-j';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

const jurisdiction = makeJurisdiction('Ethereum', 1, '11', '12');
const entityId = entity('01');
const counterpartyId = entity('02');
const signerId = addr('31');
const secondValidatorId = addr('32');

const envAt = (scannedThroughHeight: number, disputeDelayBlocks: number): Env => {
  const env = createEmptyEnv(`certified-j-height:${scannedThroughHeight}:${disputeDelayBlocks}`);
  env.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  installJurisdictions(env, jurisdiction);
  const replica = env.jReplicas.get(jurisdiction.name)!;
  replica.blockNumber = BigInt(scannedThroughHeight);
  replica.defaultDisputeDelayBlocks = disputeDelayBlocks;
  return env;
};

const baseState = (): EntityState => {
  const state = makeState(entityId, signerId, jurisdiction, counterpartyId);
  state.config.validators = [signerId, secondValidatorId];
  state.config.shares = { [signerId]: 1n, [secondValidatorId]: 1n };
  state.config.threshold = 2n;
  state.lastFinalizedJHeight = 100;
  state.timestamp = 1_000;
  return state;
};

const installDispute = (state: EntityState, timeout: number): void => {
  const account = state.accounts.get(counterpartyId)!;
  account.proofHeader.nextProofNonce = 1;
  const proof = buildAccountProofBody(account, '');
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
  );
  account.disputeProofBodiesByHash = { [proof.proofBodyHash]: proof.proofBodyStruct };
  account.activeDispute = {
    startedByLeft: true,
    initialProofbodyHash: proof.proofBodyHash,
    initialNonce: 1,
    disputeTimeout: timeout,
    jNonce: 0,
    starterInitialArguments: '0x',
    starterIncrementedArguments: '0x',
    observedOnChain: true,
    finalizeQueued: false,
  };
};

describe('two-validator replay uses Entity-certified jurisdiction height', () => {
  test('rejects disagreement between the certified anchor fields during replay', async () => {
    const state = baseState();
    state.jHistoryFinality = {
      jurisdictionRef: 'ethereum',
      baseHeight: 99,
      finalizedThroughHeight: 101,
      tipBlockHash: `0x${'11'.repeat(32)}`,
      eventHistoryRoot: `0x${'22'.repeat(32)}`,
      proposerSignerId: signerId,
      proposerSignature: '0x1234',
      entityHeight: state.height,
    };
    expect(() => getEntityCertifiedJurisdictionHeight(state))
      .toThrow('ENTITY_J_FINALITY_HEIGHT_MISMATCH');
    await expect(applyEntityTx(envAt(110, 5), state, {
      type: 'hashlockPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: 1,
        amount: 1n,
        hashlock: hashHtlcSecret(secret('45')),
        timelock: 130_000n,
      },
    })).rejects.toThrow('ENTITY_J_FINALITY_HEIGHT_MISMATCH');
  });

  test('hashlock default deadline is independent of validator-local scan height', () => {
    const state = baseState();
    const tx = {
      type: 'hashlockPayment',
      data: {
        targetEntityId: counterpartyId,
        tokenId: 1,
        amount: 25n,
        hashlock: hashHtlcSecret(secret('44')),
        timelock: 130_000n,
      },
    } satisfies Extract<EntityTx, { type: 'hashlockPayment' }>;
    const applyAt = (height: number, delay: number) => {
      const result = handleHashlockPaymentEntityTx(envAt(height, delay), state, tx);
      const op = result.mempoolOps[0]!;
      result.newState.accounts.get(op.accountId)!.mempool.push(op.tx);
      return result;
    };
    const lagging = applyAt(110, 5);
    const leading = applyAt(130, 5_760);

    expect(lagging.mempoolOps).toEqual(leading.mempoolOps);
    expect(lagging.outputs).toEqual(leading.outputs);
    expect((lagging.mempoolOps[0]!.tx as Extract<typeof lagging.mempoolOps[0]['tx'], { type: 'htlc_lock' }>).data.revealBeforeHeight)
      .toBe(150);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('dispute finalize readiness is independent of validator-local scan height', async () => {
    const state = baseState();
    installDispute(state, 120);
    const tx = {
      type: 'disputeFinalize',
      data: { counterpartyEntityId: counterpartyId },
    } satisfies Extract<EntityTx, { type: 'disputeFinalize' }>;
    const lagging = await handleDisputeFinalize(state, tx, envAt(110, 5));
    const leading = await handleDisputeFinalize(state, tx, envAt(130, 5_760));

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('scheduled dispute wake is independent of validator-local scan height', async () => {
    const state = baseState();
    installDispute(state, 120);
    state.leaderState = { view: 0, activeValidatorId: signerId, changedAtHeight: 0 };
    state.crontabState = initCrontab();
    scheduleHook(state.crontabState, {
      id: 'deadline',
      triggerAt: 1_000,
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
    const tx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: signerId,
        dueAt: 1_000,
        jobs: [{ kind: 'hook', id: 'deadline', dueAt: 1_000 }],
      },
    } satisfies Extract<EntityTx, { type: 'scheduledWake' }>;
    const lagging = await handleScheduledWakeEntityTx(
      envAt(110, 5),
      cloneEntityState(state),
      tx,
      false,
    );
    const leading = await handleScheduledWakeEntityTx(
      envAt(130, 5_760),
      cloneEntityState(state),
      tx,
      false,
    );

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.outputs).toEqual([]);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('dispute start placeholder is independent of local height and delay config', async () => {
    const privateKeyA = deriveSignerKeySync('certified-j-height:start:a', '1');
    const privateKeyB = deriveSignerKeySync('certified-j-height:start:b', '1');
    const signerA = computeAddress(new SigningKey(hex(privateKeyA)).compressedPublicKey).toLowerCase();
    const signerB = computeAddress(new SigningKey(hex(privateKeyB)).compressedPublicKey).toLowerCase();
    const starterEntityId = generateLazyEntityId([signerA], 1n);
    const peerEntityId = generateLazyEntityId([signerB], 1n);
    const state = makeState(starterEntityId, signerA, jurisdiction, peerEntityId);
    state.lastFinalizedJHeight = 100;
    state.timestamp = 1_000;
    const account = state.accounts.get(peerEntityId)!;
    account.proofHeader.nextProofNonce = 1;
    const proof = buildAccountProofBody(account, '');
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
    );
    account.disputeProofBodiesByHash = { [proof.proofBodyHash]: proof.proofBodyStruct };
    account.counterpartyDisputeProofBodyHash = proof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 1;
    account.disputeProofNoncesByHash = { [proof.proofBodyHash]: 1 };
    const disputeHash = createDisputeProofHashWithNonce(account, proof.proofBodyHash, {
      chainId: jurisdiction.chainId!,
      depositoryAddress: jurisdiction.depositoryAddress!,
    }, 1);
    account.counterpartyDisputeHash = disputeHash;
    const signingEnv = createEmptyEnv('certified-j-height:start:sign');
    signingEnv.runtimeSeed = 'certified-j-height:start:runtime';
    registerSignerKey(signingEnv, signerA, privateKeyA);
    registerSignerKey(signingEnv, signerB, privateKeyB);
    account.counterpartyDisputeProofHanko = (await signEntityHashes(
      signingEnv,
      peerEntityId,
      signerB,
      [disputeHash],
    ))[0];
    const tx = {
      type: 'disputeStart',
      data: { counterpartyEntityId: peerEntityId },
    } satisfies Extract<EntityTx, { type: 'disputeStart' }>;
    const envFor = (height: number, delay: number): Env => {
      const env = envAt(height, delay);
      env.runtimeSeed = signingEnv.runtimeSeed;
      return env;
    };
    const lagging = await handleDisputeStart(state, tx, envFor(110, 5));
    const leading = await handleDisputeStart(state, tx, envFor(130, 5_760));

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.newState.accounts.get(peerEntityId)?.activeDispute?.disputeTimeout).toBe(0);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

});
