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
    fullHash: `0x${'11'.repeat(32)}`,
    partialRoot: `0x${'22'.repeat(32)}`,
  },
  targetPull: {
    pullId: `${orderId}:target`,
    tokenId: 1,
    amount: 90n,
    signedAmount: -90n,
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

  test('missing sibling signer fails loud (must-close fanout)', () => {
    const parties = {
      sourceUser: entity('51'),
      sourceHub: entity('52'),
      targetHub: entity('53'),
      targetUser: entity('54'),
      sourceSigner: addr('81'),
      targetSigner: '',
      sourceHubSigner: addr('83'),
      targetHubSigner: addr('84'),
    };
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const state = makeState(parties.sourceUser, parties.sourceSigner, eth, parties.sourceHub);
    const route = baseRoute('fanout-missing-signer', parties);
    delete route.targetSignerId;
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    const outputs: EntityInput[] = [];
    expect(() =>
      queueCrossJurisdictionSiblingDisputeFanout(state, outputs, parties.sourceHub, 9),
    ).toThrow(/CROSS_J_SIBLING_DISPUTE_SIGNER_MISSING/);
  });

  test('force-sibling handler fails loud when the route mirror is missing', async () => {
    const env = createEmptyEnv('force-sibling-missing-route');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const sourceSigner = registerTestSigner(env, 'force-sibling-missing-route', 'source');
    const state = makeState(sourceUser, sourceSigner, eth, sourceHub);
    addReplica(env, state, sourceSigner);
    await expect(
      handleCrossJurisdictionForceSiblingDisputeEntityTx(env, state, {
        type: 'crossJurisdictionForceSiblingDispute',
        data: {
          routeId: 'missing-route',
          observedCounterpartyEntityId: entity('63'),
          observedAt: 1,
        },
      }),
    ).rejects.toThrow(/CROSS_J_SIBLING_DISPUTE_ROUTE_MISSING/);
  });

  test('force-sibling handler rejects observed peer that is not on the other leg', async () => {
    const env = createEmptyEnv('force-sibling-mismatch');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const eth = makeJurisdiction('Ethereum', 1, '11', '12');
    const sourceUser = entity('61');
    const sourceHub = entity('62');
    const targetHub = entity('63');
    const targetUser = entity('64');
    const sourceSigner = registerTestSigner(env, 'force-sibling-mismatch', 'source');
    const state = makeState(sourceUser, sourceSigner, eth, sourceHub);
    addReplica(env, state, sourceSigner);
    const route = baseRoute('force-sibling-mismatch', {
      sourceUser,
      sourceHub,
      targetHub,
      targetUser,
      sourceSigner,
      targetSigner: addr('92'),
      sourceHubSigner: addr('93'),
      targetHubSigner: addr('94'),
    });
    state.crossJurisdictionSwaps = new Map([[route.orderId, route]]);
    // Local peer is not other-leg evidence (what the broken equality check required).
    await expect(
      handleCrossJurisdictionForceSiblingDisputeEntityTx(env, state, {
        type: 'crossJurisdictionForceSiblingDispute',
        data: {
          routeId: route.orderId,
          observedCounterpartyEntityId: sourceHub,
          observedAt: 1,
        },
      }),
    ).rejects.toThrow(/CROSS_J_SIBLING_DISPUTE_OBSERVED_LEG_INVALID/);
  });

  test('force-sibling handler prepares local dispute from live fanout observed peer', async () => {
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
    // Live fanout from target-user DisputeStarted vs targetHub sends observed=targetHub.
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
