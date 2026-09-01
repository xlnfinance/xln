import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';

import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../account/crypto';
import { PersistentAccountStateMap } from '../../../account/state/persistent-state-map';
import { generateLazyEntityId } from '../../../entity/factory';
import { applyCommand, createBook } from '../../../orderbook/core';
import { replaceOrderbookPair } from '../../../orderbook/order-index';
import {
  createOrderbookExtState,
  getStaticSwapTokenDimensions,
  getSwapLotScaleForDecimals,
  quoteAmountAtPriceForDecimals,
} from '../../../orderbook/types';
import {
  RSCORE_PROTOCOL_FINGERPRINT,
  RscoreProcessClient,
} from '../../../rscore/client';
import {
  decodeRscoreAccountRestoreRow,
  projectRscoreCommittedEnvelopeFields,
} from '../../../rscore/checkpoint/checkpoint-restore';
import { entityDeterministicContextWire } from '../../../rscore/entity/round-wire';
import { entityOwnedSectionDigests, entitySnapshotWire } from '../../../rscore/entity/snapshot-wire';
import { initCrontab, scheduleHook } from '../../../entity/scheduler';
import { prepareRscoreCheckpointStorage } from '../../../storage/schema/rscore/checkpoint';
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

const BINARY = join(import.meta.dir, '../../../../rscore/target/release/xlnrs');

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa1),
  runtimeId: Buffer.alloc(20, 0x11),
  sessionId: Buffer.alloc(16, 0x21),
});

describe.skipIf(!existsSync(BINARY))('resident Rust Entity process', () => {
  test('restores exact TS book pages and round-trips a real Rust checkpoint', async () => {
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
    account.rollbackCount = 3;
    state.accounts.set(counterparty, account);

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
    state.paybook.entries.set(routeHashlock, {
      hashlock: routeHashlock,
      tokenId: 1,
      amount: 1_000n,
      inboundEntity: counterparty,
      outboundEntity: counterparty,
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
      expect(entityLoaded.ownedSections).toEqual(entityOwnedSectionDigests(state));

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
      expect(round.ownedSections).toEqual(entityOwnedSectionDigests(expected));

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
      expect(retry.ownedSections).toEqual(entityOwnedSectionDigests(retryExpected));

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
      expect(advanced.ownedSections).toEqual(entityOwnedSectionDigests(advancedExpected));

      // Exercise the production encoder and strict TS decoder together. The
      // rollback counter must survive for crash recovery without entering the
      // committed Entity Account leaf.
      const checkpointRound = await client.entityRound({
        ownerEntityId: hexToWireBytes(owner, 32, 'RSCORE_ENTITY_TEST_OWNER'),
        expectedAccountsRoot: hexToWireBytes(state.accounts.rootHash(), 32, 'RSCORE_ENTITY_TEST_ROOT'),
        inboundTimestamp: state.timestamp + 3,
        inboundJHeight: state.lastFinalizedJHeight,
        inboundRows: [],
        entityHeight: state.height + 3,
        outboundTimestamp: state.timestamp + 4,
        outboundJHeight: state.lastFinalizedJHeight,
        checkpointDue: true,
        postAccounts: false,
        context: entityDeterministicContextWire(advancedExpected, {
          ...context,
          parentFrameHash: advancedExpected.prevFrameHash!,
          height: advancedExpected.height + 1,
        }, jurisdiction.name),
      });
      const checkpoint = checkpointRound.outbound.checkpoint;
      if (checkpoint === null) throw new Error('RSCORE_ENTITY_TEST_CHECKPOINT_REQUIRED');
      expect(checkpoint.accounts).toHaveLength(1);
      expect(checkpoint.accounts[0]).toHaveLength(12);
      const storageRoot = mkdtempSync(join(tmpdir(), 'xln-rscore-checkpoint-'));
      const storage = new Level<Buffer, Buffer>(storageRoot, {
        keyEncoding: 'buffer',
        valueEncoding: 'buffer',
      });
      try {
        await storage.open();
        // Rust emits a bounded delta checkpoint. Exercise the same canonical
        // materialization used by Runtime WAL commit before strict TS restore;
        // decoding the delta directly would invent a second restore format.
        const prepared = await prepareRscoreCheckpointStorage(storage, [{
          ownerEntityId: owner,
          protocolFingerprint: `0x${RSCORE_PROTOCOL_FINGERPRINT.toString('hex')}`,
          checkpoint,
        }]);
        expect(prepared.exactCheckpoints).toHaveLength(1);
        const checkpointRow = prepared.exactCheckpoints[0]?.accounts[0];
        if (checkpointRow === undefined) throw new Error('RSCORE_ENTITY_TEST_ACCOUNT_ROW_REQUIRED');
        expect(checkpointRow).toHaveLength(11);
        const decoded = decodeRscoreAccountRestoreRow(checkpointRow);
        expect(decoded.consensus.rollbackCount).toBe(3);
        expect(decoded.stateSeed.envelope?.fields['rollbackCount']).toBe(3);
        expect(Object.hasOwn(
          projectRscoreCommittedEnvelopeFields(decoded.stateSeed.envelope?.fields ?? {}),
          'rollbackCount',
        )).toBe(false);
        expect(decoded.entityAccountLeaf).toBe(
          `0x${Buffer.from(checkpointRow[1] as Uint8Array).toString('hex')}`,
        );
      } finally {
        await storage.close();
        rmSync(storageRoot, { recursive: true, force: true });
      }
      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
