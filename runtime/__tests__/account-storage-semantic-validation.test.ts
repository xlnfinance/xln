import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import { computeAccountStateRoot } from '../account/state-root';
import { clearFinalizedSettlementWorkspace } from '../account/tx/handlers/settle-transition';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
  validateStorageDiffRecordValue,
} from '../storage/authoritative-schema';
import { hydrateAccountDocFromStorage } from '../storage/projections';
import { safeStringify } from '../protocol/serialization';
import type { StorageAccountDoc } from '../storage/types';
import { makeStorageAccountFixture } from './helpers/account-storage-integrity';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

type ValidationContext = { doc: StorageAccountDoc; owner: string; counterparty: string };
type Mutation = readonly [string, (value: ValidationContext) => void | Promise<void>];

const mutations: Mutation[] = [
  ['third-party proof owner', ({ doc }) => { doc.proofHeader.fromEntity = digest('91'); }],
  ['swapped proof endpoints', ({ doc }) => {
    [doc.proofHeader.fromEntity, doc.proofHeader.toEntity] = [doc.proofHeader.toEntity, doc.proofHeader.fromEntity];
  }],
  ['swapped storage owner', value => { [value.owner, value.counterparty] = [value.counterparty, value.owner]; }],
  ['self storage relationship', value => { value.counterparty = value.owner; }],
  ['current height mismatch', ({ doc }) => { doc.currentHeight = 2; }],
  ['forged current frame hash', ({ doc }) => { doc.currentFrame.stateHash = digest('93'); }],
  ['delta key mismatch', ({ doc }) => { doc.state.deltas = new Map([[2, doc.state.deltas.get(1)!]]); }],
  ['negative collateral', ({ doc }) => { doc.state.deltas.get(1)!.collateral = -1n; }],
  ['negative credit limit', ({ doc }) => { doc.state.deltas.get(1)!.leftCreditLimit = -1n; }],
  ['negative allowance', ({ doc }) => { doc.currentFrame.deltas[0]!.leftAllowance = -1n; }],
  ['extra nested delta field', ({ doc }) => { object(doc.state.deltas.get(1))['surprise'] = true; }],
  ['invalid watch seed', ({ doc }) => { object(doc.state)['watchSeed'] = { nested: true }; }],
  ['negative j nonce', ({ doc }) => { doc.state.jNonce = -1; }],
  ['oversized dispute delay', ({ doc }) => { doc.state.disputeConfig.leftDisputeDelay = 65_536; }],
  ['proof token/delta mismatch', ({ doc }) => { doc.proofBody.tokenIds.push(1); }],
  ['negative proof nonce', ({ doc }) => { doc.proofHeader.nextProofNonce = -1; }],
  ['negative global credit', ({ doc }) => { doc.state.globalCreditLimits.peerLimit = -1n; }],
  ['unrelated storage endpoint', value => { value.counterparty = digest('96'); }],
  ['negative current height', ({ doc }) => { doc.currentHeight = -1; }],
  ['malformed account state root', ({ doc }) => { doc.currentFrame.accountStateRoot = '0x1234'; }],
  ['non-canonical workspace hash', ({ doc }) => { object(doc.state.settlementWorkspace)['memo'] = 'tampered'; }],
  ['zero workspace revision', ({ doc }) => { object(doc.state.settlementWorkspace)['revision'] = 0; }],
];

const validate = (value: ValidationContext): StorageAccountDoc =>
  assertStorageAccountDocBinding(validateStorageAccountDocValue(value.doc), value.owner, value.counterparty, 'matrix');

describe('persisted AccountReplica semantic boundary', () => {
  test('accepts transition-produced state and remains operable after hydration', async () => {
    const fixture = await makeStorageAccountFixture();
    const restored = hydrateAccountDocFromStorage(validate(fixture));
    expect(restored.state.deltas.get(1)?.leftHold).toBe(4n);
    clearFinalizedSettlementWorkspace(restored);
    expect(restored.state.settlementWorkspace).toBeUndefined();
    expect(restored.state.deltas.get(1)?.leftHold).toBe(0n);
  });

  for (const [name, mutate] of mutations) {
    test(`rejects ${name}`, async () => {
      const fixture = await makeStorageAccountFixture();
      await mutate(fixture);
      expect(() => validate(fixture)).toThrow();
    });
  }

  test('rejects coercible bigint text without mutating the persisted tree', async () => {
    const fixture = await makeStorageAccountFixture();
    object(fixture.doc.state.deltas.get(1))['collateral'] = '1';
    const before = safeStringify(fixture.doc);
    expect(() => validate(fixture)).toThrow();
    expect(safeStringify(fixture.doc)).toBe(before);
    expect(typeof fixture.doc.state.deltas.get(1)?.collateral).toBe('string');
  });

  test('historical StorageDiff binds Account owner, counterparty, and proof side', async () => {
    const fixture = await makeStorageAccountFixture();
    const diff = {
      height: 1,
      puts: [{ family: 'account', entityId: fixture.owner, counterpartyId: fixture.counterparty, value: fixture.doc }],
      dels: [],
    };
    expect(validateStorageDiffRecordValue(diff)).toEqual(diff);
    diff.puts[0]!.entityId = fixture.counterparty;
    diff.puts[0]!.counterpartyId = fixture.owner;
    expect(() => validateStorageDiffRecordValue(diff)).toThrow('OWNER_MISMATCH');
  });

  test('historical diff binds pending proposal side to its persisted owner', async () => {
    const fixture = await makeStorageAccountFixture();
    const pending = {
      ...fixture.doc.currentFrame,
      height: 2,
      timestamp: 1_001,
      prevFrameHash: fixture.doc.currentFrame.stateHash,
      stateHash: '',
      byLeft: false,
    };
    pending.stateHash = await createFrameHash(pending);
    fixture.doc.pendingFrame = pending;
    fixture.doc.pendingAccountInput = {
      kind: 'frame',
      fromEntityId: fixture.owner,
      toEntityId: fixture.counterparty,
      domain: fixture.doc.state.domain,
      proposal: { frame: structuredClone(pending) },
    };
    const diff = {
      height: 1,
      puts: [{ family: 'account', entityId: fixture.owner, counterpartyId: fixture.counterparty, value: fixture.doc }],
      dels: [],
    };
    expect(() => validateStorageDiffRecordValue(diff)).toThrow('PENDING_OWNER_MISMATCH');
  });

  test('accepts legal live J-finality root divergence', async () => {
    const fixture = await makeStorageAccountFixture();
    const committedRoot = fixture.doc.currentFrame.accountStateRoot;
    fixture.doc.state.jNonce = 2; fixture.doc.state.lastFinalizedJHeight = 2;
    expect(computeAccountStateRoot(fixture.doc.state)).not.toBe(committedRoot);
    expect(validate(fixture)).toBe(fixture.doc);
  });

  test('accepts a self-consistent frame rewrite for signed recovery verification', async () => {
    const fixture = await makeStorageAccountFixture();
    fixture.doc.currentFrame.accountStateRoot = digest('94');
    fixture.doc.currentFrame.stateHash = await createFrameHash(fixture.doc.currentFrame);
    expect(validate(fixture)).toBe(fixture.doc);
  });
});
