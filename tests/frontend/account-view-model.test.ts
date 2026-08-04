import { expect, test } from 'bun:test';

import { projectWalletAccountFrame } from '../../frontend/apps/wallet/src/features/accounts/account-view-model';

const LEFT = `0x${'11'.repeat(32)}`;
const RIGHT = `0x${'22'.repeat(32)}`;
const delta = {
  tokenId: 1,
  collateral: 40_000_000n,
  ondelta: 10_000_000n,
  offdelta: -2_000_000n,
  leftCreditLimit: 3_000_000n,
  rightCreditLimit: 4_000_000n,
  leftAllowance: 0n,
  rightAllowance: 0n,
  leftHold: 0n,
  rightHold: 0n,
};

const frame = (owner: string, settlement = false, crossJRisk = false) => ({
  height: 19,
  activeEntity: {
    summary: { entityId: owner, label: owner === LEFT ? 'Left' : 'Right', height: 19 },
    core: {
      entityId: owner,
      signerId: 'signer',
      height: 19,
      config: { jurisdiction: { name: 'Testnet', chainId: 31337, depositoryAddress: `0x${'33'.repeat(20)}` } },
      profile: { name: 'Wallet' },
      reserves: new Map([[1, 12_345_678n]]),
      ...(crossJRisk ? {
        crossJurisdictionSwaps: new Map([['route-1', {
          target: { counterpartyEntityId: owner, entityId: owner === LEFT ? RIGHT : LEFT, tokenId: 1, amount: 7_500_000n },
          targetPull: { pullId: 'pull-1' },
        }]]),
      } : {}),
      ...(settlement ? {
        jBatchState: {
          status: 'accumulating',
          batch: {
            flashloans: [],
            reserveToCollateral: [],
            collateralToReserve: [],
            settlements: [],
            reserveToReserve: [{ receivingEntity: RIGHT, tokenId: 1, amount: 2_000_000n }],
            disputeStarts: [],
            disputeFinalizations: [],
            externalTokenToReserve: [],
            reserveToExternalToken: [],
            revealSecrets: [],
          },
        },
      } : {}),
    },
    accounts: {
      items: [{
        state: {
          leftEntity: LEFT,
          rightEntity: RIGHT,
          deltas: new Map([[1, delta]]),
          pulls: crossJRisk ? new Map([['pull-1', {}]]) : new Map(),
          ...(settlement ? {
            settlementWorkspace: {
              workspaceHash: `0x${'aa'.repeat(32)}`,
              revision: 3,
              status: 'ready_to_submit',
              executorIsLeft: true,
              leftHanko: 'left-hanko',
              rightHanko: 'right-hanko',
            },
          } : {}),
        },
        status: 'active',
        currentHeight: 7,
        mempool: [],
      }],
    },
  },
});

test('projects canonical settlement and batch evidence without React-side financial math', () => {
  const projected = projectWalletAccountFrame(frame(LEFT, true) as never, {
    deriveDelta: (() => ({
      delta: 0n,
      collateral: 0n,
      outCollateral: 0n,
      outCapacity: 0n,
      inCapacity: 0n,
      ownCreditLimit: 0n,
      peerCreditLimit: 0n,
    })) as never,
    getTokenMeta: () => ({ symbol: 'USDC', decimals: 6 }),
    getKnownTokenIds: () => [1],
  });
  expect(projected?.accounts[0]).toMatchObject({
    workspaceStatus: 'ready_to_submit',
    workspaceRevision: 3,
    workspaceLocalIsExecutor: true,
    workspaceHasLocalHanko: true,
    workspaceHasPeerHanko: true,
  });
  expect(projected?.batch).toMatchObject({
    status: 'accumulating',
    mode: 'draft',
    draftCount: 1,
    sentCount: 0,
    hasDraftBatch: true,
    hasSentBatch: false,
    canBroadcast: true,
    reserveIssue: null,
  });
});

test('projects exact bilateral values from the canonical derive helper for both perspectives', () => {
  const perspectives: boolean[] = [];
  const deriveDelta = (_delta: typeof delta, isLeft: boolean) => {
    perspectives.push(isLeft);
    return {
      delta: isLeft ? 8_000_000n : -8_000_000n,
      collateral: 40_000_000n,
      outCollateral: isLeft ? 12_000_000n : 9_000_000n,
      outCapacity: isLeft ? 25_000_000n : 15_000_000n,
      inCapacity: isLeft ? 15_000_000n : 25_000_000n,
      ownCreditLimit: isLeft ? 3_000_000n : 4_000_000n,
      peerCreditLimit: isLeft ? 4_000_000n : 3_000_000n,
    };
  };
  const deps = {
    deriveDelta: deriveDelta as never,
    getTokenMeta: () => ({ symbol: 'USDC', decimals: 6 }),
    getKnownTokenIds: () => [1],
  };
  const left = projectWalletAccountFrame(frame(LEFT) as never, deps);
  const right = projectWalletAccountFrame(frame(RIGHT) as never, deps);

  expect(perspectives).toEqual([true, false]);
  expect(left?.accounts[0]?.counterpartyId).toBe(RIGHT);
  expect(right?.accounts[0]?.counterpartyId).toBe(LEFT);
  expect(left?.accounts[0]?.tokens[0]).toMatchObject({
    raw: '8000000', outboundRaw: '25000000', inboundRaw: '15000000', outbound: '25', inbound: '15',
  });
  expect(right?.accounts[0]?.tokens[0]).toMatchObject({
    raw: '-8000000', outboundRaw: '15000000', inboundRaw: '25000000', outbound: '15', inbound: '25',
  });
  expect(left?.reserves[0]).toMatchObject({ raw: '12345678', formatted: '12.3456' });
});

test('projects canonical cross-j dispute risk only when projection evidence is complete', () => {
  const deps = {
    deriveDelta: (() => ({
      delta: 0n, collateral: 0n, outCollateral: 0n, outCapacity: 0n, inCapacity: 0n,
      ownCreditLimit: 0n, peerCreditLimit: 0n,
    })) as never,
    getTokenMeta: () => ({ symbol: 'USDC', decimals: 6 }),
    getKnownTokenIds: () => [1],
  };
  const complete = projectWalletAccountFrame(frame(LEFT, false, true) as never, {
    ...deps, crossJRiskEvidenceComplete: true,
  });
  const incomplete = projectWalletAccountFrame(frame(LEFT, false, true) as never, {
    ...deps, crossJRiskEvidenceComplete: false,
  });
  expect(complete?.accounts[0]?.crossJTargetDisputeRisk).toEqual({
    tokenId: 1, symbol: 'USDC', amountRaw: '7500000', amount: '7.5',
  });
  expect(complete?.accounts[0]?.disputeRiskEvidenceComplete).toBe(true);
  expect(incomplete?.accounts[0]?.crossJTargetDisputeRisk).toBeNull();
  expect(incomplete?.accounts[0]?.disputeRiskEvidenceComplete).toBe(false);
});

test('fails loudly when an account does not belong to the projected entity', () => {
  const malformed = frame(`0x${'33'.repeat(32)}`);
  expect(() => projectWalletAccountFrame(malformed as never, {
    deriveDelta: (() => ({})) as never,
    getTokenMeta: () => ({ symbol: 'USDC', decimals: 6 }),
    getKnownTokenIds: () => [1],
  })).toThrow('WALLET_ACCOUNT_OWNER_MISMATCH');
});
