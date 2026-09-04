import { expect, test } from 'bun:test';

import {
  PersistentAccountStateMap,
  requirePersistentAccountStateMap,
} from '../../../account/state/persistent-state-map';
import { applyAccountTxToMutableReplica } from '../../../account/tx/apply';
import { checkAutoRebalance } from '../../../account/tx/handlers/rebalance/request-collateral';
import { createWorkerConsensusContext, type TsAccountWorkerState } from '../../../rscore/ts-worker/worker-state';
import { makeAccount } from '../../helpers/cross-j';

const userId = `0x${'11'.repeat(32)}`;
const hubId = `0x${'ff'.repeat(32)}`;

const accountAtExposure = (outPeerCredit: bigint) => {
  const account = makeAccount(userId, hubId);
  const tokenId = 1;
  const delta = account.state.deltas.get(tokenId)!;
  account.state.deltas = requirePersistentAccountStateMap(
    account.state.deltas,
    'deltas',
  ).updated(tokenId, { ...delta, offdelta: outPeerCredit });
  account.state.rebalanceFeePolicies = PersistentAccountStateMap.fromEntries('rebalanceFeePolicies', [
    [tokenId, {
      right: {
        policyVersion: 1,
        baseFee: 1n,
        liquidityFeeBps: 0n,
        gasFee: 0n,
        updatedAt: 1,
      },
    }],
  ]);
  account.shadow.rebalance.policy = requirePersistentAccountStateMap(
    account.shadow.rebalance.policy,
    'rebalanceShadowPolicy',
  ).updated(tokenId, {
    r2cRequestSoftLimit: 500n,
    hardLimit: 10_000n,
    maxAcceptableFee: 100n,
  });
  return account;
};

test('auto rebalance triggers exactly at the inclusive soft limit', () => {
  expect(checkAutoRebalance(accountAtExposure(499n), userId, hubId)).toEqual([]);

  const atLimit = checkAutoRebalance(accountAtExposure(500n), userId, hubId);
  expect(atLimit).toHaveLength(1);
  expect(atLimit[0]).toEqual({
    type: 'request_collateral',
    data: {
      tokenId: 1,
      amount: 500n,
      feeTokenId: 1,
      feeAmount: 1n,
      policyVersion: 1,
    },
  });
});

test('TS Account worker preserves the committed collateral-request event', async () => {
  const account = accountAtExposure(500n);
  const tx = checkAutoRebalance(account, userId, hubId)[0];
  if (!tx) throw new Error('AUTO_REBALANCE_TX_MISSING');
  const worker = {
    jReplicas: new Map(),
    jClaimNodes: new Map(),
  } as unknown as TsAccountWorkerState;
  const context = createWorkerConsensusContext(worker, 1_000, 0, worker.jClaimNodes);

  const result = await applyAccountTxToMutableReplica(
    account,
    tx,
    true,
    1_000,
    0,
    false,
    context,
  );

  expect(result.ok).toBe(true);
  expect(result.candidateEffects).toEqual([{
    kind: 'runtimeEvent',
    eventName: 'request_collateral_committed',
    data: {
      entityId: userId,
      accountId: hubId,
      tokenId: 1,
      requestedAmount: '499',
      prepaidFee: '1',
      requestedAt: 1_000,
    },
  }]);
});

test('TS Account worker does not emit a committed receipt for collateral-request no-ops', async () => {
  const account = accountAtExposure(500n);
  const tx = checkAutoRebalance(account, userId, hubId)[0];
  if (!tx) throw new Error('AUTO_REBALANCE_TX_MISSING');
  const worker = {
    jReplicas: new Map(),
    jClaimNodes: new Map(),
  } as unknown as TsAccountWorkerState;
  const context = createWorkerConsensusContext(worker, 1_000, 0, worker.jClaimNodes);

  const first = await applyAccountTxToMutableReplica(account, tx, true, 1_000, 0, false, context);
  expect(first.ok).toBe(true);
  const duplicate = await applyAccountTxToMutableReplica(account, tx, true, 1_001, 0, false, context);

  expect(duplicate.ok).toBe(true);
  expect(duplicate.candidateEffects ?? []).toEqual([]);
  expect(account.state.requestedRebalance.get(1)).toBe(499n);
});
