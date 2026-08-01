import { describe, expect, test } from 'bun:test';

import { createFrameHashSync } from '../account/consensus/frame';
import { computeAccountStateRoot } from '../account/state-root';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
} from '../storage/authoritative-schema';
import type { StorageAccountDoc } from '../storage/types';
import {
  makeStorageAccountFixture,
} from './helpers/account-storage-integrity';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

type ValidationContext = {
  doc: StorageAccountDoc;
  owner: string;
  counterparty: string;
};

type Mutation = readonly [string, (value: ValidationContext) => void];

const mutations: Mutation[] = [
  ['third-party proofHeader.fromEntity', ({ doc }) => { doc.proofHeader.fromEntity = digest('91'); }],
  ['swapped proofHeader endpoints', ({ doc }) => {
      [doc.proofHeader.fromEntity, doc.proofHeader.toEntity] = [
        doc.proofHeader.toEntity,
        doc.proofHeader.fromEntity,
      ];
  }],
  ['swapped storage owner and counterparty', value => {
    [value.owner, value.counterparty] = [value.counterparty, value.owner];
  }],
  ['storage owner equals counterparty', value => { value.counterparty = value.owner; }],
  ['currentHeight differs from currentFrame.height', ({ doc }) => { doc.currentHeight = 2; }],
  ['self-consistent but digest-stale frame height', ({ doc }) => {
      doc.currentHeight = 2;
      doc.currentFrame.height = 2;
      doc.currentFrame.prevFrameHash = digest('92');
  }],
  ['forged schema-valid currentFrame.stateHash', ({ doc }) => { doc.currentFrame.stateHash = digest('93'); }],
  ['delta Map key differs from tokenId', ({ doc }) => {
    doc.state.deltas = new Map([[2, doc.state.deltas.get(1)!]]);
  }],
  ['negative collateral', ({ doc }) => { doc.state.deltas.get(1)!.collateral = -1n; }],
  ['negative credit limit', ({ doc }) => { doc.state.deltas.get(1)!.leftCreditLimit = -1n; }],
  ['negative allowance', ({ doc }) => { doc.state.deltas.get(1)!.rightAllowance = -1n; }],
  ['negative hold', ({ doc }) => { doc.state.deltas.get(1)!.leftHold = -1n; }],
  ['negative frame allowance', ({ doc }) => { doc.currentFrame.deltas[0]!.leftAllowance = -1n; }],
  ['malformed bounded lock', ({ doc }) => { object(doc.state.locks.get('lock-1'))['hashlock'] = 'bad'; }],
  ['malformed bounded pull', ({ doc }) => { object(doc.state.pulls?.get('pull-1'))['fullHash'] = 'bad'; }],
  ['malformed bounded offer', ({ doc }) => { object(doc.state.swapOffers.get('offer-1'))['wantAmount'] = 0n; }],
  ['malformed bounded subcontract', ({ doc }) => {
    object(doc.state.subcontracts?.get('transformer-1'))['transformerAddress'] = digest('95');
  }],
  ['malformed settlement workspace', ({ doc }) => { object(doc.state.settlementWorkspace)['revision'] = 0; }],
  ['malformed pending withdrawal', ({ doc }) => {
    object(doc.pendingWithdrawals.get('withdraw-1'))['amount'] = 0n;
  }],
  ['invalid watchSeed', ({ doc }) => { object(doc.state)['watchSeed'] = { nested: true }; }],
  ['negative jNonce', ({ doc }) => { doc.state.jNonce = -1; }],
  ['malformed disputeConfig', ({ doc }) => { doc.state.disputeConfig.leftDisputeDelay = 65_536; }],
  ['malformed proofBody', ({ doc }) => { doc.proofBody.deltas.pop(); }],
  ['negative proof nonce', ({ doc }) => { doc.proofHeader.nextProofNonce = -1; }],
  ['negative global credit limit', ({ doc }) => { doc.state.globalCreditLimits.peerLimit = -1n; }],
  ['unrelated storage-key endpoint', value => { value.counterparty = digest('96'); }],
  ['negative currentHeight', ({ doc }) => { doc.currentHeight = -1; }],
  ['malformed accountStateRoot', ({ doc }) => { doc.currentFrame.accountStateRoot = '0x1234'; }],
];

const validate = (value: ValidationContext): StorageAccountDoc =>
  assertStorageAccountDocBinding(
    validateStorageAccountDocValue(value.doc),
    value.owner,
    value.counterparty,
    'mutation-table',
  );

describe('persisted AccountReplica semantic boundary', () => {
  test('accepts one valid baseline', () => {
    const fixture = makeStorageAccountFixture();
    expect(validate(fixture)).toBe(fixture.doc);
  });

  for (const [name, mutate] of mutations) {
    test(`rejects ${name}`, () => {
      const fixture = makeStorageAccountFixture();
      mutate(fixture);
      expect(() => validate(fixture)).toThrow();
    });
  }

  test('accepts legal live J-finality root divergence', () => {
    const fixture = makeStorageAccountFixture();
    const committedRoot = fixture.doc.currentFrame.accountStateRoot;
    fixture.doc.state.jNonce = 2;
    fixture.doc.state.lastFinalizedJHeight = 2;
    expect(computeAccountStateRoot(fixture.doc.state)).not.toBe(committedRoot);
    expect(validate(fixture)).toBe(fixture.doc);
  });

  test('accepts a self-consistent frame rewrite for the signed recovery layer', () => {
    const fixture = makeStorageAccountFixture();
    fixture.doc.currentFrame.accountStateRoot = digest('94');
    fixture.doc.currentFrame.stateHash = createFrameHashSync(fixture.doc.currentFrame);
    expect(validate(fixture)).toBe(fixture.doc);
  });

  test('the mutation matrix remains deduplicated', () => {
    expect(new Set(mutations.map(([name]) => name)).size).toBe(mutations.length);
  });
});
