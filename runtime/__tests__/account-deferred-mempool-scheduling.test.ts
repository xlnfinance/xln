import { describe, expect, test } from 'bun:test';

import { proposeAccountFrame } from '../account/consensus/propose';
import { applyEntityInput } from '../entity/consensus';
import { generateLazyEntityId } from '../entity/factory';
import { createEmptyEnv, hasRuntimeWork } from '../runtime';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../jurisdiction/event-observation';
import { recordValidatorJHistory } from '../jurisdiction/local-history';
import { buildLocalJPrefixAttestation } from '../jurisdiction/j-prefix-consensus';
import type { AccountMachine, AccountTx, EntityReplica, JurisdictionEvent } from '../types';
import {
  addReplica,
  installJurisdictions,
  makeAccount,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from './helpers/cross-j';

const signedWorkspace = (): NonNullable<AccountMachine['settlementWorkspace']> => ({
  workspaceHash: `0x${'41'.repeat(32)}`,
  ops: [],
  settlementHash: `0x${'42'.repeat(32)}`,
  lastModifiedByLeft: true,
  status: 'submitted',
  version: 1,
  createdAt: 1,
  lastUpdatedAt: 1,
  executorIsLeft: true,
});

const repayment = (borrower: string, hub: string): AccountTx => ({
  type: 'lending_repay',
  data: {
    loanId: 'loan-deferred-scheduling',
    hubEntityId: hub,
    borrowerEntityId: borrower,
    tokenId: 1,
    amount: 101_000_000n,
  },
});

const frozenRepaymentReplica = () => {
  const env = createEmptyEnv('account-deferred-mempool-scheduling');
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction('deferred-mempool-j', 31_337, 'd1', 'e1');
  installJurisdictions(env, jurisdiction);
  const signerId = registerTestSigner(env, 'account-deferred-mempool-scheduling');
  const counterpartySignerId = registerTestSigner(env, 'account-deferred-mempool-scheduling', '2');
  const entityId = generateLazyEntityId([signerId], 1n).toLowerCase();
  const counterpartyId = generateLazyEntityId([counterpartySignerId], 1n).toLowerCase();
  const state = makeState(entityId, signerId, jurisdiction);
  const account = makeAccount(entityId, counterpartyId, jurisdiction);
  account.settlementWorkspace = signedWorkspace();
  account.mempool = [repayment(entityId, counterpartyId)];
  state.accounts.set(counterpartyId, account);
  addReplica(env, state, signerId);
  addReplica(env, makeState(counterpartyId, counterpartySignerId, jurisdiction), counterpartySignerId);
  const replica = env.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error('TEST_REPLICA_MISSING');
  return { env, replica: replica as EntityReplica, account, entityId, signerId };
};

describe('deferred Account mempool scheduling', () => {
  test('a frozen-only mempool remains durable without waking empty Entity frames', async () => {
    const { env, replica, account, entityId, signerId } = frozenRepaymentReplica();

    const proposal = await proposeAccountFrame(env, account, env.timestamp);
    expect(proposal.success).toBe(false);
    expect(proposal.error).toContain('deferred');
    expect(account.mempool.map((tx) => tx.type)).toEqual(['lending_repay']);

    expect(hasRuntimeWork(env)).toBe(false);
    const result = await applyEntityInput(env, replica, { entityId, signerId, entityTxs: [] });

    expect(result.workingReplica.state.height).toBe(replica.state.height);
    expect(result.outputs).toEqual([]);
    expect(account.mempool.map((tx) => tx.type)).toEqual(['lending_repay']);
  });

  test('an allowed control transaction beside a frozen repayment still wakes the Account', () => {
    const { env, account } = frozenRepaymentReplica();
    account.mempool.push({ type: 'reopen_disputed', data: { jNonce: 1 } });

    expect(hasRuntimeWork(env)).toBe(true);
  });

  test('a semantic J prefix finalizes even while an unrelated repayment is frozen', async () => {
    const { env, replica, account, entityId, signerId } = frozenRepaymentReplica();
    env.timestamp = 2_000;
    replica.state.prevFrameHash = `0x${'50'.repeat(32)}`;
    const jHeight = 1;
    const jBlockHash = `0x${'51'.repeat(32)}`;
    const event: JurisdictionEvent = {
      blockNumber: jHeight,
      blockHash: jBlockHash,
      transactionHash: `0x${'52'.repeat(32)}`,
      logIndex: 0,
      type: 'AccountSettled',
      data: {
        leftEntity: account.leftEntity,
        rightEntity: account.rightEntity,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '1000000',
        collateral: '1000000',
        ondelta: '0',
        nonce: 1,
      },
    };
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    replica.jHistory = recordValidatorJHistory(undefined, {
      jurisdictionRef,
      scannedThroughHeight: jHeight,
      tipBlockHash: jBlockHash,
      headers: [{ jHeight, jBlockHash }],
      blocks: [{
        jurisdictionRef,
        jHeight,
        jBlockHash,
        eventsHash: canonicalJurisdictionEventsHash([event]),
        events: [event],
      }],
    }, replica.state);
    const attestation = buildLocalJPrefixAttestation(env, replica);
    if (!attestation) throw new Error('TEST_J_PREFIX_ATTESTATION_MISSING');
    // A peer Account frame may commit after the watcher signs but before its
    // attestation reaches Entity consensus. The old vote is terminally stale;
    // the same durable local J event must be re-attested for the new parent.
    replica.state.height += 1;
    replica.state.prevFrameHash = `0x${'53'.repeat(32)}`;
    const heightBeforeApply = replica.state.height;

    const result = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.state.height).toBe(heightBeforeApply + 1);
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(jHeight);
    expect(result.workingReplica.state.accounts.get(account.rightEntity === entityId ? account.leftEntity : account.rightEntity)?.mempool)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'lending_repay' })]));
  });
});
