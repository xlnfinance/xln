import { describe, expect, test } from 'bun:test';

import {
  assertCompleteHltAuthorityEvidence,
  buildHltAuthorityEvidence,
} from '../../../scripts/operations/hlt/replay/authority-evidence';
import type { HltAuthorityFrameOracle } from '../../../scripts/operations/hlt/replay/authority-frame-oracle';
import type { AccountFrame, AccountTx } from '../../../types/account';
import type { PersistedFrameJournal } from '../../../storage/types';

const entityId = (byte: string): string => `0x${byte.repeat(32)}`;
const left = entityId('11');
const right = entityId('22');

const accountFrame = (accountTxs: AccountTx[]): AccountFrame => ({
  height: 7,
  timestamp: 1_700_000_000_000,
  jHeight: 13,
  accountTxs,
  prevFrameHash: `0x${'01'.repeat(32)}`,
  accountStateRoot: `0x${'02'.repeat(32)}`,
  stateHash: `0x${'03'.repeat(32)}`,
  byLeft: true,
  deltas: [],
});

const journal = (): PersistedFrameJournal => ({
  height: 41,
  timestamp: 1_700_000_000_000,
  replicaMetaDigest: `0x${'04'.repeat(32)}`,
  postStateHash: `0x${'05'.repeat(32)}`,
  runtimeStateHash: `0x${'06'.repeat(32)}`,
  runtimeInput: { runtimeTxs: [], entityInputs: [] },
  runtimeOutputCount: 2,
  runtimeOutputsDigest: `0x${'07'.repeat(32)}`,
  entityContexts: new Map(),
  logs: [],
});

const completeTransactions = (): AccountTx[] => [{
  type: 'direct_payment',
  data: {
    tokenId: 1,
    amount: 10n,
    route: [left, right],
    description: 'authority-direct-1',
    fromEntityId: left,
    toEntityId: right,
    deliveryMode: 'direct',
  },
}, {
  type: 'rebalance_policy',
  data: { tokenId: 1, policyVersion: 1, baseFee: 0n, liquidityFeeBps: 0n, gasFee: 0n },
}, {
  type: 'htlc_lock',
  data: {
    lockId: 'authority-lock-1',
    hashlock: `0x${'09'.repeat(32)}`,
    timelock: 99n,
    revealBeforeHeight: 98,
    amount: 10n,
    tokenId: 1,
  },
}, {
  type: 'htlc_resolve',
  data: { lockId: 'authority-lock-1', outcome: 'secret', secret: `0x${'0a'.repeat(32)}` },
}, {
  type: 'swap_offer',
  data: {
    offerId: 'authority-swap-1',
    giveTokenId: 1,
    giveTokenDecimals: 6,
    giveAmount: 10n,
    wantTokenId: 2,
    wantTokenDecimals: 6,
    wantAmount: 5n,
    maxFee: 0n,
    minNetReceive: 5n,
  },
}, {
  type: 'swap_resolve',
  data: { offerId: 'authority-swap-1', fillRatio: 65_535, cancelRemainder: true },
}, {
  type: 'j_event_claim',
  data: {
    jHeight: 13,
    jBlockHash: `0x${'0b'.repeat(32)}`,
    events: [{
      type: 'AccountSettled',
      blockNumber: 13,
      blockHash: `0x${'0b'.repeat(32)}`,
      data: {
        leftEntity: left,
        rightEntity: right,
        tokenId: 1,
        leftReserve: '90',
        rightReserve: '100',
        collateral: '10',
        ondelta: '0',
        nonce: 1,
      },
    }],
  },
}];

const oracle = (accountTxs: AccountTx[]): HltAuthorityFrameOracle => ({
  entityFrames: [{
    runtimeHeight: 41,
    entityId: left,
    entityHeight: 9,
    frameHash: `0x${'0c'.repeat(32)}`,
    stateRoot: `0x${'0d'.repeat(32)}`,
    authorityRoot: `0x${'0e'.repeat(32)}`,
  }],
  accountFrames: [{
    runtimeHeight: 41,
    entityId: left,
    counterpartyId: right,
    source: 'peerCommit',
    frame: accountFrame(accountTxs),
  }],
});

describe('HLT Rust Account-authority evidence', () => {
  test('keys economic stages and binds every R/E/A root plus ordered effects', () => {
    const evidence = buildHltAuthorityEvidence([journal()], oracle(completeTransactions()));
    expect(() => assertCompleteHltAuthorityEvidence(evidence)).not.toThrow();
    expect(evidence.economicOperations.operations.map(operation => operation.key)).toContain('lock:authority-lock-1');
    expect(evidence.economicOperations.operations.map(operation => operation.key)).toContain('swap:authority-swap-1');
    expect(evidence.economicOperations.operations.find(operation => operation.key === 'lock:authority-lock-1')?.stages)
      .toHaveLength(2);
    const lockStage = evidence.economicOperations.operations
      .find(operation => operation.key === 'lock:authority-lock-1')?.stages[0];
    expect(lockStage?.runtimeHeight).toBe(41);
    expect(Object.hasOwn(lockStage ?? {}, 'effectRefs')).toBe(false);
    expect(evidence.expectations.runtimeFrames[0]?.runtimeStateHash).toBe(`0x${'06'.repeat(32)}`);
    expect(evidence.expectations.entityFrames[0]?.authorityRoot).toBe(`0x${'0e'.repeat(32)}`);
    expect(evidence.expectations.accountFrames[0]?.accountStateRoot).toBe(`0x${'02'.repeat(32)}`);
    expect(evidence.expectations.effects[0]).toEqual({
      runtimeHeight: 41,
      outputCount: 2,
      orderedOutputDigest: `0x${'07'.repeat(32)}`,
    });
  });

  test('rejects disabled lending at artifact construction', () => {
    const lending: AccountTx = {
      type: 'lending_repay',
      data: {
        loanId: 'loan-1',
        hubEntityId: left,
        borrowerEntityId: right,
        tokenId: 1,
        amount: 1n,
      },
    };
    expect(() => buildHltAuthorityEvidence([journal()], oracle([lending])))
      .toThrow('HLT_AUTHORITY_FEATURE_POLICY_ACCOUNT_TX_FORBIDDEN:lending_repay');
  });
});
