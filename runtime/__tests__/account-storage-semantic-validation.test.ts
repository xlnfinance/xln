import { describe, expect, test } from 'bun:test';

import { createFrameHash } from '../account/consensus/frame';
import { buildDuplicateCommittedFrameAck } from '../account/consensus/replay';
import { applyAccountDisputeStarted } from '../account/j-finality';
import { computeAccountStateRoot } from '../account/state-root';
import { applyAccountTx } from '../account/tx/apply';
import { captureDisputeArgumentSnapshot } from '../protocol/dispute/arguments';
import { buildAccountProofBody } from '../protocol/dispute/proof-builder';
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
import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';
import { ACCOUNT_REPLICA_OPTIONAL } from '../storage/schema-state-docs';
import { safeStringify } from '../protocol/serialization';
import type { StorageAccountDoc } from '../storage/types';
import type { AccountReplica, AccountTx } from '../types/account';
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

const installLastOutboundAck = (value: ValidationContext): void => {
  value.doc.lastOutboundFrameAck = {
    height: value.doc.currentFrame.height,
    counterpartyEntityId: value.counterparty,
    response: {
      kind: 'ack',
      fromEntityId: value.owner,
      toEntityId: value.counterparty,
      domain: structuredClone(value.doc.state.domain),
      watchSeed: value.doc.state.watchSeed,
      ack: {
        height: value.doc.currentFrame.height,
        frameHash: value.doc.currentFrame.stateHash,
      },
    },
  };
};

const buildEvidence = (value: ValidationContext) => {
  const account = hydrateAccountDocFromStorage(value.doc);
  const proof = buildAccountProofBody(account, `0x${'35'.repeat(20)}`);
  return {
    proof,
    snapshot: captureDisputeArgumentSnapshot(
      account,
      proof.proofBodyHash,
      1,
      proof.proofBodyStruct,
    ),
  };
};

const swapHistoryEntry = (offerId: string) => ({
  offerId,
  giveTokenId: 1,
  giveAmount: 4n,
  wantTokenId: 2,
  wantAmount: 3n,
  createdHeight: 1,
  cancelRequested: false,
  lastUpdatedHeight: 1,
  resolves: [],
});

const optionalInstallers: Readonly<Record<
  (typeof ACCOUNT_REPLICA_OPTIONAL)[number],
  (value: ValidationContext) => void | Promise<void>
>> = {
  pendingFrame: installPendingProposal,
  pendingAccountInput: installPendingProposal,
  lastOutboundFrameAck: installLastOutboundAck,
  pendingForwards: value => { value.doc.pendingForwards = [{ tokenId: 1, amount: 1n, route: [value.owner, digest('33')] }]; },
  hankoSignature: value => { value.doc.hankoSignature = '0x01'; },
  lastRollbackFrameHash: value => { value.doc.lastRollbackFrameHash = value.doc.currentFrame.stateHash; },
  abiProofBody: value => {
    const { proof } = buildEvidence(value);
    value.doc.abiProofBody = {
      encodedProofBody: proof.encodedProofBody,
      proofBodyHash: proof.proofBodyHash,
      lastUpdatedHeight: value.doc.currentHeight,
    };
  },
  currentFrameHanko: value => { value.doc.currentFrameHanko = '0x02'; },
  counterpartyFrameHanko: value => { value.doc.counterpartyFrameHanko = '0x03'; },
  boardResealMigration: value => {
    value.doc.boardResealMigration = { activationJHeight: 1, activationLogIndex: 0, reason: 'pending' };
  },
  counterpartyBoardReseal: value => {
    value.doc.counterpartyBoardReseal = {
      activationJHeight: 1, activationLogIndex: 0,
      frameHeight: value.doc.currentHeight, frameHash: value.doc.currentFrame.stateHash,
    };
  },
  currentDisputeProofHanko: value => { value.doc.currentDisputeProofHanko = '0x04'; },
  currentDisputeProofNonce: value => { value.doc.currentDisputeProofNonce = 1; },
  currentDisputeProofBodyHash: value => { value.doc.currentDisputeProofBodyHash = digest('a4'); },
  currentDisputeHash: value => { value.doc.currentDisputeHash = digest('a5'); },
  counterpartyDisputeProofHanko: value => { value.doc.counterpartyDisputeProofHanko = '0x05'; },
  counterpartyDisputeProofNonce: value => { value.doc.counterpartyDisputeProofNonce = 1; },
  counterpartyDisputeProofBodyHash: value => { value.doc.counterpartyDisputeProofBodyHash = digest('a6'); },
  counterpartyDisputeHash: value => { value.doc.counterpartyDisputeHash = digest('a7'); },
  counterpartySettlementHanko: value => { value.doc.counterpartySettlementHanko = '0x06'; },
  disputeProofNoncesByHash: value => {
    const { proof } = buildEvidence(value);
    value.doc.disputeProofNoncesByHash = { [proof.proofBodyHash]: 1 };
  },
  disputeProofBodiesByHash: value => {
    const { proof } = buildEvidence(value);
    value.doc.disputeProofBodiesByHash = { [proof.proofBodyHash]: proof.proofBodyStruct };
  },
  disputeArgumentSnapshotsByHash: value => {
    const { proof, snapshot } = buildEvidence(value);
    value.doc.disputeArgumentSnapshotsByHash = { [proof.proofBodyHash]: snapshot };
  },
  disputePrepare: value => {
    value.doc.disputePrepare = {
      startedAt: 1,
      readyAfter: 2,
      reason: 'storage-audit',
      pendingOrderbookRemovalIds: ['route-1'],
      startIntent: {
        crossJurisdictionRouteId: '',
        starterInitialArguments: '',
        description: '',
        allowUnsafeCrossJTargetDispute: false,
        acceptedCrossJTargetLossAmount: -1n,
      },
    };
  },
  activeDispute: value => {
    value.doc.status = 'disputed';
    value.doc.activeDispute = {
      startedByLeft: true, initialProofbodyHash: digest('a8'), initialNonce: 1,
      disputeTimeout: 0, jNonce: 0, starterInitialArguments: '0x', starterIncrementedArguments: '0x',
    };
  },
  swapOrderHistory: value => { value.doc.swapOrderHistory = new Map([['history-open', swapHistoryEntry('history-open')]]); },
  swapClosedOrders: value => { value.doc.swapClosedOrders = new Map([['history-closed', swapHistoryEntry('history-closed')]]); },
};

const codecValidateHydrate = (value: ValidationContext): AccountReplica =>
  hydrateAccountDocFromStorage(assertStorageAccountDocBinding(
    decodeValidatedBuffer(
      encodeBuffer(value.doc),
      validateStorageAccountDocValue,
    ),
    value.owner,
    value.counterparty,
    'codec-parity',
  ));

const commitTransition = async (
  account: AccountReplica,
  tx: AccountTx,
  byLeft: boolean,
): Promise<void> => {
  const previous = account.currentFrame.stateHash;
  const result = await applyAccountTx(account, tx, byLeft, 2_000, 2);
  if (!result.success) throw new Error(`TEST_ACCOUNT_TRANSITION_FAILED:${result.error}`);
  account.currentHeight = 2;
  account.currentFrame = {
    height: 2,
    timestamp: 2_000,
    jHeight: account.state.lastFinalizedJHeight,
    accountTxs: [tx],
    prevFrameHash: previous,
    accountStateRoot: computeAccountStateRoot(account.state),
    stateHash: '',
    byLeft,
    deltas: [{ ...account.state.deltas.get(1)! }],
  };
  account.currentFrame.stateHash = await createFrameHash(account.currentFrame);
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
  ['cached ACK wrapper ghost field', value => {
    installLastOutboundAck(value); object(value.doc.lastOutboundFrameAck)['ghost'] = true;
  }],
  ['cached ACK non-ACK response', value => {
    installLastOutboundAck(value); object(value.doc.lastOutboundFrameAck!.response)['kind'] = 'dispute';
  }],
  ['cached ACK outer height mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.height += 1;
  }],
  ['cached ACK inner height mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.response.ack.height += 1;
  }],
  ['cached ACK frame hash mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.response.ack.frameHash = digest('97');
  }],
  ['cached ACK counterparty mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.counterpartyEntityId = digest('98');
  }],
  ['cached ACK response endpoint mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.response.toEntityId = digest('99');
  }],
  ['cached ACK domain mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.response.domain.chainId += 1;
  }],
  ['cached ACK watch seed mismatch', value => {
    installLastOutboundAck(value); value.doc.lastOutboundFrameAck!.response.watchSeed = digest('9a');
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

  test('codec-hydrated cached ACK is exact and safe for duplicate-frame resend', async () => {
    const fixture = await makeStorageAccountFixture();
    installLastOutboundAck(fixture);
    const restored = codecValidateHydrate(fixture);
    const duplicateInput = {
      kind: 'frame' as const,
      fromEntityId: fixture.counterparty,
      toEntityId: fixture.owner,
      domain: structuredClone(fixture.doc.state.domain),
      watchSeed: fixture.doc.state.watchSeed,
      proposal: { frame: structuredClone(fixture.doc.currentFrame) },
    };
    const replay = buildDuplicateCommittedFrameAck(
      restored,
      duplicateInput,
      [],
      restored.currentHeight,
      restored.currentFrame,
    );
    expect(replay?.success).toBe(true);
    expect(replay?.response).toEqual(restored.lastOutboundFrameAck?.response);
  });

  test('transition-projected text fields survive codec validation without storage-only semantics', async () => {
    const cases: Array<{
      name: string;
      tx: (fixture: ValidationContext) => AccountTx;
      byLeft: boolean;
      verify: (account: AccountReplica) => unknown;
    }> = [
      {
        name: '300-character pullId',
        tx: () => ({
          type: 'pull_lock',
          data: {
            pullId: 'p'.repeat(300), tokenId: 1, amount: 1n,
            revealedUntilTimestamp: 10_000, fullHash: digest('a2'), partialRoot: digest('a3'),
          },
        }),
        byLeft: true,
        verify: account => account.state.pulls?.get('p'.repeat(300))?.pullId,
      },
      {
        name: '300-character direct-payment description',
        tx: fixture => ({
          type: 'direct_payment',
          data: {
            tokenId: 1, amount: 1n,
            route: [fixture.owner, digest('33'), digest('44')],
            description: 'd'.repeat(300),
          },
        }),
        byLeft: false,
        verify: account => account.pendingForwards?.[0]?.description,
      },
      {
        name: 'arbitrary HTLC hashlock',
        tx: () => ({
          type: 'htlc_lock',
          data: {
            lockId: 'storage-arbitrary-hashlock', hashlock: 'canonical-transition-allows-this-string',
            timelock: 10_000n, revealBeforeHeight: 10, amount: 1n, tokenId: 1,
          },
        }),
        byLeft: true,
        verify: account => account.state.locks.get('storage-arbitrary-hashlock')?.hashlock,
      },
    ];

    for (const parity of cases) {
      const fixture = await makeStorageAccountFixture();
      const account = hydrateAccountDocFromStorage(fixture.doc);
      const tx = parity.tx(fixture);
      await commitTransition(account, tx, parity.byLeft);
      fixture.doc = projectAccountDoc(account);
      const restored = codecValidateHydrate(fixture);
      expect(parity.verify(restored), parity.name).toEqual(parity.verify(account));
    }
  });

  test('all 27 optional replica fields have a codec-to-hydration validation owner', async () => {
    expect(Object.keys(optionalInstallers).sort()).toEqual([...ACCOUNT_REPLICA_OPTIONAL].sort());
    expect(ACCOUNT_REPLICA_OPTIONAL).toHaveLength(27);
    for (const field of ACCOUNT_REPLICA_OPTIONAL) {
      const fixture = await makeStorageAccountFixture();
      await optionalInstallers[field](fixture);
      const restored = codecValidateHydrate(fixture);
      expect(Object.hasOwn(restored, field), field).toBe(true);
    }
  });

  test('structured optional fields reject ghosts, broken hashes, and unsafe consumer shapes', async () => {
    const cases: Array<readonly [
      string,
      (value: ValidationContext) => void | Promise<void>,
      (value: ValidationContext) => void,
    ]> = [
      ['ABI proof ghost', optionalInstallers.abiProofBody, value => { object(value.doc.abiProofBody)['ghost'] = true; }],
      ['ABI proof hash mismatch', optionalInstallers.abiProofBody, value => { value.doc.abiProofBody!.proofBodyHash = digest('b1'); }],
      ['board migration ghost', optionalInstallers.boardResealMigration, value => { object(value.doc.boardResealMigration)['ghost'] = true; }],
      ['counterparty board reseal ghost', optionalInstallers.counterpartyBoardReseal, value => { object(value.doc.counterpartyBoardReseal)['ghost'] = true; }],
      ['evidence nonce value', optionalInstallers.disputeProofNoncesByHash, value => {
        const key = Object.keys(value.doc.disputeProofNoncesByHash!)[0]!;
        value.doc.disputeProofNoncesByHash![key] = -1;
      }],
      ['evidence body hash mismatch', optionalInstallers.disputeProofBodiesByHash, value => {
        const body = Object.values(value.doc.disputeProofBodiesByHash!)[0]!;
        value.doc.disputeProofBodiesByHash = { [digest('b2')]: body };
      }],
      ['evidence body ghost', optionalInstallers.disputeProofBodiesByHash, value => {
        object(Object.values(value.doc.disputeProofBodiesByHash!)[0])['ghost'] = true;
      }],
      ['snapshot plan ghost', optionalInstallers.disputeArgumentSnapshotsByHash, value => {
        const snapshot = object(Object.values(value.doc.disputeArgumentSnapshotsByHash!)[0]);
        object(snapshot['plan'])['ghost'] = true;
      }],
      ['dispute prepare ghost', optionalInstallers.disputePrepare, value => { object(value.doc.disputePrepare)['ghost'] = true; }],
      ['dispute intent ghost', optionalInstallers.disputePrepare, value => { object(value.doc.disputePrepare!.startIntent)['ghost'] = true; }],
      ['swap history ghost', optionalInstallers.swapOrderHistory, value => {
        object(value.doc.swapOrderHistory!.get('history-open'))['ghost'] = true;
      }],
    ];
    for (const [name, install, mutate] of cases) {
      const fixture = await makeStorageAccountFixture();
      await install(fixture);
      mutate(fixture);
      expect(() => codecValidateHydrate(fixture), name).toThrow();
    }
  });

  test('all opaque optional scalars reject values their consumers cannot dereference', async () => {
    const malformed: Readonly<Record<string, unknown>> = {
      hankoSignature: {},
      lastRollbackFrameHash: 'not-a-frame-hash',
      currentFrameHanko: {},
      counterpartyFrameHanko: {},
      currentDisputeProofHanko: {},
      currentDisputeProofNonce: -1,
      currentDisputeProofBodyHash: 'not-a-proof-hash',
      currentDisputeHash: 'not-a-dispute-hash',
      counterpartyDisputeProofHanko: {},
      counterpartyDisputeProofNonce: -1,
      counterpartyDisputeProofBodyHash: 'not-a-proof-hash',
      counterpartyDisputeHash: 'not-a-dispute-hash',
      counterpartySettlementHanko: {},
    };
    for (const [field, invalid] of Object.entries(malformed)) {
      const fixture = await makeStorageAccountFixture();
      await optionalInstallers[field as keyof typeof optionalInstallers](fixture);
      object(fixture.doc)[field] = invalid;
      expect(() => codecValidateHydrate(fixture), field).toThrow();
    }
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
