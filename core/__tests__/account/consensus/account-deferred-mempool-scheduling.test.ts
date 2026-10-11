import { describe, expect, test } from 'bun:test';
import { createAccountConsensusContext } from '../../../entity/account/account-consensus-context';

import { proposeAccountFrame } from '../../../account/consensus/proposal/propose';
import { createSettlementWorkspaceHash } from '../../../account/tx/handlers/settlement/transition';
import { buildSignedEntityCommand } from '../../../entity/command';
import { signedEntityCommandTx } from '../../../entity/command/command-codec';
import { applyEntityInput } from '../../../entity/consensus';
import { generateLazyEntityId } from '../../../entity/factory';
import { createEmptyEnv, hasRuntimeWork } from '../../../runtime';
import { canonicalJurisdictionEventsHash, getJEventJurisdictionRef } from '../../../jurisdiction/machine/event-observation';
import { recordValidatorJHistory } from '../../../jurisdiction/machine/local-history';
import { buildLocalJPrefixAttestation } from '../../../jurisdiction/machine/history/j-prefix-consensus';
import type { AccountState, AccountTx } from '../../../types/account';
import type { EntityReplica } from '../../../entity/types';
import type { JurisdictionEvent } from '../../../types/jurisdiction-events';
import {
  isProposedAccountFrame,
  proposeAccountFrameMessage,
} from '../../../account/consensus/result';
import {
  addReplica,
  installJurisdictions,
  makeAccount,
  makeJurisdiction,
  makeState,
  openWritableEntityAccounts,
  registerTestSigner,
} from '../../helpers/cross-j';

const signedWorkspace = (
  account: Pick<AccountState, 'leftEntity' | 'rightEntity'>,
): NonNullable<AccountState['settlementWorkspace']> => {
  const workspace: NonNullable<AccountState['settlementWorkspace']> = {
    workspaceHash: `0x${'00'.repeat(32)}`,
    ops: [],
    settlementHash: `0x${'42'.repeat(32)}`,
    lastModifiedByLeft: true,
    status: 'submitted',
    version: 1,
    createdAt: 1,
    lastUpdatedAt: 1,
    executorIsLeft: true,
  };
  workspace.workspaceHash = createSettlementWorkspaceHash(account.state, workspace);
  return workspace;
};

const repayment = (borrower: string, hub: string): AccountTx => ({
  type: 'lending_repay',
  data: {
    loanId: 'loan-deferred-scheduling',
    hubEntityId: hub,
    borrowerEntityId: borrower,
    tokenId: 1,
    amount: 101_000_000n,
    claimHash: `0x${'11'.repeat(32)}`,
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
  account.state.settlementWorkspace = signedWorkspace(account);
  account.mempool = [repayment(entityId, counterpartyId)];
  openWritableEntityAccounts(state).set(counterpartyId, account);
  addReplica(env, state, signerId);
  addReplica(env, makeState(counterpartyId, counterpartySignerId, jurisdiction), counterpartySignerId);
  const replica = env.state.eReplicas.get(`${entityId}:${signerId}`);
  if (!replica) throw new Error('TEST_REPLICA_MISSING');
  return { env, replica: replica as EntityReplica, account, entityId, signerId };
};

describe('deferred Account mempool scheduling', () => {
  test('a frozen-only mempool remains durable without waking empty Entity frames', async () => {
    const { env, replica, account, entityId, signerId } = frozenRepaymentReplica();

    const proposal = await proposeAccountFrame(createAccountConsensusContext(env), account, env.state.timestamp);
    expect(isProposedAccountFrame(proposal)).toBe(false);
    expect(proposal.ok).toBe(true);
    expect(proposal.outcome).toBe('idle');
    expect('accountInput' in proposal).toBe(false);
    expect('rejection' in proposal).toBe(false);
    expect(proposeAccountFrameMessage(proposal)).toContain('deferred');
    expect(account.mempool.map((tx) => tx.type)).toEqual(['lending_repay']);

    expect(hasRuntimeWork(env)).toBe(false);
    const result = await applyEntityInput(env, replica, { entityId, signerId, entityTxs: [] });

    expect(result.workingReplica.state.height).toBe(replica.state.height);
    expect(result.outputs).toEqual([]);
    expect(account.mempool.map((tx) => tx.type)).toEqual(['lending_repay']);
  });

  test('J-event bookkeeping beside a frozen repayment still wakes the Account', () => {
    const { env, account } = frozenRepaymentReplica();
    account.mempool.push({
      type: 'j_event_claim',
      data: {
        jHeight: 1,
        jBlockHash: `0x${'51'.repeat(32)}`,
        events: [],
      },
    });

    expect(hasRuntimeWork(env)).toBe(true);
  });

  test('retired J-event work cannot wake a permanently closed Account', () => {
    const { env, account } = frozenRepaymentReplica();
    account.status = 'disputed';
    delete account.activeDispute;
    account.mempool = [{
      type: 'j_event_claim',
      data: {
        jHeight: 1,
        jBlockHash: `0x${'51'.repeat(32)}`,
        events: [],
      },
    }];

    expect(hasRuntimeWork(env)).toBe(false);
  });

  test('a semantic J prefix finalizes even while an unrelated repayment is frozen', async () => {
    const { env, replica, account, entityId, signerId } = frozenRepaymentReplica();
    env.state.timestamp = 2_000;
    const jHeight = 1;
    const jBlockHash = `0x${'51'.repeat(32)}`;
    const event: JurisdictionEvent = {
      blockNumber: jHeight,
      blockHash: jBlockHash,
      transactionHash: `0x${'52'.repeat(32)}`,
      logIndex: 0,
      type: 'AccountSettled',
      data: {
        leftEntity: account.state.leftEntity,
        rightEntity: account.state.rightEntity,
        tokenId: 1,
        leftReserve: '0',
        rightReserve: '1000000',
        collateral: '1000000',
        ondelta: '0',
        nonce: 1,
      },
    };
    const jurisdictionRef = getJEventJurisdictionRef(replica.state.config.jurisdiction);
    const jHistory = recordValidatorJHistory(undefined, {
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
    const attestation = buildLocalJPrefixAttestation(env, replica, jHistory);
    if (!attestation) throw new Error('TEST_J_PREFIX_ATTESTATION_MISSING');
    // An unrelated signed Entity command commits before the watcher observation
    // reaches consensus. Its old vote is stale; the same local J history must
    // be re-attested against the genuinely certified new parent.
    const parent = await applyEntityInput(env, replica, {
      entityId,
      signerId,
      entityTxs: [signedEntityCommandTx(buildSignedEntityCommand(env, replica.state, signerId, [{
        type: 'chat',
        data: { from: signerId, message: 'advance parent before watcher delivery' },
      }]))],
    });
    expect(parent.outcome).toEqual({ kind: 'committed' });
    expect(parent.workingReplica.state.height).toBe(replica.state.height + 1);
    expect(parent.workingReplica.certifiedFrameHead).toBeDefined();
    parent.workingReplica.jHistory = jHistory;
    const heightBeforeApply = parent.workingReplica.state.height;

    const result = await applyEntityInput(env, parent.workingReplica, {
      entityId,
      signerId,
      jPrefixAttestations: new Map([[signerId, attestation]]),
    });

    expect(result.outcome).toEqual({ kind: 'committed' });
    expect(result.workingReplica.state.height).toBe(heightBeforeApply + 1);
    expect(result.workingReplica.state.lastFinalizedJHeight).toBe(jHeight);
    expect(result.workingReplica.state.accounts.get(account.state.rightEntity === entityId ? account.state.leftEntity : account.state.rightEntity)?.mempool)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'lending_repay' })]));
  });
});
