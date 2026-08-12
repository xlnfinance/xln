import { expect, test } from 'bun:test';

import { createAccountConsensusContext } from '../entity/account/account-consensus-context';
import { shouldSuppressReturnedAccountTx } from '../entity/consensus/frame-tx-effects';
import { applyAccountSettledJEvent } from '../entity/tx/j-events-account-settled';
import type { FinalizedJEventContext } from '../entity/tx/j-events';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import { createEmptyEnv } from '../runtime';
import type { JurisdictionEvent } from '../types/jurisdiction-events';
import { applyJEventRange } from './helpers/j-history';
import {
  entity,
  addReplica,
  addr,
  installJurisdictions,
  makeJurisdiction,
  makeState,
  registerTestSigner,
  secret,
} from './helpers/cross-j';

test('persisted dispute preparation suppresses unbounded settlement claims without losing reserve finality', () => {
  const env = createEmptyEnv('account-settled-dispute-policy');
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction('claim-policy-j', 31_337, 'd1', 'e1');
  installJurisdictions(env, jurisdiction);
  const signerId = registerTestSigner(env, 'account-settled-dispute-policy');
  const entityId = entity('11');
  const counterpartyId = entity('22');
  const state = makeState(entityId, signerId, jurisdiction, counterpartyId);
  const account = state.accounts.get(counterpartyId)!;
  account.status = 'dispute_preparing';
  account.disputePrepare = {
    startedAt: 1,
    readyAfter: 1,
    reason: 'persisted-preparation',
  };
  const accountTxs: FinalizedJEventContext['accountTxs'] = [];
  const dirtyAccounts = new Set<string>();
  const candidateEffects = [];

  for (let blockNumber = 1; blockNumber <= 1_001; blockNumber += 1) {
    const event: JurisdictionEvent = {
      blockNumber,
      blockHash: secret('31'),
      transactionHash: secret('32'),
      logIndex: 0,
      type: 'AccountSettled',
      data: {
        leftEntity: account.state.leftEntity,
        rightEntity: account.state.rightEntity,
        tokenId: 1,
        leftReserve: String(blockNumber),
        rightReserve: '0',
        collateral: String(blockNumber),
        ondelta: '0',
        nonce: blockNumber,
      },
    };
    applyAccountSettledJEvent({
      entityState: state,
      newState: state,
      event,
      env,
      accountConsensusContext: createAccountConsensusContext(env),
      blockNumber,
      transactionHash: event.transactionHash!,
      accountTxs,
      outputs: [],
      dirtyAccounts,
    }, candidateEffects);
  }

  expect(state.reserves.get(1)).toBe(1_001n);
  expect(accountTxs).toEqual([]);
  expect(account.mempool).toEqual([]);
  expect(dirtyAccounts).toEqual(new Set());
});

test('one certified AccountSettled then DisputeStarted range cannot requeue a terminal claim', async () => {
  const env = createEmptyEnv('account-settled-dispute-same-range');
  env.quietRuntimeLogs = true;
  const jurisdiction = makeJurisdiction('claim-same-range-j', 31_337, 'd2', 'e2');
  installJurisdictions(env, jurisdiction);
  const signerId = registerTestSigner(env, 'account-settled-dispute-same-range');
  const entityId = entity('13');
  const counterpartyId = entity('23');
  const state = makeState(entityId, signerId, jurisdiction, counterpartyId);
  const account = state.accounts.get(counterpartyId)!;
  const proof = buildAccountProofBody(account, addr('99'));
  const blockNumber = 1;
  const blockHash = secret('71');
  const events: JurisdictionEvent[] = [
    {
      blockNumber,
      blockHash,
      transactionHash: secret('72'),
      logIndex: 0,
      type: 'AccountSettled',
      data: {
        leftEntity: account.state.leftEntity,
        rightEntity: account.state.rightEntity,
        tokenId: 1,
        leftReserve: '9',
        rightReserve: '0',
        collateral: '9',
        ondelta: '0',
        nonce: 1,
      },
    },
    {
      blockNumber,
      blockHash,
      transactionHash: secret('73'),
      logIndex: 1,
      type: 'DisputeStarted',
      data: {
        sender: entityId,
        counterentity: counterpartyId,
        nonce: '1',
        proposerIsLeft: true,
        proofbodyHash: proof.proofBodyHash,
        initialProofbody: proof.proofBodyStruct,
        starterInitialArguments: '0x',
        starterCounterArguments: '0x',
        starterCounterProofCommitment: `0x${'00'.repeat(32)}`,
        disputeStartTimestamp: 100,
        disputeTimeout: 120,
        leftResponseSeconds: 10,
        rightResponseSeconds: 10,
        watchSeed: account.state.watchSeed,
      },
    },
  ];
  addReplica(env, state, signerId);
  const result = await applyJEventRange(state, {
    from: signerId,
    jurisdictionRef: '',
    event: events[0]!,
    events,
    observedAt: blockNumber,
    blockNumber,
    blockHash,
  }, env);

  const finalized = result.newState.accounts.get(counterpartyId)!;
  expect(finalized.status).toBe('disputed');
  expect(result.accountTxs).toHaveLength(1);
  expect(result.accountTxs.filter(() => !shouldSuppressReturnedAccountTx(finalized))).toEqual([]);
  expect(result.newState.reserves.get(1)).toBe(9n);
});
