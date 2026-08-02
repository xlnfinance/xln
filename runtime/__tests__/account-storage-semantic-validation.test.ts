import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import { computeAccountStateRoot } from '../account/state-root';
import { createSettlementWorkspaceHash } from '../account/tx/handlers/settle-transition';
import { deriveDelta } from '../account/utils';
import { validateDelta } from '../account/delta-validation';
import { FINANCIAL, LIMITS, TOKENS } from '../config/constants';
import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';
import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/projections';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
  validateStorageDiffRecordValue,
} from '../storage/authoritative-schema';
import type { StorageAccountDoc } from '../storage/types';
import { entity, makeAccount } from './helpers/cross-j';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

type ValidationContext = {
  doc: StorageAccountDoc;
  owner: string;
  counterparty: string;
};

type Mutation = {
  name: string;
  expected: 'accept' | 'reject';
  mutate: (value: ValidationContext) => void | Promise<void>;
};

const makeFixture = async (): Promise<ValidationContext> => {
  const owner = entity('11');
  const counterparty = entity('22');
  const account = makeAccount(owner, counterparty);
  const delta = account.state.deltas.get(1)!;
  account.state.locks.set('lock-1', {
    lockId: 'lock-1',
    hashlock: digest('31'),
    timelock: 2_000n,
    revealBeforeHeight: 20,
    amount: 7n,
    tokenId: 1,
    senderIsLeft: true,
    createdHeight: 1,
    createdTimestamp: 1_000,
  });
  account.state.pulls = new Map([['pull-1', {
    pullId: 'pull-1',
    tokenId: 1,
    amount: 5n,
    revealedUntilTimestamp: 3_000,
    fullHash: digest('32'),
    partialRoot: digest('33'),
    createdHeight: 1,
    createdTimestamp: 1_000,
    crossJurisdiction: {
      orderId: 'cross-storage-1',
      routeHash: digest('34'),
      leg: 'source',
      status: 'resting',
    },
  }]]);
  account.state.swapOffers.set('offer-1', {
    offerId: 'offer-1',
    giveTokenId: 1,
    giveAmount: 5n,
    wantTokenId: 2,
    wantAmount: 10n,
    makerIsLeft: true,
    createdHeight: 1,
  });
  account.state.subcontracts = new Map([['transformer-1', {
    transformerAddress: `0x${'44'.repeat(20)}`,
    encodedBatch: '0x1234',
    allowances: [{ deltaIndex: 0, rightAllowance: 1n, leftAllowance: 2n }],
  }]]);
  const workspace = {
    workspaceHash: digest('00'),
    ops: [{ type: 'r2c' as const, tokenId: 1, amount: 1n }],
    lastModifiedByLeft: true,
    status: 'draft' as const,
    revision: 1,
    createdAt: 1_000,
    lastUpdatedAt: 1_000,
    executorIsLeft: true,
  };
  account.state.settlementWorkspace = {
    ...workspace,
    workspaceHash: createSettlementWorkspaceHash(account.state, workspace),
  };
  account.pendingWithdrawals.set('withdraw-1', {
    requestId: 'withdraw-1',
    tokenId: 1,
    amount: 3n,
    requestedAt: 1_000,
    direction: 'outgoing',
    status: 'pending',
  });
  account.proofBody = {
    tokenIds: [1],
    deltas: [delta.offdelta],
    htlcLocks: [{
      deltaIndex: 0,
      amount: 7n,
      revealedUntilTimestamp: 2_000,
      hash: digest('31'),
    }],
  };
  account.proofHeader.nextProofNonce = 1;
  account.currentHeight = 1;
  account.currentFrame = {
    height: 1,
    timestamp: 1_000,
    jHeight: 0,
    accountTxs: [],
    prevFrameHash: 'genesis',
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
    byLeft: true,
    deltas: [{ ...delta }],
  };
  account.currentFrame.stateHash = await createFrameHash(account.currentFrame);
  return { doc: projectAccountDoc(account), owner, counterparty };
};

const admit = (value: ValidationContext) => hydrateAccountDocFromStorage(
  assertStorageAccountDocBinding(
    decodeValidatedBuffer(encodeBuffer(value.doc), validateStorageAccountDocValue),
    value.owner,
    value.counterparty,
    'mutation-table',
  ),
);

const mutations: Mutation[] = [
  {
    name: 'third-party proofHeader.fromEntity',
    expected: 'reject',
    mutate: ({ doc }) => { doc.proofHeader.fromEntity = digest('91'); },
  },
  {
    name: 'swapped proofHeader endpoints',
    expected: 'reject',
    mutate: ({ doc }) => {
      [doc.proofHeader.fromEntity, doc.proofHeader.toEntity] = [
        doc.proofHeader.toEntity,
        doc.proofHeader.fromEntity,
      ];
    },
  },
  {
    name: 'swapped storage owner and counterparty',
    expected: 'reject',
    mutate: (value) => { [value.owner, value.counterparty] = [value.counterparty, value.owner]; },
  },
  {
    name: 'storage owner equals counterparty',
    expected: 'reject',
    mutate: (value) => { value.counterparty = value.owner; },
  },
  {
    name: 'currentHeight differs from currentFrame.height',
    expected: 'reject',
    mutate: ({ doc }) => { doc.currentHeight = 2; },
  },
  {
    name: 'self-consistent but digest-stale frame height',
    expected: 'reject',
    mutate: ({ doc }) => {
      doc.currentHeight = 2;
      doc.currentFrame.height = 2;
      doc.currentFrame.prevFrameHash = digest('92');
    },
  },
  {
    name: 'forged schema-valid currentFrame.stateHash',
    expected: 'reject',
    mutate: ({ doc }) => { doc.currentFrame.stateHash = digest('93'); },
  },
  {
    name: 'forged accountStateRoot with recomputed frame hash',
    expected: 'accept',
    mutate: async ({ doc }) => {
      doc.currentFrame.accountStateRoot = digest('94');
      doc.currentFrame.stateHash = await createFrameHash(doc.currentFrame);
    },
  },
  {
    name: 'delta Map key differs from tokenId',
    expected: 'reject',
    mutate: ({ doc }) => {
      const delta = doc.state.deltas.get(1)!;
      doc.state.deltas = new Map([[2, delta]]);
    },
  },
  {
    name: 'negative collateral',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.collateral = -1n; },
  },
  {
    name: 'negative credit limit',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.leftCreditLimit = -1n; },
  },
  {
    name: 'credit limit above the transition ceiling',
    expected: 'reject',
    mutate: ({ doc }) => {
      doc.state.deltas.get(1)!.leftCreditLimit = FINANCIAL.MAX_PAYMENT_AMOUNT * 1000n + 1n;
    },
  },
  {
    name: 'negative allowance',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.rightAllowance = -1n; },
  },
  {
    name: 'negative hold',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.leftHold = -1n; },
  },
  {
    name: 'negative allowance inside currentFrame',
    expected: 'reject',
    mutate: ({ doc }) => { doc.currentFrame.deltas[0]!.leftAllowance = -1n; },
  },
  {
    name: 'opaque HTLC hashlock accepted by Account transition semantics',
    expected: 'accept',
    mutate: ({ doc }) => { object(doc.state.locks.get('lock-1'))['hashlock'] = 'not-a-hash'; },
  },
  {
    name: 'negative HTLC lock amount',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.locks.get('lock-1'))['amount'] = -1n; },
  },
  {
    name: 'non-string HTLC hashlock',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.locks.get('lock-1'))['hashlock'] = { nested: true }; },
  },
  {
    name: 'HTLC lock map above the transition limit',
    expected: 'reject',
    mutate: ({ doc }) => {
      const lock = doc.state.locks.get('lock-1')!;
      doc.state.locks = new Map(Array.from(
        { length: LIMITS.MAX_ACCOUNT_HTLC_LOCKS + 1 },
        (_, index) => [`lock-${index}`, { ...lock, lockId: `lock-${index}` }],
      ));
    },
  },
  {
    name: 'malformed bounded pull',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.pulls?.get('pull-1'))['fullHash'] = 'not-a-hash'; },
  },
  {
    name: 'zero-amount pull',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.pulls?.get('pull-1'))['amount'] = 0n; },
  },
  {
    name: 'pull without its canonical cross-j binding',
    expected: 'reject',
    mutate: ({ doc }) => { delete object(doc.state.pulls?.get('pull-1'))['crossJurisdiction']; },
  },
  {
    name: 'zero-amount bounded swap offer',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.swapOffers.get('offer-1'))['wantAmount'] = 0n; },
  },
  {
    name: 'swap offer token above the protocol maximum',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.swapOffers.get('offer-1'))['giveTokenId'] = TOKENS.MAX_TOKEN_ID + 1; },
  },
  {
    name: 'malformed bounded subcontract',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.subcontracts?.get('transformer-1'))['transformerAddress'] = digest('95'); },
  },
  {
    name: 'negative subcontract allowance',
    expected: 'reject',
    mutate: ({ doc }) => {
      object(doc.state.subcontracts?.get('transformer-1'))['allowances'] = [
        { deltaIndex: 0, rightAllowance: -1n, leftAllowance: 2n },
      ];
    },
  },
  {
    name: 'malformed settlement workspace',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state.settlementWorkspace)['revision'] = 0; },
  },
  {
    name: 'zero-amount pending withdrawal',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.pendingWithdrawals.get('withdraw-1'))['amount'] = 0n; },
  },
  {
    name: 'invalid watchSeed',
    expected: 'reject',
    mutate: ({ doc }) => { object(doc.state)['watchSeed'] = { nested: true }; },
  },
  {
    name: 'negative jNonce',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.jNonce = -1; },
  },
  {
    name: 'out-of-range disputeConfig',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.disputeConfig.leftDisputeDelay = 65_536; },
  },
  {
    name: 'proofBody token/delta length mismatch',
    expected: 'reject',
    mutate: ({ doc }) => { doc.proofBody.deltas.pop(); },
  },
  {
    name: 'negative proof nonce',
    expected: 'reject',
    mutate: ({ doc }) => { doc.proofHeader.nextProofNonce = -1; },
  },
  {
    name: 'negative global credit limit',
    expected: 'reject',
    mutate: ({ doc }) => { doc.state.globalCreditLimits.peerLimit = -1n; },
  },
  {
    name: 'unrelated storage-key endpoint control',
    expected: 'reject',
    mutate: (value) => { value.counterparty = digest('96'); },
  },
  {
    name: 'negative currentHeight control',
    expected: 'reject',
    mutate: ({ doc }) => { doc.currentHeight = -1; },
  },
  {
    name: 'malformed accountStateRoot control',
    expected: 'reject',
    mutate: ({ doc }) => { doc.currentFrame.accountStateRoot = '0x1234'; },
  },
  {
    name: 'self-consistent frame above the Account token-row limit',
    expected: 'reject',
    mutate: async ({ doc }) => {
      const delta = doc.currentFrame.deltas[0]!;
      doc.currentFrame.deltas = Array.from(
        { length: LIMITS.MAX_ACCOUNT_TOKEN_ROWS + 1 },
        (_, tokenId) => ({ ...delta, tokenId }),
      );
      doc.currentFrame.stateHash = await createFrameHash(doc.currentFrame);
    },
  },
];

describe('persisted AccountReplica semantic boundary', () => {
  test('accepts a canonical baseline through codec, binding, and hydration', async () => {
    const fixture = await makeFixture();
    expect(admit(fixture).currentHeight).toBe(1);
  });

  for (const mutation of mutations) {
    test(`${mutation.expected}s ${mutation.name}`, async () => {
      const fixture = await makeFixture();
      await mutation.mutate(fixture);
      if (mutation.expected === 'reject') expect(() => admit(fixture)).toThrow();
      else expect(() => admit(fixture)).not.toThrow();
    });
  }

  test('rejects negative hold before it can inflate derived capacity', async () => {
    const clean = await makeFixture();
    const cleanDelta = clean.doc.state.deltas.get(1)!;
    const baseline = deriveDelta(cleanDelta, true).outCapacity;
    cleanDelta.leftHold = -1n;
    expect(() => deriveDelta(cleanDelta, true))
      .toThrow('leftHold must be non-negative');
    expect(() => validateDelta(cleanDelta, 'replica-meta restore'))
      .toThrow('leftHold must be non-negative');
    expect(() => admit(clean)).toThrow('STORAGE_ACCOUNT_DOC_INVALID_STATE_DELTA_leftHold');

    const admitted = admit(await makeFixture());
    expect(deriveDelta(admitted.state.deltas.get(1)!, true).outCapacity).toBe(baseline);
  });

  test('the audited matrix remains 36 rejects plus 2 design-valid accepts', () => {
    expect(mutations).toHaveLength(38);
    expect(mutations.filter(({ expected }) => expected === 'reject')).toHaveLength(36);
    expect(mutations.filter(({ expected }) => expected === 'accept')).toHaveLength(2);
  });

  test('authoritative WAL diff binds an Account put to its owner/proof orientation', async () => {
    const fixture = await makeFixture();
    [fixture.doc.proofHeader.fromEntity, fixture.doc.proofHeader.toEntity] = [
      fixture.doc.proofHeader.toEntity,
      fixture.doc.proofHeader.fromEntity,
    ];
    const diff = {
      height: 1,
      puts: [{
        family: 'account',
        entityId: fixture.owner,
        counterpartyId: fixture.counterparty,
        value: fixture.doc,
      }],
      dels: [],
    };
    expect(() => decodeValidatedBuffer(encodeBuffer(diff), validateStorageDiffRecordValue))
      .toThrow('STORAGE_ACCOUNT_DOC_OWNER_MISMATCH');
  });
});
