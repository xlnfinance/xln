import { describe, expect, test } from 'bun:test';

import { computeAccountStateRoot } from '../../../account/commitment/state-root';
import { applyAccountInput, proposeAccountFrame } from '../../../account/consensus';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import { forkAccountReplicaShell } from '../../../account/state/account-replica-shell';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { computeEntityAccountValueHash } from '../../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import { PersistentEntityAccountMap } from '../../../entity/state/persistent-account-map';
import { signEntityHashes } from '../../../hanko/signing';
import { hashHtlcSecret } from '../../../protocol/htlc/utils';
import { safeStringify } from '../../../protocol/serialization';
import { cloneIsolatedAccountInput } from '../../../protocol/state/account-input-clone';
import { createEmptyEnv } from '../../../runtime';
import { TsAccountWorkerCoordinator } from '../../../rscore/ts-worker';
import { createJReplica } from '../../../scenarios/harness/boot';
import type { AccountInput, AccountReplica, AccountTx } from '../../../types/account';
import { makeAccount, makeJurisdiction } from '../../helpers/cross-j';

const SEED = 'ts-worker-committed-htlc-mempool';
const SECRET = `0x${'5a'.repeat(32)}`;
const LOCK_ID = hashHtlcSecret(SECRET);
const TIMESTAMP = 1_000;

const lockTx = (): Extract<AccountTx, { type: 'htlc_lock' }> => ({
  type: 'htlc_lock',
  data: {
    lockId: LOCK_ID,
    hashlock: LOCK_ID,
    timelock: 1_000_000n,
    revealBeforeHeight: 100,
    amount: 10n,
    tokenId: 1,
  },
});

const resolveTx = (): Extract<AccountTx, { type: 'htlc_resolve' }> => ({
  type: 'htlc_resolve',
  data: { lockId: LOCK_ID, outcome: 'secret', secret: SECRET },
});

const registerEntity = (
  env: ReturnType<typeof createEmptyEnv>,
  label: string,
): Readonly<{ entityId: string; signerId: string }> => {
  const signerId = deriveSignerAddressSync(SEED, label).toLowerCase();
  registerSignerKey(env, signerId, deriveSignerKeySync(SEED, label));
  return { entityId: generateLazyEntityId([signerId], 1n).toLowerCase(), signerId };
};

const signedResolveInput = async (): Promise<Readonly<{
  input: Extract<AccountInput, { kind: 'ack_frame' }>;
  receiverBase: AccountReplica;
  receiverEntityId: string;
  proposerEntityId: string;
  env: ReturnType<typeof createEmptyEnv>;
}>> => {
  const env = createEmptyEnv(SEED);
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction('committed-htlc-mempool', 31_337, 'dd', 'ee');
  const jReplica = createJReplica(env, jurisdiction.name, jurisdiction.depositoryAddress);
  jReplica.chainId = jurisdiction.chainId;
  jReplica.contracts = {
    ...jReplica.contracts,
    depository: jurisdiction.depositoryAddress,
    entityProvider: jurisdiction.entityProviderAddress,
    account: `0x${'98'.repeat(20)}`,
    deltaTransformer: `0x${'99'.repeat(20)}`,
  };
  const proposer = registerEntity(env, 'proposer');
  const receiver = registerEntity(env, 'receiver');
  const context = createAccountConsensusContext(env);
  const proposerAccount = makeAccount(proposer.entityId, receiver.entityId, jurisdiction);
  const proposerIsLeft = proposer.entityId === proposerAccount.state.leftEntity;
  const locked = await applyAccountTxToMutableReplica(
    proposerAccount,
    lockTx(),
    proposerIsLeft,
    TIMESTAMP,
    0,
    false,
    context,
  );
  if (!locked.ok) throw new Error(`COMMITTED_HTLC_FIXTURE_LOCK_REJECTED:${locked.rejection.message}`);
  proposerAccount.currentFrame.accountStateRoot = computeAccountStateRoot(proposerAccount.state);

  const receiverBase = forkAccountReplicaShell(proposerAccount);
  receiverBase.proofHeader = {
    fromEntity: receiver.entityId,
    toEntity: proposer.entityId,
    nextProofNonce: 0,
  };

  const admitted = await applyAccountInput(context, proposerAccount, {
    kind: 'enqueue',
    txs: [resolveTx()],
  });
  if (!admitted.ok) throw new Error('COMMITTED_HTLC_FIXTURE_RESOLVE_ADMISSION');
  const proposed = await proposeAccountFrame(context, proposerAccount, TIMESTAMP + 1, 0);
  if (!proposed.ok || proposed.outcome !== 'proposed') {
    throw new Error('COMMITTED_HTLC_FIXTURE_RESOLVE_PROPOSAL');
  }
  const input = cloneIsolatedAccountInput(proposed.accountInput);
  if (input.kind !== 'ack_frame') throw new Error(`COMMITTED_HTLC_FIXTURE_INPUT:${input.kind}`);
  const hankos = await signEntityHashes(
    env,
    proposer.entityId,
    proposer.signerId,
    (proposed.hashesToSign ?? []).map(row => row.hash),
  );
  const byHash = new Map((proposed.hashesToSign ?? []).map((row, index) => [
    row.hash.toLowerCase(),
    hankos[index],
  ]));
  input.proposal.frameHanko = byHash.get(input.proposal.frame.stateHash.toLowerCase());
  if (!input.proposal.frameHanko) throw new Error('COMMITTED_HTLC_FIXTURE_FRAME_HANKO');
  if (input.proposal.disputeHanko) {
    input.proposal.disputeHanko.hanko = byHash.get(input.proposal.disputeHanko.hash.toLowerCase());
    if (!input.proposal.disputeHanko.hanko) {
      throw new Error('COMMITTED_HTLC_FIXTURE_DISPUTE_HANKO');
    }
  }
  return {
    input,
    receiverBase,
    receiverEntityId: receiver.entityId,
    proposerEntityId: proposer.entityId,
    env,
  };
};

const seedQueuedDuplicate = async (
  base: AccountReplica,
  env: ReturnType<typeof createEmptyEnv>,
): Promise<AccountReplica> => {
  const account = forkAccountReplicaShell(base);
  const admitted = await applyAccountInput(createAccountConsensusContext(env), account, {
    kind: 'enqueue',
    txs: [lockTx()],
  });
  if (!admitted.ok || admitted.admittedAccountTxCount !== 1) {
    throw new Error('COMMITTED_HTLC_FIXTURE_DUPLICATE_ADMISSION');
  }
  return account;
};

const queuedLockIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) throw new Error('COMMITTED_HTLC_POST_MEMPOOL_INVALID');
  return value.flatMap((tx) => {
    if (!tx || typeof tx !== 'object' || !('type' in tx) || tx.type !== 'htlc_lock') return [];
    if (!('data' in tx) || !tx.data || typeof tx.data !== 'object' || !('lockId' in tx.data)) {
      throw new Error('COMMITTED_HTLC_POST_LOCK_INVALID');
    }
    return [String(tx.data.lockId)];
  });
};

const runInline = async (
  fixture: Awaited<ReturnType<typeof signedResolveInput>>,
): Promise<string> => {
  const account = await seedQueuedDuplicate(fixture.receiverBase, fixture.env);
  const result = await applyAccountInput(
    createAccountConsensusContext(fixture.env),
    account,
    cloneIsolatedAccountInput(fixture.input),
    {
      entityTimestamp: TIMESTAMP + 1,
      finalizedJHeight: 0,
      owningEntityIsHub: false,
      verifyHanko: createAccountConsensusContext(fixture.env).verifyHanko,
    },
  );
  if (!result.ok) throw new Error(`COMMITTED_HTLC_INLINE_REJECTED:${safeStringify(result)}`);
  expect(queuedLockIds(account.mempool)).not.toContain(LOCK_ID);
  return PersistentEntityAccountMap.fromEntries(
    [[fixture.proposerEntityId, account]],
    fixture.receiverEntityId,
    computeEntityAccountValueHash,
  ).rootHash();
};

const runWorkers = async (
  workers: 1 | 4,
  fixture: Awaited<ReturnType<typeof signedResolveInput>>,
): Promise<string> => {
  const account = await seedQueuedDuplicate(fixture.receiverBase, fixture.env);
  const coordinator = await TsAccountWorkerCoordinator.create({
    ownerEntityId: fixture.receiverEntityId,
    workerCount: workers,
    accounts: new Map([[fixture.proposerEntityId, account]]),
    jReplicas: fixture.env.state.jReplicas,
  });
  const frameId = `committed-htlc-${workers}`;
  const inbound = await coordinator.applyAccountInputs({
    frameId,
    expectedAccountsRoot: coordinator.accountsRoot,
    entityTimestamp: TIMESTAMP + 1,
    finalizedJHeight: 0,
    owningEntityIsHub: false,
    inputs: [{
      accountId: fixture.proposerEntityId,
      input: cloneIsolatedAccountInput(fixture.input),
    }],
  });
  if (!inbound.effects[0]?.result.ok) throw new Error('COMMITTED_HTLC_WORKER_REJECTED');
  const outbound = await coordinator.proposeAccountFrames({
    frameId,
    timestamp: TIMESTAMP + 1,
    jHeight: 0,
    envelopeUpdates: [],
    txs: [],
    proposals: [],
  });
  const post = outbound.postAccounts?.find(row => row.accountId === fixture.proposerEntityId);
  if (!post) throw new Error('COMMITTED_HTLC_WORKER_POST_ACCOUNT_MISSING');
  expect(queuedLockIds(post.account.mempool)).not.toContain(LOCK_ID);
  if (!outbound.accountsRoot) throw new Error('COMMITTED_HTLC_WORKER_ROOT_MISSING');
  return outbound.accountsRoot;
};

describe('committed HTLC resolve prunes stale queued lock retries', () => {
  test('W0, W1 and W4 preserve the same Account envelope and root', async () => {
    const fixture = await signedResolveInput();
    const inline = await runInline(fixture);
    expect(await runWorkers(1, fixture)).toBe(inline);
    expect(await runWorkers(4, fixture)).toBe(inline);
  });
});
