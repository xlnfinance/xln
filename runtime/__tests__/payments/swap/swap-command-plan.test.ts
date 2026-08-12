import { describe, expect, test } from 'bun:test';

import {
  assertCrossJurisdictionSwapTargetReady,
  planSwapCommand,
} from '../../../runtime/finance/swap-command-plan';
import { createDefaultDelta } from '../../../account/state/delta';
import { entity, makeAccount } from '../../helpers/cross-j';

const sourceUser = entity('11');
const sourceHub = entity('22');
const targetUser = entity('33');
const targetHub = entity('44');
const sourceSigner = `0x${'51'.repeat(20)}`;
const sourceHubSigner = `0x${'52'.repeat(20)}`;
const targetSigner = `0x${'53'.repeat(20)}`;
const targetHubSigner = `0x${'54'.repeat(20)}`;
const sourceJurisdiction = `stack:11155111:0x${'61'.repeat(20)}`;
const targetJurisdiction = `stack:728126428:0x${'62'.repeat(20)}`;

const partyRoles = (entityId: string, entityIsHub: boolean, hubEntityId: string, hubIsHub = true) => ({
  entityRoleEvidence: { entityId, isHub: entityIsHub, source: 'committed-profile' as const },
  hubRoleEvidence: { entityId: hubEntityId, isHub: hubIsHub, source: 'verified-gossip-profile' as const },
  committedRoles: new Map([[entityId, entityIsHub]]),
});

const sourceAccount = () => {
  const account = makeAccount(sourceUser, sourceHub);
  const token = account.state.deltas.get(1)!;
  token.offdelta = 1_000n;
  return account;
};

const baseInput = () => ({
  logicalTimestamp: 1_700_000_000_000,
  logicalHeight: 42,
  routeValue: `${sourceHub}:${targetHub}`,
  giveTokenId: 1,
  wantTokenId: 3,
  giveAmount: 1_000n,
  priceTicks: 10_000n,
  maxFee: 0n,
  minNetReceive: 1_000n,
  source: {
    entityId: sourceUser,
    signerId: sourceSigner,
    hubEntityId: sourceHub,
    hubSignerId: sourceHubSigner,
    jurisdiction: sourceJurisdiction,
    ...partyRoles(sourceUser, false, sourceHub),
    account: sourceAccount().state,
  },
});

describe('runtime-owned swap command plan', () => {
  test('builds one exact same-j RuntimeInput including capacity setup and offer', () => {
    const account = sourceAccount();
    account.state.deltas.delete(3);
    const plan = planSwapCommand({
      ...baseInput(),
      mode: 'same',
      source: { ...baseInput().source, account: account.state },
    });

    expect(plan.mode).toBe('same');
    expect(plan.preparedOrder).toEqual({
      priceTicks: 10_000n,
      effectiveGive: 1_000n,
      effectiveWant: 1_000n,
      unspentGiveAmount: 0n,
    });
    expect(plan.runtimeInput.entityInputs[0]?.entityTxs).toEqual([
      {
        type: 'extendCredit',
        data: {
          counterpartyEntityId: sourceHub,
          tokenId: 3,
          amount: 1_000n,
        },
      },
      {
        type: 'placeSwapOffer',
        data: {
          offerId: plan.offerId,
          counterpartyEntityId: sourceHub,
          giveTokenId: 1,
          giveAmount: 1_000n,
          wantTokenId: 3,
          wantAmount: 1_000n,
          maxFee: 0n,
          minNetReceive: 1_000n,
          priceTicks: 10_000n,
        },
      },
    ]);
  });

  test('opens a missing cross-j target account with exact credit and returns canonical M1', () => {
    const plan = planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, false, targetHub),
        account: null,
      },
      allowOpenTargetAccount: true,
    });

    expect(plan.mode).toBe('cross');
    expect(plan.targetSetupInput?.entityInputs[0]?.entityTxs).toEqual([{
      type: 'openAccount',
      data: {
        targetEntityId: targetHub,
        disputeConfig: { leftResponseSeconds: 86_400, rightResponseSeconds: 3_600 },
        tokenId: 1,
        creditAmount: 1_000n,
      },
    }]);
    expect(plan.crossJurisdictionIntent.routeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(plan.crossJurisdictionIntent.source.amount).toBe(1_000n);
    expect(plan.crossJurisdictionIntent.target.amount).toBe(1_000n);
  });

  test('planner failure emits no command and target readiness blocks M1 until setup exists', () => {
    expect(() => planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, false, targetHub),
        account: null,
      },
      allowOpenTargetAccount: false,
    })).toThrow('SWAP_INBOUND_ACCOUNT_MISSING');

    const planned = planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, false, targetHub),
        account: null,
      },
      allowOpenTargetAccount: true,
    });
    expect(() => assertCrossJurisdictionSwapTargetReady(
      planned.crossJurisdictionIntent,
      null,
    )).toThrow('SWAP_INBOUND_ACCOUNT_MISSING');

    const readyAccount = makeAccount(targetUser, targetHub);
    const targetToken = createDefaultDelta(1);
    targetToken.rightCreditLimit = 1_000n;
    readyAccount.state.deltas.set(1, targetToken);
    expect(() => assertCrossJurisdictionSwapTargetReady(
      planned.crossJurisdictionIntent,
      readyAccount.state,
    )).not.toThrow();
  });

  test('uses the committed Hub role for a missing Hub target account', () => {
    const plan = planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, true, targetHub),
        account: null,
      },
      allowOpenTargetAccount: true,
    });
    expect(plan.targetSetupInput?.entityInputs[0]?.entityTxs[0]).toMatchObject({
      type: 'openAccount',
      data: {
        disputeConfig: { leftResponseSeconds: 3_600, rightResponseSeconds: 3_600 },
      },
    });
  });

  test('rejects a target advertised as a Hub without a verified Hub role', () => {
    expect(() => planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, false, targetHub, false),
        account: null,
      },
      allowOpenTargetAccount: true,
    })).toThrow('SWAP_COMMAND_TARGET_PARTY_INVALID');
  });

  test('committed User role vetoes a conflicting remote Hub advertisement', () => {
    expect(() => planSwapCommand({
      ...baseInput(),
      mode: 'cross',
      wantTokenId: 1,
      target: {
        entityId: targetUser,
        signerId: targetSigner,
        hubEntityId: targetHub,
        hubSignerId: targetHubSigner,
        jurisdiction: targetJurisdiction,
        ...partyRoles(targetUser, false, targetHub),
        committedRoles: new Map([[targetUser, false], [targetHub, false]]),
        account: null,
      },
      allowOpenTargetAccount: true,
    })).toThrow(`ACCOUNT_ROLE_EVIDENCE_COMMITTED_CONFLICT:${targetHub}`);
  });
});
