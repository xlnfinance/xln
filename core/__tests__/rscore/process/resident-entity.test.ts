import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { computeEntityConsensusSectionDigestsCold } from '../../../entity/consensus/state-root';
import { generateLazyEntityId } from '../../../entity/factory';
import { applyCommand, createBook } from '../../../orderbook/core';
import { replaceOrderbookPair } from '../../../orderbook/order-index';
import {
  createOrderbookExtState,
  getStaticSwapTokenDimensions,
  getSwapLotScaleForDecimals,
  quoteAmountAtPriceForDecimals,
} from '../../../orderbook/types';
import { RscoreProcessClient } from '../../../rscore/client';
import { entityDeterministicContextWire } from '../../../rscore/entity/round-wire';
import { entitySnapshotWire } from '../../../rscore/entity/snapshot-wire';
import { PersistentEntityCollectionMap } from '../../../entity/state/persistent-collection-map';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  swapMarketPolicyWire,
} from '../../../rscore/shadow-wire';
import type { EntityInfraContext } from '../../../types/entity/infra-context';
import type { SwapOffer } from '../../../types/account';
import { addr, entity, makeAccount, makeJurisdiction, makeState } from '../../helpers/cross-j';

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xln-rscore');

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa1),
  runtimeId: Buffer.alloc(20, 0x11),
  sessionId: Buffer.alloc(16, 0x21),
});

const owned = new Set([
  'accounts', 'entityId', 'height', 'timestamp', 'lastFinalizedJHeight',
  'htlcRoutes', 'htlcFeesEarned', 'lockBook', 'orderbookExt',
  'crontabState', 'reserves',
]);

describe.skipIf(!existsSync(BINARY))('resident Rust Entity process', () => {
  test('restores exact TS book pages and executes one fused empty round', async () => {
    const seed = `0x${'73'.repeat(32)}`;
    const signerLabel = '1';
    const signerAddress = deriveSignerAddressSync(seed, signerLabel);
    const owner = generateLazyEntityId([signerAddress], 1n).toLowerCase();
    const counterparty = entity('cd');
    const jurisdiction = makeJurisdiction('resident-entity', 31_337, '11', '12');
    const state = makeState(owner, signerAddress, jurisdiction);
    const account = makeAccount(owner, counterparty, jurisdiction);

    const dimensions = getStaticSwapTokenDimensions(2, 1);
    const lotScale = getSwapLotScaleForDecimals(dimensions.giveTokenDecimals);
    const priceTicks = 25_000_000n;
    const wantAmount = quoteAmountAtPriceForDecimals(
      dimensions.giveTokenDecimals,
      dimensions.wantTokenDecimals,
      lotScale,
      priceTicks,
    );
    const offer = (offerId: string): SwapOffer => ({
      offerId,
      giveTokenId: 2,
      ...dimensions,
      giveAmount: lotScale,
      wantTokenId: 1,
      wantAmount,
      maxFee: 0n,
      minNetReceive: wantAmount,
      priceTicks,
      timeInForce: 0,
      makerIsLeft: account.state.leftEntity === owner,
      createdHeight: 1,
      quantizedGive: lotScale,
      quantizedWant: wantAmount,
    });
    account.state.swapOffers = PersistentAccountStateMap.fromEntries('swapOffers', [
      ['offer-a', offer('offer-a')],
      ['offer-c', offer('offer-c')],
    ]);
    state.accounts = state.accounts.updated(counterparty, account);

    let book = createBook({ bucketWidthTicks: 10_000n, maxOrders: 32, stpPolicy: 1 });
    for (const offerId of ['offer-a', 'hole', 'offer-c']) {
      book = applyCommand(book, {
        kind: 0,
        ownerId: owner,
        orderId: `${counterparty}:${offerId}`,
        side: 1,
        tif: 0,
        postOnly: false,
        priceTicks,
        qtyLots: 1n,
      }).state;
    }
    book = applyCommand(book, {
      kind: 1,
      ownerId: owner,
      orderId: `${counterparty}:hole`,
    }).state;
    const ext = createOrderbookExtState({
      entityId: owner,
      name: 'Resident Hub',
      spreadDistribution: {
        makerBps: 0,
        takerBps: 10_000,
        hubBps: 0,
        makerReferrerBps: 0,
        takerReferrerBps: 0,
      },
      referenceTokenId: 1,
      usdQuoteAuthorityEntityId: counterparty,
      minTradeSize: 0n,
      supportedPairs: ['1/2'],
    });
    replaceOrderbookPair(ext, '1/2', book);
    ext.pairDimensions.set('1/2', {
      baseTokenDecimals: dimensions.giveTokenDecimals,
      quoteTokenDecimals: dimensions.wantTokenDecimals,
    });
    state.orderbookExt = ext;
    state.crontabState = initCrontab();
    scheduleHook(state.crontabState, {
      id: 'resident-htlc-timeout',
      triggerAt: state.timestamp + 30_000,
      type: 'htlc_timeout',
      data: { accountId: counterparty, lockId: `0x${'bc'.repeat(32)}` },
    });
    const routeHashlock = `0x${'ab'.repeat(32)}`;
    state.htlcRoutes = PersistentEntityCollectionMap.empty().updated(routeHashlock, {
      hashlock: routeHashlock,
      tokenId: 1,
      amount: 1_000n,
      inboundEntity: counterparty,
      inboundLockId: `0x${'bc'.repeat(32)}`,
      outboundEntity: counterparty,
      outboundLockId: `0x${'cd'.repeat(32)}`,
      pendingFee: 0n,
      createdTimestamp: state.timestamp,
    });

    const client = new RscoreProcessClient(BINARY, identity());
    try {
      await client.hello(4, swapMarketPolicyWire(), {
        privateKey: deriveSignerKeySync(seed, signerLabel),
        signerId: signerLabel,
      });
      const loaded = await client.bootstrapAccounts(0, [accountSeedWire(
        owner,
        counterparty,
        account.state,
        accountEnvelopeWire(account),
        accountConsensusWire(account),
        addr('99'),
      )], true) as unknown[];
      expect(`0x${Buffer.from(loaded[1] as Uint8Array).toString('hex')}`)
        .toBe(state.accounts.rootHash());
      const entityLoaded = await client.bootstrapEntity(entitySnapshotWire(state));
      expect(entityLoaded.accountsRoot).toBe(state.accounts.rootHash());
      expect(entityLoaded.ownedSections).toEqual(
        computeEntityConsensusSectionDigestsCold(state)
          .filter(section => owned.has(section.field))
          .sort((left, right) => left.field.localeCompare(right.field)),
      );

      const context: EntityInfraContext = {
        version: 1,
        proposerReplicaId: `${owner}:${signerAddress}`,
        entityId: owner,
        proposerSignerId: signerAddress,
        parentFrameHash: state.prevFrameHash!,
        height: state.height + 1,
        gossipProfiles: [],
        peerAssertions: [],
        htlc: { version: 1, entries: [], originated: [] },
      };
      const round = await client.entityRound({
        ownerEntityId: hexToWireBytes(owner, 32, 'RSCORE_ENTITY_TEST_OWNER'),
        expectedAccountsRoot: hexToWireBytes(state.accounts.rootHash(), 32, 'RSCORE_ENTITY_TEST_ROOT'),
        inboundTimestamp: state.timestamp,
        inboundJHeight: state.lastFinalizedJHeight,
        inboundRows: [],
        entityHeight: state.height + 1,
        outboundTimestamp: state.timestamp + 1,
        outboundJHeight: state.lastFinalizedJHeight,
        checkpointDue: false,
        postAccounts: false,
        context: entityDeterministicContextWire(state, context, jurisdiction.name),
      });
      expect(round.inbound.accountsRoot).toBe(state.accounts.rootHash());
      expect(round.outbound.accountsRoot).toBe(state.accounts.rootHash());
      expect(round.outbound.proposals).toEqual([]);
      expect(round.outputs).toEqual([]);
      const expected = { ...state, height: state.height + 1, timestamp: state.timestamp + 1 };
      expect(round.ownedSections).toEqual(
        computeEntityConsensusSectionDigestsCold(expected)
          .filter(section => owned.has(section.field))
          .sort((left, right) => left.field.localeCompare(right.field)),
      );

      // A Runtime frame may be retried after its candidate was never made
      // durable. The process must discard that candidate and deterministically
      // recompute from the accepted parent without a Commit/Abort control op.
      const retry = await client.entityRound({
        ownerEntityId: hexToWireBytes(owner, 32, 'RSCORE_ENTITY_TEST_OWNER'),
        expectedAccountsRoot: hexToWireBytes(state.accounts.rootHash(), 32, 'RSCORE_ENTITY_TEST_ROOT'),
        inboundTimestamp: state.timestamp,
        inboundJHeight: state.lastFinalizedJHeight,
        inboundRows: [],
        entityHeight: state.height + 1,
        outboundTimestamp: state.timestamp + 2,
        outboundJHeight: state.lastFinalizedJHeight,
        checkpointDue: false,
        postAccounts: false,
        context: entityDeterministicContextWire(state, context, jurisdiction.name),
      });
      const retryExpected = { ...state, height: state.height + 1, timestamp: state.timestamp + 2 };
      expect(retry.ownedSections).toEqual(
        computeEntityConsensusSectionDigestsCold(retryExpected)
          .filter(section => owned.has(section.field))
          .sort((left, right) => left.field.localeCompare(right.field)),
      );

      // Advancing from the candidate's root/height promotes it implicitly.
      const advanced = await client.entityRound({
        ownerEntityId: hexToWireBytes(owner, 32, 'RSCORE_ENTITY_TEST_OWNER'),
        expectedAccountsRoot: hexToWireBytes(state.accounts.rootHash(), 32, 'RSCORE_ENTITY_TEST_ROOT'),
        inboundTimestamp: state.timestamp + 2,
        inboundJHeight: state.lastFinalizedJHeight,
        inboundRows: [],
        entityHeight: state.height + 2,
        outboundTimestamp: state.timestamp + 3,
        outboundJHeight: state.lastFinalizedJHeight,
        checkpointDue: false,
        postAccounts: false,
        context: entityDeterministicContextWire(retryExpected, {
          ...context,
          parentFrameHash: retryExpected.prevFrameHash!,
          height: retryExpected.height + 1,
        }, jurisdiction.name),
      });
      const advancedExpected = {
        ...retryExpected,
        height: state.height + 2,
        timestamp: state.timestamp + 3,
      };
      expect(advanced.ownedSections).toEqual(
        computeEntityConsensusSectionDigestsCold(advancedExpected)
          .filter(section => owned.has(section.field))
          .sort((left, right) => left.field.localeCompare(right.field)),
      );
      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
