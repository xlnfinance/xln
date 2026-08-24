import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  accountSeedWire,
  accountTxWire,
  hexToWireBytes,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
  waveAdmitOp,
} from '../../rscore/shadow-wire';
import { decodeWave, waveParityDigest } from '../../rscore/wave-decode';
import { deriveSignerAddressSync } from '../../account/crypto';
import { generateLazyEntityId } from '../../entity/factory';
import { verifyHankoForHash } from '../../hanko/signing';
import { RSCORE_OP, RSCORE_PROCESS_ABI_VERSION, RscoreProcessClient } from '../../rscore/client';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../account/commitment/state-root';
import { handleDirectPayment } from '../../account/tx/handlers/balance/direct-payment';
import {
  accountTransitionView,
  beginAccountTransition,
  publishAccountTransition,
} from '../../account/state/candidate-overlay';
import { makeAccount } from '../helpers/cross-j';
import type { AccountTx } from '../../types/account';

const BINARY = join(import.meta.dir, '../../../rscore/target/release/xln-rscore');

const identity = () => ({
  engineGeneration: Buffer.alloc(8, 0xa0),
  runtimeId: Buffer.alloc(20, 0x10),
  sessionId: Buffer.alloc(16, 0x20),
});

// Live TS→Rust IPC over the real binary: hello → restore(empty) → summary →
// prepare/commit → shutdown. Requires `cargo build --release -p
// xln-rscore-process` (deploy/dev builds it; skip when absent so pure-TS
// environments stay green).
// A release gate sets XLN_RSCORE_REQUIRE_BINARY=1: an absent binary is then a
// failure, never a silent skip.
if (!existsSync(BINARY) && process.env['XLN_RSCORE_REQUIRE_BINARY'] === '1') {
  throw new Error(`RSCORE_BINARY_MISSING:${BINARY}`);
}


describe.skipIf(!existsSync(BINARY))('rscore process client', () => {
  test('speaks the framed ABI end to end', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const hello = (await client.hello(4, swapMarketPolicyWire())) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      expect(hello[2]).toBe(4);

      const loaded = (await client.restore(7, [])) as unknown[];
      expect(loaded[0]).toBe(7);
      // Empty accounts tree commits to the all-zero root.
      expect(new Uint8Array(loaded[1] as Uint8Array)).toEqual(new Uint8Array(32));

      const page = (await client.readAccountSummaryPage(null, 8, [1])) as unknown[];
      expect(page[0]).toBe(7); // revision
      expect(page[1]).toEqual([]); // no accounts
      const totals = page[3] as unknown[];
      expect(totals[0]).toBe(0);

      // Empty waves are refused loudly — no silent no-op commits.
      await expect(client.prepare([])).rejects.toThrow('RSCORE_BATCH_EMPTY');

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  test('an authoritative session runs a wave and commits it', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        seed,
        signerId: '1',
      })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);

      const loaded = (await client.restore(0, [])) as unknown[];
      expect(loaded[0]).toBe(0);

      const { result, token } = await client.prepareAccountWave({
        entities: [{
          ownerEntityId: hexToWireBytes(`0x${'11'.repeat(32)}`, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [],
        }],
      });
      const wave = result as unknown[];
      // No accounts, so nothing moved and nothing was proposed — but the wave
      // is still a candidate that must be committed or taken back.
      expect(wave[0]).toBe(0);
      expect(wave[2]).toEqual([]);
      expect(wave[3]).toEqual([]);

      await expect(
        client.prepareAccountWave({
          entities: [{
            ownerEntityId: hexToWireBytes(`0x${'11'.repeat(32)}`, 32, 'TEST_OWNER'),
            timestamp: 1_700_000_000_001,
            jHeight: 100,
            entityTimestamp: 1_700_000_000_001,
            finalizedJHeight: 100,
            propose: true,
            ops: [],
          }],
        }),
      ).rejects.toThrow('RSCORE_PROCESS_PREPARE_PENDING');

      const committed = (await client.commit(token)) as unknown[];
      expect(committed[0]).toBe(0);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // The whole authoritative path over the real binary: the engine derives its
  // own signer, is handed one funded account, admits a direct_payment, and
  // signs a frame. TypeScript then verifies that frame with its own code —
  // deriving the same identity independently, decoding every field, checking
  // the signature, rebuilding the hash, reaching the same account state root
  // and the same leaf, and recomputing the wave's parity digest.
  test('an authoritative session signs a payment frame TypeScript verifies', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const market = swapMarketPolicyWire();
      const hello = (await client.hello(2, market, { seed, signerId: '1' })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      expect(`0x${Buffer.from(hello[3] as Uint8Array).toString('hex')}`)
        .toBe(swapMarketPolicyDigest(market));

      // TypeScript derives the identity itself and holds the engine to it.
      // Taking the entity from the engine's own answer would prove only that
      // the engine agrees with itself.
      const expectedAddress = deriveSignerAddressSync(seed, '1');
      const expectedOwner = generateLazyEntityId([expectedAddress], 1n);
      expect(`0x${Buffer.from(hello[4] as Uint8Array).toString('hex')}`.toLowerCase())
        .toBe(expectedAddress.toLowerCase());
      expect(`0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase())
        .toBe(expectedOwner.toLowerCase());
      const owner = expectedOwner.toLowerCase();

      const counterparty = `0x${'cc'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      const loaded = (await client.restore(0, [
        accountSeedWire(owner, counterparty, account.state),
      ])) as unknown[];
      expect(loaded[0]).toBe(0);

      const tx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 25n,
          route: [counterparty],
          fromEntityId: owner,
          toEntityId: counterparty,
          deliveryMode: 'direct',
        },
      };
      const wireTx = accountTxWire(tx);
      expect(wireTx).not.toBeNull();

      const request = {
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [waveAdmitOp(counterparty, [wireTx])],
        }],
      };
      const first = await client.prepareAccountWave(request);
      const wave = decodeWave(first.result);
      expect(wave.proposals).toHaveLength(1);
      expect(wave.proposals[0]!.accountId).toBe(counterparty);
      expect(wave.proposals[0]!.dropped).toEqual([]);
      expect(wave.touched).toHaveLength(1);

      // The digest is recomputed from the decoded model: it matches only if
      // every field decoded into something that encodes back identically.
      expect(waveParityDigest(wave)).toBe(wave.parityDigest);

      const frame = wave.proposals[0]!.frame;
      if (frame === null) throw new Error('expected a signed frame');
      expect(frame.height).toBe(1);
      expect(frame.prevFrameHash).toBe('genesis');
      // The transaction came back as the transaction that was sent, decoded
      // from the engine's own bytes rather than substituted from this test.
      expect(frame.accountTxs).toEqual([tx]);

      // The signature is checked against the frame it signs and the entity
      // that must have produced it.
      const verified = await verifyHankoForHash(
        frame.hanko as `0x${string}`,
        frame.stateHash,
        owner,
      );
      expect(verified.valid).toBe(true);

      // TypeScript rebuilds the signed hash from the frame it decoded.
      expect(await computeFrameHash(frame)).toBe(frame.stateHash);

      // And the state that frame commits is the state TypeScript reaches by
      // applying the same transaction to the same account, down to the leaf
      // the Entity tree would put in its accounts map.
      const transition = beginAccountTransition(account);
      const applied = handleDirectPayment(
        accountTransitionView(transition),
        tx as Extract<AccountTx, { type: 'direct_payment' }>,
        frame.byLeft,
      );
      expect(applied.ok).toBe(true);
      publishAccountTransition(account, transition, 'rscore-authority-test');
      expect(computeAccountStateRoot(account.state).toLowerCase())
        .toBe(frame.accountStateRoot);
      // The leaf itself is compared against a live replica in the runtime
      // driver, where the shell is the Entity's own, not one this test
      // assembled by hand.
      expect(wave.touched[0]!.accountId).toBe(counterparty);

      // A runtime that could not make its own record durable takes the wave
      // back, and the same request reaches the same candidate again.
      await client.abort(first.token);
      const second = await client.prepareAccountWave(request);
      const again = decodeWave(second.result);
      expect(again.parityDigest).toBe(wave.parityDigest);

      const committed = (await client.commit(second.token)) as unknown[];
      expect(`0x${Buffer.from(committed[1] as Uint8Array).toString('hex')}`)
        .toBe(again.accountsRoot);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // A request the client never wrote must not consume a request id: the
  // session pins them to an exact sequence, so a spent-but-unsent id would
  // make every later request fail that check and take the engine down.
  test('a request that was never written leaves the sequence intact', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      await client.hello(2, swapMarketPolicyWire());
      await client.restore(3, []);

      await expect(
        client.request(RSCORE_OP.readAccountSummaryPage, [undefined as never]),
      ).rejects.toThrow('RSCORE_CLIENT_VALUE_UNSUPPORTED');

      const page = (await client.readAccountSummaryPage(null, 8, [1])) as unknown[];
      expect(page[0]).toBe(3);

      await client.shutdown();
    } finally {
      client.kill();
    }
  });

  // A window where every transaction is rejected produces no frame, but it
  // still moved the account. The wave must say so, or a driver would compare
  // a tree the engine changed against one it did not.
  test('a window that proposes nothing still reports what it dropped', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        seed,
        signerId: '1',
      })) as unknown[];
      const owner = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase();
      const counterparty = `0x${'ce'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      await client.restore(0, [accountSeedWire(owner, counterparty, account.state)]);

      // Far beyond anything the account can cover, and not a rejection that is
      // retried, so the transaction leaves the mempool for good.
      const tx: AccountTx = {
        type: 'direct_payment',
        data: {
          tokenId: 1,
          amount: 10n ** 40n,
          route: [counterparty],
          fromEntityId: owner,
          toEntityId: counterparty,
          deliveryMode: 'direct',
        },
      };
      const prepared = await client.prepareAccountWave({
        entities: [{
          ownerEntityId: hexToWireBytes(owner, 32, 'TEST_OWNER'),
          timestamp: 1_700_000_000_000,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_000,
          finalizedJHeight: 100,
          propose: true,
          ops: [waveAdmitOp(counterparty, [accountTxWire(tx)] as never)],
        }],
      });
      const wave = decodeWave(prepared.result);

      expect(wave.proposals).toHaveLength(1);
      expect(wave.proposals[0]!.frame).toBeNull();
      expect(wave.proposals[0]!.dropped).toHaveLength(1);
      const dropped = wave.proposals[0]!.dropped[0]!;
      expect(dropped.index).toBe(0);
      expect(dropped.disposition).toBe('removed');
      expect(dropped.code.length).toBeGreaterThan(0);
      expect(wave.touched).toHaveLength(1);
      expect(waveParityDigest(wave)).toBe(wave.parityDigest);

      await client.commit(prepared.token);
      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
