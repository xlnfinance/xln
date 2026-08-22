import { describe, expect, test } from 'bun:test';
import type { EntityReplica, Profile } from '../../../api/public/runtime-module';
import { deriveSwapNetAuthorization } from '../../../account/swap/swap-net-authorization';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import {
  planSwapCommand,
  type SwapCommandPlanInput,
} from '../../../runtime/swap-cmd/swap-command-plan';
import { planSameJSwapCommand } from '../../../../frontend/src/lib/components/Entity/swap/commands/same-j-swap-command';
import { entity, makeAccount } from '../../helpers/cross-j';

const sourceEntityId = entity('11');
const hubEntityId = entity('22');
const sourceSignerId = `0x${'31'.repeat(20)}`;
const hubSignerId = `0x${'32'.repeat(20)}`;
const jurisdiction = `stack:31337:0x${'41'.repeat(20)}`;

describe('same-j swap command helper', () => {
  test('passes the exact canonical same-j planner input and returns the same plan', () => {
    const account = makeAccount(sourceEntityId, hubEntityId);
    account.state = {
      ...account.state,
      deltas: PersistentAccountStateMap.fromEntries('deltas', [[1, {
        ...account.state.deltas.get(1)!,
        offdelta: 50_000n,
      }]]),
    };
    const committedRoles = new Map([[sourceEntityId, false]]);
    const roles = {
      entityRoleEvidence: {
        entityId: sourceEntityId,
        isHub: false,
        source: 'committed-profile' as const,
      },
      hubRoleEvidence: {
        entityId: hubEntityId,
        isHub: true,
        source: 'verified-gossip-profile' as const,
      },
    };
    const replica = {
      entityId: sourceEntityId,
      signerId: sourceSignerId,
      state: {
        entityId: sourceEntityId,
        accounts: new Map([[hubEntityId, account]]),
      },
    } as unknown as EntityReplica;
    const profile = {
      entityId: hubEntityId,
      metadata: { isHub: true, swapTakerFeeBps: 25 },
    } as Profile;
    const netAuthorization = deriveSwapNetAuthorization(20_000n, 25);
    const expectedInput: SwapCommandPlanInput = {
      mode: 'same',
      logicalTimestamp: 1_700_000_000_000,
      logicalHeight: 42,
      routeValue: 'same',
      giveTokenId: 1,
      giveTokenDecimals: 6,
      wantTokenId: 3,
      wantTokenDecimals: 6,
      giveAmount: 20_000n,
      priceTicks: 10_000n,
      ...netAuthorization,
      source: {
        entityId: sourceEntityId,
        signerId: sourceSignerId,
        hubEntityId,
        hubSignerId,
        jurisdiction,
        ...roles,
        committedRoles,
        account: account.state,
      },
      expiresInMs: 24 * 60 * 60 * 1_000,
    };
    let receivedInput: SwapCommandPlanInput | null = null;
    const actual = planSameJSwapCommand({
      committedSourceReplica: replica,
      runtimeView: { committedRoles },
      source: { entityId: sourceEntityId, signerId: sourceSignerId, jurisdiction },
      hub: { entityId: hubEntityId, signerId: hubSignerId, profile },
      roles,
      tokens: {
        giveTokenId: 1,
        giveTokenDecimals: 6,
        wantTokenId: 3,
        wantTokenDecimals: 6,
      },
      giveAmount: 20_000n,
      priceTicks: 10_000n,
      routeValue: 'same',
      expectedWantAmount: 20_000n,
      logicalClock: { logicalTimestamp: 1_700_000_000_000, logicalHeight: 42 },
      runtimeFunctions: {
        deriveSwapNetAuthorization,
        planSwapCommand: (input) => {
          receivedInput = input;
          return planSwapCommand(input);
        },
      },
    });

    expect(receivedInput).toEqual(expectedInput);
    expect(actual).toEqual(planSwapCommand(expectedInput));
  });
});
