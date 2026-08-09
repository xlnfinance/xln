import { describe, expect, test } from 'bun:test';

import { applyEntityTx } from '../entity/tx/apply';
import { createEmptyEnv } from '../runtime';
import type { CrossJurisdictionSwapRoute } from '../types/cross-jurisdiction';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute as buildPreparedCrossJurisdictionRouteCanonical,
} from '../extensions/cross-j/index';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
import { captureDisputeArgumentSnapshot, storeDisputeArgumentSnapshot } from '../protocol/dispute/arguments';
import { planCrossJurisdictionTargetRecovery } from '../entity/tx/j-events-htlc';
import { addReplica, addr, entity, jref, makeJurisdiction, makeState } from './helpers/cross-j';

const TEST_DISPUTE_CONFIG = { leftResponseSeconds: 10, rightResponseSeconds: 10 } as const;
type TestRouteInput = Omit<CrossJurisdictionSwapRoute, 'sourceDisputeConfig' | 'targetDisputeConfig'>;

const buildPreparedCrossJurisdictionRoute = (
  route: TestRouteInput,
  options: { runtimeSeed?: string; now: number },
): CrossJurisdictionSwapRoute =>
  buildPreparedCrossJurisdictionRouteCanonical(
    {
      ...route,
      sourceDisputeConfig: TEST_DISPUTE_CONFIG,
      targetDisputeConfig: TEST_DISPUTE_CONFIG,
    } as CrossJurisdictionSwapRoute,
    options,
  );

describe('cross-jurisdiction target dispute route selection', () => {
  const makeTargetDisputeRouteSelectionFixture = (scenario: string) => {
    const env = createEmptyEnv(scenario);
    env.scenarioMode = true;
    env.state.timestamp = 50_000;
    env.quietRuntimeLogs = true;
    const sourceJ = makeJurisdiction('Ethereum', 1, '11', '12');
    const targetJ = makeJurisdiction('Base', 8453, '21', '22');
    const sourceUser = entity('51');
    const sourceHub = entity('52');
    const targetHub = entity('53');
    const targetUser = entity('54');
    const sourceSigner = addr('81');
    const targetSigner = addr('82');
    const state = makeState(targetUser, targetSigner, targetJ, targetHub);
    const sourceState = makeState(sourceUser, sourceSigner, sourceJ, sourceHub);
    addReplica(env, sourceState, sourceSigner);
    addReplica(env, state, targetSigner);

    const buildRoute = (
      orderId: string,
      options: {
        status?: 'resting' | 'settled' | 'cancelled' | 'expired';
        targetHub?: string;
        withoutTargetPull?: boolean;
        sourceUser?: string;
        sourceHub?: string;
        sourceSigner?: string;
      } = {},
    ) => {
      const routeSourceUser = options.sourceUser ?? sourceUser;
      const routeSourceHub = options.sourceHub ?? sourceHub;
      const route = {
        ...buildPreparedCrossJurisdictionRoute(
          {
            orderId,
            makerEntityId: routeSourceUser,
            hubEntityId: routeSourceHub,
            sourceSignerId: options.sourceSigner ?? sourceSigner,
            source: {
              jurisdiction: jref(sourceJ),
              entityId: routeSourceUser,
              counterpartyEntityId: routeSourceHub,
              tokenId: 1,
              amount: 100n,
            },
            target: {
              jurisdiction: jref(targetJ),
              entityId: options.targetHub ?? targetHub,
              counterpartyEntityId: targetUser,
              tokenId: 1,
              amount: 90n,
            },
            status: 'resting',
            createdAt: env.state.timestamp,
            updatedAt: env.state.timestamp,
          },
          { runtimeSeed: 'test-seed', now: env.state.timestamp },
        ),
        status: options.status ?? 'resting',
        ...(options.status === undefined || options.status === 'resting'
          ? {
              cumulativeFillRatio: 0x1234,
              fillNumerator: 0x1234n,
              fillDenominator: 65_535n,
              filledSourceAmount: (100n * 0x1234n) / 65_535n,
              filledTargetAmount: (90n * 0x1234n) / 65_535n,
            }
          : {}),
      };
      if (options.withoutTargetPull) delete route.targetPull;
      return route;
    };

    const plan = (suppliedResults: Readonly<Record<string, string>> = {}) => {
      const account = state.accounts.get(targetHub)!;
      account.state.pulls = new Map();
      for (const route of state.crossJurisdictionSwaps?.values() ?? []) {
        if (!route.targetPull || route.target.entityId !== targetHub) continue;
        account.state.pulls.set(route.targetPull.pullId, {
          pullId: route.targetPull.pullId,
          tokenId: route.targetPull.tokenId,
          amount: route.targetPull.signedAmount,
          fullHash: route.targetPull.fullHash,
          partialRoot: route.targetPull.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'target'),
          createdHeight: 1,
          createdTimestamp: state.timestamp,
        });
      }
      const proof = buildAccountProofBody(account, addr('99'));
      storeDisputeArgumentSnapshot(
        account,
        captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, true, proof.proofBodyStruct),
      );
      return planCrossJurisdictionTargetRecovery(state, account, targetHub, [proof.proofBodyHash], suppliedResults);
    };

    return { env, state, targetHub, buildRoute, plan };
  };

  test('skips an older terminal route and selects the only active route', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-first');
    const terminal = fixture.buildRoute('a-terminal', { status: 'settled' });
    const active = fixture.buildRoute('z-active');
    fixture.state.crossJurisdictionSwaps?.set(terminal.orderId, terminal);
    fixture.state.crossJurisdictionSwaps?.set(active.orderId, active);

    const plan = fixture.plan();
    expect(plan).not.toBeNull();
    expect(plan?.representativeRouteId).toBe(active.orderId);
    expect(plan?.recovery.requiredPullIds).toEqual([active.targetPull!.pullId]);
    expect(plan?.recovery).not.toHaveProperty('resolveByTimestamp');
  });

  test('ignores routes in every terminal status', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-terminal-only');
    for (const status of ['settled', 'cancelled', 'expired'] as const) {
      const route = fixture.buildRoute(`terminal-${status}`, { status });
      fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    }

    expect(fixture.plan()).toBeNull();
  });

  test('ignores a route without a target pull commitment', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-no-target-pull');
    const route = fixture.buildRoute('active-without-target-pull', { withoutTargetPull: true });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);

    expect(fixture.plan()).toBeNull();
  });

  test('requires only committed-fill routes present in the selected snapshot', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-selected-snapshot');
    const selected = fixture.buildRoute('a-selected');
    const later = fixture.buildRoute('z-later');
    fixture.state.crossJurisdictionSwaps?.set(selected.orderId, selected);
    const account = fixture.state.accounts.get(fixture.targetHub)!;
    account.state.pulls = new Map([
      [
        selected.targetPull!.pullId,
        {
          pullId: selected.targetPull!.pullId,
          tokenId: selected.targetPull!.tokenId,
          amount: selected.targetPull!.signedAmount,
          fullHash: selected.targetPull!.fullHash,
          partialRoot: selected.targetPull!.partialRoot,
          crossJurisdiction: buildCrossJurisdictionPullBinding(selected, 'target'),
          createdHeight: 1,
          createdTimestamp: fixture.state.timestamp,
        },
      ],
    ]);
    const proof = buildAccountProofBody(account, addr('99'));
    storeDisputeArgumentSnapshot(
      account,
      captureDisputeArgumentSnapshot(account, proof.proofBodyHash, 1, true, proof.proofBodyStruct),
    );
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);

    const plan = planCrossJurisdictionTargetRecovery(
      fixture.state,
      account,
      fixture.targetHub,
      [proof.proofBodyHash],
      {},
    );
    expect(plan?.recovery.requiredPullIds).toEqual([selected.targetPull!.pullId]);
  });

  test('recovery covers every active route on the account', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-ambiguous');
    const later = fixture.buildRoute('z-active');
    const earlier = fixture.buildRoute('a-active');
    fixture.state.crossJurisdictionSwaps?.set(later.orderId, later);
    fixture.state.crossJurisdictionSwaps?.set(earlier.orderId, earlier);

    const plan = fixture.plan();
    expect(plan).not.toBeNull();
    expect(new Set(plan?.recovery.requiredPullIds)).toEqual(
      new Set([earlier.targetPull!.pullId, later.targetPull!.pullId]),
    );
    expect(plan?.recovery).not.toHaveProperty('resolveByTimestamp');
  });

  test('recovery keeps supplied port results while others stay pending', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-partial-coverage');
    const covered = fixture.buildRoute('a-covered');
    const uncovered = fixture.buildRoute('z-uncovered', {
      sourceUser: entity('61'),
      sourceHub: entity('62'),
      sourceSigner: addr('83'),
    });
    fixture.state.crossJurisdictionSwaps?.set(covered.orderId, covered);
    fixture.state.crossJurisdictionSwaps?.set(uncovered.orderId, uncovered);

    const plan = fixture.plan({ [covered.targetPull!.pullId]: String(0x1234) });
    expect(plan).not.toBeNull();
    expect(plan?.recovery.resultsByPullId).toEqual({
      [covered.targetPull!.pullId]: String(0x1234),
    });
    expect(new Set(plan?.recovery.requiredPullIds)).toEqual(
      new Set([covered.targetPull!.pullId, uncovered.targetPull!.pullId]),
    );
  });

  test('ignores a route bound to another target hub', () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-target-dispute-other-hub');
    const route = fixture.buildRoute('other-target-hub', { targetHub: entity('55') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);

    expect(fixture.plan()).toBeNull();
  });

  test('route-bound disputeStart fails loudly before touching an unknown route', async () => {
    const env = createEmptyEnv('cross-route-bound-dispute-missing');
    env.scenarioMode = true;
    env.quietRuntimeLogs = true;
    const sourceUser = entity('55');
    const sourceHub = entity('56');
    const signer = addr('82');
    const state = makeState(sourceUser, signer, makeJurisdiction('Ethereum', 1, '11', '12'), sourceHub);

    await expect(
      applyEntityTx(env, state, {
        type: 'disputeStart',
        data: { counterpartyEntityId: sourceHub, crossJurisdictionRouteId: 'missing-route' },
      }),
    ).rejects.toThrow('DISPUTE_START_CROSS_J_ROUTE_MISSING:missing-route');
  });

  test('route-bound disputeStart rejects a route from another bilateral account', async () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-route-bound-role-mismatch');
    const route = fixture.buildRoute('wrong-target-account', { targetHub: entity('99') });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    await expect(
      applyEntityTx(fixture.env, fixture.state, {
        type: 'disputeStart',
        data: { counterpartyEntityId: fixture.targetHub, crossJurisdictionRouteId: route.orderId },
      }),
    ).rejects.toThrow(`DISPUTE_START_CROSS_J_ROUTE_ROLE_MISMATCH:${route.orderId}`);
  });

  test('route-bound disputeStart requires source and target pulls', async () => {
    const fixture = makeTargetDisputeRouteSelectionFixture('cross-route-bound-pulls-missing');
    const route = fixture.buildRoute('no-target-pull', { withoutTargetPull: true });
    fixture.state.crossJurisdictionSwaps?.set(route.orderId, route);
    await expect(
      applyEntityTx(fixture.env, fixture.state, {
        type: 'disputeStart',
        data: { counterpartyEntityId: fixture.targetHub, crossJurisdictionRouteId: route.orderId },
      }),
    ).rejects.toThrow(`DISPUTE_START_CROSS_J_PULLS_MISSING:${route.orderId}`);
  });
});
