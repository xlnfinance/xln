import { describe, expect, test } from 'bun:test';

import { committedCrossJSourceDisputeDelayMs } from '../extensions/cross-j/prepared-route';
import { queueCrossJurisdictionSiblingDisputeFanout } from '../entity/tx/j-events-htlc';
import { handleCrossJurisdictionForceSiblingDisputeEntityTx } from '../entity/tx/handlers/cross-j-force-sibling-dispute';
import { createEmptyEnv } from '../runtime';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import type { EntityInput } from '../entity/types';
import {
  addReplica,
  addr,
  entity,
  makeJurisdiction,
  makeState,
  registerTestSigner,
} from './helpers/cross-j';

const baseRoute = (
  orderId: string,
  parties: {
    sourceUser: string;
    sourceHub: string;
    targetHub: string;
    targetUser: string;
    sourceSigner: string;
    targetSigner: string;
    sourceHubSigner: string;
    targetHubSigner: string;
  },
): CrossJurisdictionSwapRoute => ({
  orderId,
  makerEntityId: parties.sourceUser,
  hubEntityId: parties.sourceHub,
  sourceSignerId: parties.sourceSigner,
  targetSignerId: parties.targetSigner,
  sourceHubSignerId: parties.sourceHubSigner,
  targetHubSignerId: parties.targetHubSigner,
  source: {
    jurisdiction: 'eth',
    entityId: parties.sourceUser,
    counterpartyEntityId: parties.sourceHub,
    tokenId: 1,
    amount: 100n,
  },
  target: {
    jurisdiction: 'base',
    entityId: parties.targetHub,
    counterpartyEntityId: parties.targetUser,
    tokenId: 1,
    amount: 90n,
  },
  sourcePull: {
    pullId: `${orderId}:source`,
    tokenId: 1,
    amount: 100n,
    signedAmount: 100n,
    revealedUntilTimestamp: 1_000_000,
    fullHash: `0x${'11'.repeat(32)}`,
    partialRoot: `0x${'22'.repeat(32)}`,
  },
  targetPull: {
    pullId: `${orderId}:target`,
    tokenId: 1,
    amount: 90n,
    signedAmount: -90n,
    revealedUntilTimestamp: 2_000_000,
    fullHash: `0x${'11'.repeat(32)}`,
    partialRoot: `0x${'22'.repeat(32)}`,
  },
  status: 'resting',
  createdAt: 1,
  updatedAt: 1,
});

describe('cross-j sibling dispute fanout', () => {
  test('target-user DisputeStarted fans out to the source-user sibling lane', () => {
    const parties = {
      sourceUser: entity('51'),
      sourceHub: entity('52'),
      targetHub: entity('53'),
      targetUser: entity('54'),
      sourceSigner: addr('81'),
      targetSigner: addr('82'),
      sourceHubSigner: addr('83'),
      targetHubSigner: addr('84'),
    };
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const state = makeState(parties.targetUser, parties.targetSigner, eth, parties.targetHub);
    const route = baseRoute('fanout-target', parties);
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    const outputs: EntityInput[] = [];
    const count = queueCrossJurisdictionSiblingDisputeFanout(
      state,
      outputs,
      parties.targetHub,
      9,
    );
    expect(count).toBe(1);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]?.entityId).toBe(parties.sourceUser.toLowerCase());
    expect(outputs[0]?.entityTxs?.[0]).toEqual({
      type: 'crossJurisdictionForceSiblingDispute',
      data: {
        routeId: route.orderId,
        observedCounterpartyEntityId: parties.targetHub.toLowerCase(),
        observedAt: 9,
      },
    });
  });

  test('force-sibling handler prepares dispute against the local route counterparty', async () => {
    const env = createEmptyEnv('force-sibling-prepare');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceSigner = registerTestSigner(env, 'force-sibling', 'source');
    const targetSigner = addr('92');
    const sourceHubSigner = addr('93');
    const targetHubSigner = addr('94');
    const state = makeState(sourceUser, sourceSigner, eth, sourceHub);
    addReplica(env, state, sourceSigner);
    const route = baseRoute('force-sibling-route', {
      sourceUser,
      sourceHub,
      targetHub,
      targetUser,
      sourceSigner,
      targetSigner,
      sourceHubSigner,
      targetHubSigner,
    });
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    const result = await handleCrossJurisdictionForceSiblingDisputeEntityTx(
      env,
      state,
      {
        type: 'crossJurisdictionForceSiblingDispute',
        data: {
          routeId: route.orderId,
          observedCounterpartyEntityId: targetHub,
          observedAt: 1,
        },
      },
    );
    const account = result.newState.accounts.get(sourceHub);
    expect(account?.status === 'dispute_preparing' || account?.status === 'disputed').toBe(true);
  });

  test('prepare rejects unequal left/right dispute delays', () => {
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('71');
    const sourceHub = entity('72');
    const state = makeState(sourceUser, addr('a1'), eth, sourceHub);
    const account = state.accounts.get(sourceHub)!;
    account.state.disputeConfig = { leftDisputeDelay: 10, rightDisputeDelay: 11 };
    const route = baseRoute('delay-mismatch', {
      sourceUser,
      sourceHub,
      targetHub: entity('73'),
      targetUser: entity('74'),
      sourceSigner: addr('a1'),
      targetSigner: addr('a2'),
      sourceHubSigner: addr('a3'),
      targetHubSigner: addr('a4'),
    });
    expect(() => committedCrossJSourceDisputeDelayMs(state, route)).toThrow(
      /CROSS_J_PREPARED_DISPUTE_DELAY_MISMATCH/,
    );
  });
});
