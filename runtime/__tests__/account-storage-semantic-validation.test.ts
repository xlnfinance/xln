import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import { computeAccountStateRoot } from '../account/state-root';
import { validateStorageAccountDocIntegrity } from '../storage/authoritative-schema';
import type { StorageAccountDoc } from '../storage/types';
import {
  makeCertifiedStorageAccountFixture,
  verifyLazyStorageHanko,
} from './helpers/account-storage-integrity';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

type ValidationContext = {
  doc: StorageAccountDoc;
  owner: string;
  counterparty: string;
};

type Mutation = {
  name: string;
  mutate: (value: ValidationContext) => void | Promise<void>;
};

const mutations: Mutation[] = [
  {
    name: 'third-party proofHeader.fromEntity',
    mutate: ({ doc }) => { doc.proofHeader.fromEntity = digest('91'); },
  },
  {
    name: 'swapped proofHeader endpoints',
    mutate: ({ doc }) => {
      [doc.proofHeader.fromEntity, doc.proofHeader.toEntity] = [
        doc.proofHeader.toEntity,
        doc.proofHeader.fromEntity,
      ];
    },
  },
  {
    name: 'swapped storage owner and counterparty',
    mutate: (value) => {
      [value.owner, value.counterparty] = [value.counterparty, value.owner];
    },
  },
  {
    name: 'storage owner equals counterparty',
    mutate: (value) => { value.counterparty = value.owner; },
  },
  {
    name: 'currentHeight differs from currentFrame.height',
    mutate: ({ doc }) => { doc.currentHeight = 2; },
  },
  {
    name: 'self-consistent but digest-stale frame height',
    mutate: ({ doc }) => {
      doc.currentHeight = 2;
      doc.currentFrame.height = 2;
      doc.currentFrame.prevFrameHash = digest('92');
    },
  },
  {
    name: 'forged schema-valid currentFrame.stateHash',
    mutate: ({ doc }) => { doc.currentFrame.stateHash = digest('93'); },
  },
  {
    name: 'forged accountStateRoot with recomputed frame hash',
    mutate: async ({ doc }) => {
      doc.currentFrame.accountStateRoot = digest('94');
      doc.currentFrame.stateHash = await createFrameHash(doc.currentFrame);
    },
  },
  {
    name: 'delta Map key differs from tokenId',
    mutate: ({ doc }) => {
      const delta = doc.state.deltas.get(1)!;
      doc.state.deltas = new Map([[2, delta]]);
    },
  },
  {
    name: 'negative collateral',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.collateral = -1n; },
  },
  {
    name: 'negative credit limit',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.leftCreditLimit = -1n; },
  },
  {
    name: 'negative allowance',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.rightAllowance = -1n; },
  },
  {
    name: 'negative hold',
    mutate: ({ doc }) => { doc.state.deltas.get(1)!.leftHold = -1n; },
  },
  {
    name: 'negative allowance inside currentFrame',
    mutate: ({ doc }) => { doc.currentFrame.deltas[0]!.leftAllowance = -1n; },
  },
  {
    name: 'malformed bounded lock',
    mutate: ({ doc }) => { object(doc.state.locks.get('lock-1'))['hashlock'] = 'not-a-hash'; },
  },
  {
    name: 'malformed bounded pull',
    mutate: ({ doc }) => { object(doc.state.pulls?.get('pull-1'))['fullHash'] = 'not-a-hash'; },
  },
  {
    name: 'malformed bounded swap offer',
    mutate: ({ doc }) => { object(doc.state.swapOffers.get('offer-1'))['wantAmount'] = 0n; },
  },
  {
    name: 'malformed bounded subcontract',
    mutate: ({ doc }) => { object(doc.state.subcontracts?.get('transformer-1'))['transformerAddress'] = digest('95'); },
  },
  {
    name: 'malformed settlement workspace',
    mutate: ({ doc }) => { object(doc.state.settlementWorkspace)['revision'] = 0; },
  },
  {
    name: 'malformed pending withdrawal',
    mutate: ({ doc }) => { object(doc.pendingWithdrawals.get('withdraw-1'))['amount'] = 0n; },
  },
  {
    name: 'invalid watchSeed',
    mutate: ({ doc }) => { object(doc.state)['watchSeed'] = { nested: true }; },
  },
  {
    name: 'negative jNonce',
    mutate: ({ doc }) => { doc.state.jNonce = -1; },
  },
  {
    name: 'malformed disputeConfig',
    mutate: ({ doc }) => { doc.state.disputeConfig.leftDisputeDelay = 65_536; },
  },
  {
    name: 'malformed proofBody',
    mutate: ({ doc }) => { doc.proofBody.deltas.pop(); },
  },
  {
    name: 'negative proof nonce',
    mutate: ({ doc }) => { doc.proofHeader.nextProofNonce = -1; },
  },
  {
    name: 'negative global credit limit',
    mutate: ({ doc }) => { doc.state.globalCreditLimits.peerLimit = -1n; },
  },
  {
    name: 'unrelated storage-key endpoint control',
    mutate: (value) => { value.counterparty = digest('96'); },
  },
  {
    name: 'negative currentHeight control',
    mutate: ({ doc }) => { doc.currentHeight = -1; },
  },
  {
    name: 'malformed accountStateRoot control',
    mutate: ({ doc }) => { doc.currentFrame.accountStateRoot = '0x1234'; },
  },
];

const validate = (value: ValidationContext): Promise<StorageAccountDoc> =>
  validateStorageAccountDocIntegrity({
    value: value.doc,
    entityId: value.owner,
    counterpartyId: value.counterparty,
    scope: 'mutation-table',
    verifyHanko: verifyLazyStorageHanko,
  });

describe('persisted AccountReplica semantic boundary', () => {
  test('accepts one fully certified baseline', async () => {
    const fixture = await makeCertifiedStorageAccountFixture();
    await expect(validate(fixture)).resolves.toBe(fixture.doc);
  });

  for (const mutation of mutations) {
    test(`rejects ${mutation.name}`, async () => {
      const fixture = await makeCertifiedStorageAccountFixture();
      await mutation.mutate(fixture);
      await expect(validate(fixture)).rejects.toThrow();
    });
  }

  test('accepts legal live J-finality root divergence', async () => {
    const fixture = await makeCertifiedStorageAccountFixture();
    const committedRoot = fixture.doc.currentFrame.accountStateRoot;
    fixture.doc.state.jNonce = 2;
    fixture.doc.state.lastFinalizedJHeight = 2;
    expect(computeAccountStateRoot(fixture.doc.state)).not.toBe(committedRoot);
    await expect(validate(fixture)).resolves.toBe(fixture.doc);
  });

  test('the matrix remains exactly the 29 audited mutations', () => {
    expect(mutations).toHaveLength(29);
    expect(new Set(mutations.map(({ name }) => name)).size).toBe(29);
  });
});
