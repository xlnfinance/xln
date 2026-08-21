import { afterEach, describe, expect, test } from 'bun:test';
import { SigningKey, computeAddress } from 'ethers';

import {
  clearSignerKeys,
  deriveSignerKeySync,
  registerSignerKey,
} from '../../../../account/crypto';
import { handleScheduledWakeEntityTx } from '../../../../entity/tx/handlers/system/scheduled-wake';
import { handleDisputeFinalize, handleDisputeStart } from '../../../../entity/tx/handlers/dispute/index';
import { initCrontab, scheduleHook } from '../../../../entity/scheduler';
import { generateLazyEntityId } from '../../../../entity/factory';
import { computeCanonicalEntityConsensusStateHash } from '../../../../entity/consensus/state-root';
import { getEntityCertifiedJurisdictionHeight } from '../../../../jurisdiction/machine/history/height';
import {
  buildAccountProofBody,
  createDisputeProofHashWithNonce,
} from '../../../../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../../../../runtime';
import { createEntityFrameCandidateState } from '../../../../entity/state-clone';
import type { EntityState } from '../../../../entity/types';
import type { RuntimeReplica } from '../../../../runtime/types';
import type { EntityTx } from '../../../../types/entity-tx';
import { signEntityHashes } from '../../../../hanko/signing';
import {
  addr,
  entity,
  installJurisdictions,
  makeJurisdiction,
  makeAccount,
  makeState,
  openWritableEntityAccounts,
} from '../../../helpers/cross-j';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

const jurisdiction = makeJurisdiction('Ethereum', 1, '11', '12');
const entityId = entity('01');
const counterpartyId = entity('02');
const signerId = addr('31');
const secondValidatorId = addr('32');

const envAt = (scannedThroughHeight: number): RuntimeReplica => {
  const env = createEmptyEnv(`certified-j-height:${scannedThroughHeight}`);
  env.state.timestamp = 1_000;
  env.quietRuntimeLogs = true;
  installJurisdictions(env, jurisdiction);
  const replica = env.state.jReplicas.get(jurisdiction.name)!;
  replica.blockNumber = BigInt(scannedThroughHeight);
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

const installDispute = (state: EntityState, timeout: number, accountId = counterpartyId): void => {
  const account = openWritableEntityAccounts(state).getForWrite(accountId)!;
  account.proofHeader.nextProofNonce = 1;
  const proof = buildAccountProofBody(account, '');
  account.activeDispute = {
    startedByLeft: true,
    initialProofbodyHash: proof.proofBodyHash,
    initialNonce: 1,
    disputeTimeout: timeout,
    jNonce: 0,
    starterInitialArguments: '0x',
    starterCounterArguments: '0x',
        starterCounterProofCommitment: '0x0000000000000000000000000000000000000000000000000000000000000000',
    observedOnChain: true,
    finalizeQueued: false,
  };
};

describe('two-validator replay uses Entity-certified jurisdiction height', () => {
  test('rejects disagreement between the certified anchor fields during replay', () => {
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
  });

  test('dispute finalize readiness is independent of validator-local scan height', async () => {
    const state = baseState();
    installDispute(state, 120);
    const tx = {
      type: 'disputeFinalize',
      data: { counterpartyEntityId: counterpartyId },
    } satisfies Extract<EntityTx, { type: 'disputeFinalize' }>;
    const lagging = await handleDisputeFinalize(state, tx, envAt(110));
    const leading = await handleDisputeFinalize(state, tx, envAt(130));

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('starter cannot use a stored peer signature to bypass the certified timeout', async () => {
    const state = baseState();
    state.timestamp = 120_001;
    installDispute(state, 120);
    const account = state.accounts.get(counterpartyId)!;
    const initialHash = account.activeDispute!.initialProofbodyHash;
    account.counterpartyDisputeProofBodyHash = initialHash;
    account.counterpartyDisputeProofNonce = 2;
    account.counterpartyDisputeProofHanko = '0x1234';
    state.lastFinalizedJHeight = 120;

    const finalized = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: counterpartyId },
      },
      envAt(120),
    );
    const proof = finalized.newState.jBatchState?.batch.disputeFinalizations[0];

    expect(proof?.finalNonce).toBe(1);
    const expectedFinalBody = buildAccountProofBody(account, '').proofBodyStruct;
    expect(proof?.finalProofbody).toEqual({
      ...expectedFinalBody,
      // ABI canonicalization returns uint32 fields as bigint. Compare that
      // actual wire representation rather than the pre-encoding JS numbers.
      leftResponseSeconds: BigInt(expectedFinalBody.leftResponseSeconds),
      rightResponseSeconds: BigInt(expectedFinalBody.rightResponseSeconds),
    });
    expect(proof?.sig).toBe('0x');
    expect(proof?.initialProofbodyHash).toBe(initialHash);
    expect(proof?.submitNotBeforeTimestamp).toBe(120);
  });

  test('pull-free selected counter-proof remains locked until timeout', async () => {
    const state = baseState();
    installDispute(state, 120);
    const account = state.accounts.get(counterpartyId)!;
    const active = account.activeDispute!;
    active.startedByLeft = false;
    active.selectedCounterNonce = 2;
    active.selectedCounterProposerIsLeft = true;
    active.selectedCounterProofbodyHash = active.initialProofbodyHash;
    const tx = {
      type: 'disputeFinalize',
      data: { counterpartyEntityId: counterpartyId },
    } satisfies Extract<EntityTx, { type: 'disputeFinalize' }>;

    const early = await handleDisputeFinalize(state, tx, envAt(120));
    expect(early.newState.jBatchState?.batch.disputeFinalizations).toEqual([]);

    state.timestamp = 120_001;
    const ready = await handleDisputeFinalize(state, tx, envAt(120));
    expect(ready.newState.jBatchState?.batch.disputeFinalizations[0])
      .toMatchObject({ finalNonce: 2, submitNotBeforeTimestamp: 120 });
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
      envAt(110),
      createEntityFrameCandidateState(state),
      tx,
      false,
    );
    const leading = await handleScheduledWakeEntityTx(
      envAt(130),
      createEntityFrameCandidateState(state),
      tx,
      false,
    );

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.outputs).toEqual([]);
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

  test('same-tick dispute deadlines emit one legal finalization and retain the next hook', async () => {
    const secondCounterparty = entity('03');
    const state = baseState();
    openWritableEntityAccounts(state).set(
      secondCounterparty,
      makeAccount(entityId, secondCounterparty, jurisdiction),
    );
    installDispute(state, 1, counterpartyId);
    installDispute(state, 1, secondCounterparty);
    state.leaderState = { view: 0, activeValidatorId: signerId, changedAtHeight: 0 };
    state.crontabState = initCrontab();
    for (const accountId of [counterpartyId, secondCounterparty]) {
      scheduleHook(state.crontabState, {
        id: `deadline:${accountId}`,
        triggerAt: 1_000,
        type: 'dispute_deadline',
        data: { accountId },
      });
    }
    const tx = {
      type: 'scheduledWake',
      data: {
        version: 1,
        proposerSignerId: signerId,
        dueAt: 1_000,
        jobs: [counterpartyId, secondCounterparty].map(accountId => ({
          kind: 'hook' as const,
          id: `deadline:${accountId}`,
          dueAt: 1_000,
        })),
      },
    } satisfies Extract<EntityTx, { type: 'scheduledWake' }>;

    const result = await handleScheduledWakeEntityTx(envAt(120), state, tx, false);
    expect(result.outputs).toHaveLength(0);
    expect(result.approvedEntityTxs?.map(item => item.type)).toEqual([
      'disputeFinalize',
      'j_broadcast',
    ]);
    expect([...result.newState.crontabState!.hooks.values()]).toEqual([
      {
        id: `deadline:${secondCounterparty}`,
        triggerAt: 1_001,
        type: 'dispute_deadline',
        data: { accountId: secondCounterparty },
      },
    ]);
  });

  test('dispute start placeholder is independent of validator-local scan height', async () => {
    const privateKeyA = deriveSignerKeySync('certified-j-height:start:a', '1');
    const privateKeyB = deriveSignerKeySync('certified-j-height:start:b', '1');
    const signerA = computeAddress(new SigningKey(hex(privateKeyA)).compressedPublicKey).toLowerCase();
    const signerB = computeAddress(new SigningKey(hex(privateKeyB)).compressedPublicKey).toLowerCase();
    const starterEntityId = generateLazyEntityId([signerA], 1n);
    const peerEntityId = generateLazyEntityId([signerB], 1n);
    const state = makeState(starterEntityId, signerA, jurisdiction, peerEntityId);
    state.lastFinalizedJHeight = 100;
    state.timestamp = 120_001;
    const account = openWritableEntityAccounts(state).getForWrite(peerEntityId)!;
    account.proofHeader.nextProofNonce = 1;
    const proof = buildAccountProofBody(account, '');
    account.counterpartyDisputeProofBodyHash = proof.proofBodyHash;
    account.counterpartyDisputeProofNonce = 1;
    const disputeHash = createDisputeProofHashWithNonce(account.state, proof.proofBodyHash, {
      chainId: jurisdiction.chainId!,
      depositoryAddress: jurisdiction.depositoryAddress!,
    }, 1, true);
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
    const envFor = (height: number): RuntimeReplica => {
      const env = envAt(height);
      env.runtimeSeed = signingEnv.runtimeSeed;
      return env;
    };
    const lagging = await handleDisputeStart(state, tx, envFor(110));
    const leading = await handleDisputeStart(state, tx, envFor(130));

    expect(lagging.outputs).toEqual(leading.outputs);
    expect(lagging.newState.accounts.get(peerEntityId)?.activeDispute).toBeUndefined();
    expect(computeCanonicalEntityConsensusStateHash(lagging.newState))
      .toBe(computeCanonicalEntityConsensusStateHash(leading.newState));
  });

});
