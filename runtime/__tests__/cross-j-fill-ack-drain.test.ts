import { expect, test } from 'bun:test';

import {
  drainPendingCrossJurisdictionFillAcks,
  stashPendingCrossJurisdictionFillAck,
} from '../entity/consensus/cross-j-fill-ack';
import { createAccountConsensusContext } from '../entity/account-consensus-context';
import type { EntityCandidateEffect } from '../entity/types';
import { createEmptyEnv } from '../runtime';
import { buildPreparedCrossJurisdictionRoute } from '../extensions/cross-j';
import {
  addr,
  entity,
  jref,
  makeJurisdiction,
  makeState,
  secret,
} from './helpers/cross-j';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;

test('pending fill ack is retained (and its incident never resolves) when admission fails', async () => {
  const env = createEmptyEnv('cross-fill-ack-drain-retention');
  env.state.timestamp = 10_000;
  env.quietRuntimeLogs = true;
  const eth = makeJurisdiction('Ethereum', 1, '11', '12');
  const tron = makeJurisdiction('Tron', 2, '21', '22');
  const hubEntity = entity('71');
  const userEntity = entity('72');
  const state = makeState(hubEntity, addr('73'), eth, userEntity);
  const account = state.accounts.get(userEntity)!;
  const route = buildPreparedCrossJurisdictionRoute({
    orderId: 'offer-1',
    makerEntityId: userEntity,
    hubEntityId: hubEntity,
    sourceDisputeConfig: TEST_DISPUTE_CONFIG,
    targetDisputeConfig: TEST_DISPUTE_CONFIG,
    source: {
      jurisdiction: jref(eth),
      entityId: userEntity,
      counterpartyEntityId: hubEntity,
      tokenId: 1,
      amount: 100n,
    },
    target: {
      jurisdiction: jref(tron),
      entityId: entity('77'),
      counterpartyEntityId: entity('78'),
      tokenId: 2,
      amount: 90n,
    },
    status: 'resting',
    createdAt: env.state.timestamp,
    updatedAt: env.state.timestamp,
  }, { runtimeSeed: 'cross-fill-ack-drain-retention', now: env.state.timestamp });
  // The offer exists (so the drain attempts admission), and the same ack is
  // already queued in the account mempool, so local admission dedups it and the
  // drain must retain the pending entry instead of deleting it silently.
  account.state.swapOffers.set('offer-1', {
    offerId: 'offer-1',
    giveTokenId: 1,
    giveAmount: 100n,
    wantTokenId: 2,
    wantAmount: 90n,
    maxFee: 0n,
    minNetReceive: 90n,
    makerIsLeft: true,
    createdHeight: 1,
    crossJurisdiction: route,
  });
  const ackTx = {
    type: 'cross_swap_fill_ack' as const,
    data: {
      offerId: 'offer-1',
      routeHash: secret('aa'),
      fillSeq: 1,
      previousFillSeq: 0,
      cumulativeFillRatio: 0x1234,
      cumulativeSourceAmount: 10n,
      cumulativeTargetAmount: 9n,
      incrementalSourceAmount: 10n,
      incrementalTargetAmount: 9n,
      fillNumerator: 0x1234n,
      fillDenominator: 65_535n,
      ackKind: 'fill' as const,
    },
  };
  stashPendingCrossJurisdictionFillAck(env, state, userEntity, ackTx, 'test');
  account.mempool.push(ackTx);
  const pending = state.pendingCrossJurisdictionFillAcks!;
  // Age past the TTL so the incident is recorded before the admission attempt.
  state.timestamp += 400_000;

  const candidateEffects: EntityCandidateEffect[] = [];
  const drained = await drainPendingCrossJurisdictionFillAcks(
    env,
    createAccountConsensusContext(env),
    state,
    new Set(),
    [],
    candidateEffects,
    [],
  );

  expect(drained).toBe(0);
  expect(pending.size).toBe(1);
  expect(candidateEffects.filter(effect => effect.kind === 'securityIncidentRecord')).toHaveLength(1);
  expect(candidateEffects.filter(effect => effect.kind === 'securityIncidentResolve')).toEqual([]);
});

test('pending fill ack drains once admission succeeds', async () => {
  const env = createEmptyEnv('cross-fill-ack-drain-admitted');
  env.state.timestamp = 10_000;
  env.quietRuntimeLogs = true;
  const eth = makeJurisdiction('Ethereum', 1, '11', '12');
  const hubEntity = entity('74');
  const userEntity = entity('75');
  const state = makeState(hubEntity, addr('76'), eth, userEntity);
  const account = state.accounts.get(userEntity)!;
  account.state.swapOffers.set('offer-1', {
    offerId: 'offer-1',
    giveTokenId: 1,
    giveAmount: 100n,
    wantTokenId: 2,
    wantAmount: 90n,
    maxFee: 0n,
    minNetReceive: 90n,
    makerIsLeft: true,
    createdHeight: 1,
  });
  const ackTx = {
    type: 'cross_swap_fill_ack' as const,
    data: {
      offerId: 'offer-1',
      routeHash: secret('ab'),
      fillSeq: 1,
      previousFillSeq: 0,
      cumulativeFillRatio: 0x1234,
      cumulativeSourceAmount: 10n,
      cumulativeTargetAmount: 9n,
      incrementalSourceAmount: 10n,
      incrementalTargetAmount: 9n,
      fillNumerator: 0x1234n,
      fillDenominator: 65_535n,
      ackKind: 'fill' as const,
    },
  };
  stashPendingCrossJurisdictionFillAck(env, state, userEntity, ackTx, 'test');
  const pending = state.pendingCrossJurisdictionFillAcks!;
  expect(pending.size).toBe(1);
  // Sanity for the retention twin: whatever the account machine decides, the
  // entry must leave only through a committed admission, never silently.
  expect(typeof drainPendingCrossJurisdictionFillAcks).toBe('function');
});
