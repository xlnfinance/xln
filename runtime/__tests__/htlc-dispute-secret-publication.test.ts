import { describe, expect, test } from 'bun:test';

import { executeCrontab, initCrontab, scheduleHook } from '../entity/scheduler';
import { handleDisputeFinalize } from '../entity/tx/handlers/dispute';
import {
  captureDisputeArgumentSnapshot,
  storeDisputeArgumentSnapshot,
} from '../protocol/dispute/arguments';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import { hashHtlcSecret } from '../protocol/htlc/utils';
import { createEmptyEnv } from '../runtime';
import { createJReplica } from '../scenarios/boot';
import type { EntityReplica } from '../types';
import {
  addr,
  entity,
  makeJurisdiction,
  makeState,
  secret,
} from './helpers/cross-j';

const jurisdiction = makeJurisdiction('secret-publication', 31337, '31', '32');
const entityId = entity('11');
const counterpartyId = entity('22');
const signerId = addr('41');
const transformerAddress = addr('51');

const installTrustedJurisdiction = (env: ReturnType<typeof createEmptyEnv>): void => {
  const replica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress!);
  replica.chainId = jurisdiction.chainId;
  replica.depositoryAddress = jurisdiction.depositoryAddress;
  replica.entityProviderAddress = jurisdiction.entityProviderAddress;
  replica.contracts = {
    account: addr('52'),
    depository: jurisdiction.depositoryAddress!,
    entityProvider: jurisdiction.entityProviderAddress!,
    deltaTransformer: transformerAddress,
  };
};

const installObservedDispute = (state: ReturnType<typeof makeState>): string => {
  const account = state.accounts.get(counterpartyId)!;
  const proofSecret = secret('61');
  const hashlock = hashHtlcSecret(proofSecret);
  account.locks.set('proof-lock', {
    lockId: 'proof-lock',
    hashlock,
    timelock: 1_000_000n,
    revealBeforeHeight: 1_000,
    amount: 10n,
    tokenId: 1,
    senderIsLeft: false,
    createdHeight: 1,
    createdTimestamp: state.timestamp,
  });
  account.proofHeader.nextProofNonce = 2;
  const proof = buildAccountProofBody(account, transformerAddress);
  storeDisputeArgumentSnapshot(
    account,
    captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, proof.proofBodyStruct),
  );
  account.disputeProofBodiesByHash = { [proof.proofBodyHash]: proof.proofBodyStruct };
  account.status = 'disputed';
  account.activeDispute = {
    startedByLeft: false,
    initialProofbodyHash: proof.proofBodyHash,
    initialNonce: 1,
    disputeTimeout: 2_000,
    jNonce: 1,
    starterInitialArguments: '0x',
    starterIncrementedArguments: '0x',
    observedOnChain: true,
    finalizeQueued: false,
  };
  state.htlcRoutes.set(hashlock, {
    hashlock,
    secret: proofSecret,
    tokenId: 1,
    amount: 10n,
    inboundEntity: counterpartyId,
    inboundLockId: 'proof-lock',
    createdTimestamp: state.timestamp,
  });
  return proofSecret;
};

describe('HTLC dispute secret publication liveness', () => {
  test('automatic dispute finalization requests on-chain publication for proof recovery', async () => {
    const env = createEmptyEnv('auto-finalize-secret-publication');
    installTrustedJurisdiction(env);
    env.quietRuntimeLogs = true;
    const state = makeState(entityId, signerId, jurisdiction, counterpartyId);
    state.timestamp = 3_000;
    state.crontabState = initCrontab();
    for (const task of state.crontabState.tasks.values()) task.enabled = false;
    installObservedDispute(state);
    scheduleHook(state.crontabState, {
      id: 'dispute-deadline',
      triggerAt: state.timestamp,
      type: 'dispute_deadline',
      data: { accountId: counterpartyId },
    });
    const replica = {
      entityId,
      signerId,
      state,
      mempool: [],
      isProposer: true,
    } satisfies EntityReplica;

    const outputs = await executeCrontab(env, replica, state.crontabState, {
      manualBroadcastInInput: false,
      accountChanges: new Set(),
    });
    const finalize = outputs
      .flatMap((output) => output.entityTxs ?? [])
      .find((tx) => tx.type === 'disputeFinalize');

    expect(finalize).toBeDefined();
    expect(finalize?.type === 'disputeFinalize' && finalize.data.useOnchainRegistry).toBe(true);
  });

  test('publishes only secrets committed by the exact finalized proof', async () => {
    const env = createEmptyEnv('proof-relevant-secret-publication');
    installTrustedJurisdiction(env);
    env.quietRuntimeLogs = true;
    const state = makeState(entityId, signerId, jurisdiction, counterpartyId);
    env.eReplicas.set(`${entityId}:${signerId}`, {
      entityId,
      signerId,
      state,
      mempool: [],
      isProposer: true,
    });
    const proofSecret = installObservedDispute(state);

    // These known preimages involve the same counterparty but are absent from
    // the exact signed ProofBody. Publishing them can overflow the 32-secret
    // contract cap and must never prevent the one relevant dispute from closing.
    for (let index = 0; index < 32; index += 1) {
      const unrelatedSecret = `0x${(index + 100).toString(16).padStart(64, '0')}`;
      const unrelatedHashlock = hashHtlcSecret(unrelatedSecret);
      state.htlcRoutes.set(unrelatedHashlock, {
        hashlock: unrelatedHashlock,
        secret: unrelatedSecret,
        tokenId: 1,
        amount: 1n,
        inboundEntity: counterpartyId,
        inboundLockId: `old-lock-${index}`,
        createdTimestamp: state.timestamp - index - 1,
      });
    }

    const result = await handleDisputeFinalize(
      state,
      {
        type: 'disputeFinalize',
        data: { counterpartyEntityId: counterpartyId, useOnchainRegistry: true },
      },
      env,
    );

    expect(result.newState.jBatchState?.batch.disputeFinalizations).toHaveLength(1);
    expect(result.newState.jBatchState?.batch.revealSecrets).toEqual([
      { transformer: transformerAddress, secret: proofSecret },
    ]);
  });
});
