import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import { applyAccountDisputeStarted } from '../account/j-finality';
import { computeAccountStateRoot } from '../account/state-root';
import { clearFinalizedSettlementWorkspace } from '../account/tx/handlers/settle-transition';
import {
  buildCrossJurisdictionPullBinding,
  buildPreparedCrossJurisdictionRoute,
} from '../extensions/cross-j';
import {
  assertStorageAccountDocBinding,
  validateStorageAccountDocValue,
  validateStorageDiffRecordValue,
} from '../storage/authoritative-schema';
import { hydrateAccountDocFromStorage, projectAccountDoc } from '../storage/projections';
import { safeStringify } from '../protocol/serialization';
import type { StorageAccountDoc } from '../storage/types';
import { computeStorageAccountFrameHash } from '../storage/account-doc-validation-primitives';
import { makeStorageAccountFixture } from './helpers/account-storage-integrity';
import { jref, makeJurisdiction } from './helpers/cross-j';

const digest = (byte: string): string => `0x${byte.repeat(32)}`;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

type ValidationContext = { doc: StorageAccountDoc; owner: string; counterparty: string };
type Mutation = readonly [string, (value: ValidationContext) => void | Promise<void>];

const installOffer = (doc: StorageAccountDoc, overrides: Record<string, unknown> = {}): void => {
  doc.state.swapOffers.set('storage-offer', {
    offerId: 'storage-offer', giveTokenId: 1, giveAmount: 4n,
    wantTokenId: 2, wantAmount: 3n, makerIsLeft: true, createdHeight: 1,
    priceTicks: 2n, quantizedGive: 4n, quantizedWant: 3n,
    ...overrides,
  });
};

const installPendingProposal = async (value: ValidationContext): Promise<void> => {
  const pending = {
    ...value.doc.currentFrame, height: 2, timestamp: 1_001,
    prevFrameHash: value.doc.currentFrame.stateHash, stateHash: '', byLeft: true,
  };
  pending.stateHash = await createFrameHash(pending);
  value.doc.pendingFrame = pending;
  value.doc.pendingAccountInput = {
    kind: 'frame', fromEntityId: value.owner, toEntityId: value.counterparty,
    domain: value.doc.state.domain, proposal: { frame: structuredClone(pending) },
  };
};

const installCrossJurisdictionOffer = (
  value: ValidationContext,
  options: { makerIsLeft?: boolean; sourceEntity?: string; sourceCounterparty?: string } = {},
): Record<string, unknown> => {
  const source = makeJurisdiction('storage-source', 1, '31', '32');
  const target = makeJurisdiction('storage-target', 8_453, '41', '42');
  const sourceEntity = options.sourceEntity ?? value.owner;
  const sourceCounterparty = options.sourceCounterparty ?? value.counterparty;
  const prepared = buildPreparedCrossJurisdictionRoute({
    orderId: 'storage-cross-j', makerEntityId: sourceEntity, hubEntityId: sourceCounterparty,
    source: { jurisdiction: jref(source), entityId: sourceEntity, counterpartyEntityId: sourceCounterparty, tokenId: 1, amount: 4n },
    target: { jurisdiction: jref(target), entityId: digest('33'), counterpartyEntityId: digest('44'), tokenId: 2, amount: 3n },
    priceTicks: 2n, status: 'intent', createdAt: 1_000, updatedAt: 1_000, expiresAt: 61_000,
  }, { runtimeSeed: 'storage-cross-j-fixture', sourceDisputeDelayMs: 10_000, now: 1_000 });
  const route = { ...prepared, status: 'resting' as const, updatedAt: 1_001 };
  const sourcePull = route.sourcePull!;
  value.doc.state.pulls = new Map([[sourcePull.pullId, {
    pullId: sourcePull.pullId, tokenId: sourcePull.tokenId, amount: sourcePull.signedAmount,
    revealedUntilTimestamp: sourcePull.revealedUntilTimestamp, fullHash: sourcePull.fullHash,
    partialRoot: sourcePull.partialRoot, createdHeight: 1, createdTimestamp: 1_000,
    crossJurisdiction: buildCrossJurisdictionPullBinding(route, 'source'),
  }]]);
  value.doc.state.swapOffers.set(route.orderId, {
    offerId: route.orderId, giveTokenId: 1, giveAmount: 4n, wantTokenId: 2,
    wantAmount: 3n, makerIsLeft: options.makerIsLeft ?? true, createdHeight: 1, priceTicks: 2n,
    quantizedGive: 4n, quantizedWant: 3n, crossJurisdiction: route,
  });
  return object(route);
};

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
  ['negative pending forward amount', value => { value.doc.pendingForwards = [{ tokenId: 1, amount: -1n, route: [value.owner, digest('33')] }]; }],
  ['pending forward without a next hop', value => { value.doc.pendingForwards = [{ tokenId: 1, amount: 1n, route: [value.owner] }]; }],
  ['pending forward ghost field', value => { value.doc.pendingForwards = [{ tokenId: 1, amount: 1n, route: [value.owner, digest('33')], ghost: true } as never]; }],
  ['local dispute with an on-chain timeout', ({ doc }) => {
    doc.status = 'disputed'; doc.activeDispute = {
      startedByLeft: true, initialProofbodyHash: digest('a1'), initialNonce: 1,
      disputeTimeout: 1, jNonce: 0, starterInitialArguments: '0x',
      starterIncrementedArguments: '0x', observedOnChain: false,
    };
  }],
  ['active dispute ghost field', ({ doc }) => {
    doc.status = 'disputed'; doc.activeDispute = {
      startedByLeft: true, initialProofbodyHash: digest('a1'), initialNonce: 1,
      disputeTimeout: 0, jNonce: 0, starterInitialArguments: '0x',
      starterIncrementedArguments: '0x', ghost: true,
    } as never;
  }],
  ['string time-in-force', ({ doc }) => { installOffer(doc, { timeInForce: '1' }); }],
  ['zero price ticks', ({ doc }) => { installOffer(doc, { priceTicks: 0n }); }],
  ['zero quantized amount', ({ doc }) => { installOffer(doc, { quantizedGive: 0n }); }],
  ['shadow hard limit below soft limit', ({ doc }) => {
    doc.shadow.rebalance.policy.set(1, { r2cRequestSoftLimit: 2n, hardLimit: 1n, maxAcceptableFee: 0n });
  }],
  ['pending input ghost field', async value => {
    await installPendingProposal(value); object(value.doc.pendingAccountInput)['ghost'] = true;
  }],
  ['cross-j route ghost field', value => { installCrossJurisdictionOffer(value)['ghost'] = true; }],
  ['cross-j source leg ghost field', value => {
    object(installCrossJurisdictionOffer(value)['source'])['ghost'] = true;
  }],
  ['cross-j pull binding ghost field', value => {
    const route = installCrossJurisdictionOffer(value);
    const pull = value.doc.state.pulls!.get(String(object(route['sourcePull'])['pullId']))!;
    object(pull.crossJurisdiction)['ghost'] = true;
  }],
  ['cross-j maker side inversion', value => {
    const route = installCrossJurisdictionOffer(value);
    value.doc.state.swapOffers.get(String(route['orderId']))!.makerIsLeft = false;
  }],
  ['cross-j alien source account', value => {
    installCrossJurisdictionOffer(value, {
      sourceEntity: digest('55'), sourceCounterparty: digest('66'), makerIsLeft: true,
    });
  }],
  ['cross-j target pull token mismatch', value => {
    object(installCrossJurisdictionOffer(value)['targetPull'])['tokenId'] = 3;
  }],
  ['cross-j route hash mismatch', value => { installCrossJurisdictionOffer(value)['routeHash'] = digest('ff'); }],
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

  test('accepts exact forward, dispute, pending-input, and cross-j persisted shapes', async () => {
    const forward = await makeStorageAccountFixture();
    const repeatedRoute = [forward.owner, digest('33'), forward.owner, digest('44')];
    forward.doc.pendingForwards = [{ tokenId: 1, amount: 1n, route: repeatedRoute }];
    expect(hydrateAccountDocFromStorage(validate(forward)).pendingForwards?.[0]?.route)
      .toEqual(repeatedRoute);

    const dispute = await makeStorageAccountFixture();
    const disputedAccount = hydrateAccountDocFromStorage(validate(dispute));
    applyAccountDisputeStarted(disputedAccount, {
      kind: 'dispute_started', starterEntityId: dispute.owner,
      initialProofbodyHash: digest('a1'), initialNonce: 7, disputeTimeout: 120,
      jNonce: 9, starterInitialArguments: '0x1234', starterIncrementedArguments: '0x5678',
      observedBlockNumber: 100, batchNonce: 3,
    });
    dispute.doc = projectAccountDoc(disputedAccount);
    expect(validate(dispute)).toBe(dispute.doc);

    const pending = await makeStorageAccountFixture();
    await installPendingProposal(pending);
    expect(validate(pending)).toBe(pending.doc);

    const crossJurisdiction = await makeStorageAccountFixture();
    installCrossJurisdictionOffer(crossJurisdiction);
    expect(validate(crossJurisdiction)).toBe(crossJurisdiction.doc);

    const rightMaker = await makeStorageAccountFixture();
    installCrossJurisdictionOffer(rightMaker, {
      sourceEntity: rightMaker.counterparty,
      sourceCounterparty: rightMaker.owner,
      makerIsLeft: false,
    });
    expect(validate(rightMaker)).toBe(rightMaker.doc);
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

  test('accepts a storage-self-consistent frame root without claiming signature authority', async () => {
    const fixture = await makeStorageAccountFixture();
    fixture.doc.currentFrame.accountStateRoot = digest('94');
    fixture.doc.currentFrame.stateHash = await createFrameHash(fixture.doc.currentFrame);
    expect(validate(fixture)).toBe(fixture.doc);
  });

  test('storage frame hashing stays equivalent to the canonical Account helper', async () => {
    const fixture = await makeStorageAccountFixture();
    expect(computeStorageAccountFrameHash(fixture.doc.currentFrame))
      .toBe(await createFrameHash(fixture.doc.currentFrame));
  });
});
