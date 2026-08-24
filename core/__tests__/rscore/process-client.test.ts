import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { accountSeedWire, accountTxWire, hexToWireBytes, swapMarketPolicyWire } from '../../rscore/shadow-wire';
import { RSCORE_PROCESS_ABI_VERSION, RscoreProcessClient } from '../../rscore/client';
import { computeFrameHash } from '../../account/consensus/frame/hash';
import { computeAccountStateRoot } from '../../account/commitment/state-root';
import { handleDirectPayment } from '../../account/tx/handlers/balance/direct-payment';
import {
  accountTransitionView,
  beginAccountTransition,
  publishAccountTransition,
} from '../../account/state/candidate-overlay';
import { makeAccount } from '../helpers/cross-j';
import type { AccountFrame, AccountTx, Delta } from '../../types/account';

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


/** The proposal row as an AccountFrame, exactly as TypeScript models one. */
const readFrame = (row: readonly unknown[]): AccountFrame => ({
  height: row[1] as number,
  timestamp: row[2] as number,
  jHeight: row[3] as number,
  accountTxs: [],
  prevFrameHash: row[5] as string,
  accountStateRoot: `0x${Buffer.from(row[6] as Uint8Array).toString('hex')}`,
  stateHash: `0x${Buffer.from(row[9] as Uint8Array).toString('hex')}`,
  byLeft: row[7] as boolean,
  deltas: (row[8] as unknown[][]).map(readDelta),
});

const readDelta = (row: readonly unknown[]): Delta => ({
  tokenId: row[0] as number,
  collateral: BigInt(row[1] as string),
  ondelta: BigInt(row[2] as string),
  offdelta: BigInt(row[3] as string),
  leftCreditLimit: BigInt(row[4] as string),
  rightCreditLimit: BigInt(row[5] as string),
  leftAllowance: BigInt(row[6] as string),
  rightAllowance: BigInt(row[7] as string),
  leftHold: BigInt(row[8] as string),
  rightHold: BigInt(row[9] as string),
});

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
        timestamp: 1_700_000_000_000,
        jHeight: 100,
        entityTimestamp: 1_700_000_000_000,
        finalizedJHeight: 100,
        propose: true,
        admissions: [],
        inputs: [],
      });
      const wave = result as unknown[];
      // No accounts, so nothing moved and nothing was proposed — but the wave
      // is still a candidate that must be committed or taken back.
      expect(wave[0]).toBe(0);
      expect(wave[2]).toEqual([]);
      expect(wave[3]).toEqual([]);

      await expect(
        client.prepareAccountWave({
          timestamp: 1_700_000_000_001,
          jHeight: 100,
          entityTimestamp: 1_700_000_000_001,
          finalizedJHeight: 100,
          propose: true,
          admissions: [],
          inputs: [],
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
  // rebuilding the hash from the wire fields and reaching the same account
  // state root by applying the same transaction itself.
  test('an authoritative session signs a payment frame TypeScript verifies', async () => {
    const client = new RscoreProcessClient(BINARY, identity());
    try {
      const seed = `0x${'7a'.repeat(32)}`;
      const hello = (await client.hello(2, swapMarketPolicyWire(), {
        seed,
        signerId: '1',
      })) as unknown[];
      expect(hello[0]).toBe(RSCORE_PROCESS_ABI_VERSION);
      // Hello reports the identity the engine derived, so the runtime knows
      // which entity it is about to hand accounts to before any frame exists.
      const signerAddress = `0x${Buffer.from(hello[4] as Uint8Array).toString('hex')}`;
      const owner = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`;
      expect(signerAddress).toHaveLength(42);
      expect(owner).toHaveLength(66);

      const counterparty = `0x${'cc'.repeat(32)}`;
      const account = makeAccount(owner, counterparty);
      const loaded = (await client.restore(0, [
        accountSeedWire(owner, counterparty, account.state),
      ])) as unknown[];
      expect(loaded[0]).toBe(0);
      const seededRoot = Buffer.from(loaded[1] as Uint8Array).toString('hex');
      expect(seededRoot).not.toBe('00'.repeat(32));

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
        timestamp: 1_700_000_000_000,
        jHeight: 100,
        entityTimestamp: 1_700_000_000_000,
        finalizedJHeight: 100,
        propose: true,
        admissions: [[hexToWireBytes(counterparty, 32, 'TEST_ACCOUNT_ID'), [wireTx]]],
        inputs: [],
      };
      const first = await client.prepareAccountWave(request);
      const wave = first.result as unknown[];
      const proposals = wave[3] as unknown[][];
      expect(proposals).toHaveLength(1);

      // The wave names the account it moved and the leaf the Entity tree would
      // commit for it, plus one digest over everything it produced.
      const touched = wave[4] as unknown[][];
      expect(touched).toHaveLength(1);
      expect(Buffer.from(touched[0]![0] as Uint8Array).toString('hex'))
        .toBe(counterparty.slice(2));
      expect((touched[0]![1] as Uint8Array).length).toBe(32);
      expect((wave[5] as Uint8Array).length).toBe(32);

      const frame = readFrame(proposals[0]!);
      expect(frame.height).toBe(1);
      expect(frame.prevFrameHash).toBe('genesis');
      expect(proposals[0]![4] as unknown[]).toHaveLength(1);
      // Dropped rows are ordered and explicit; nothing was dropped here.
      expect(proposals[0]![11]).toEqual([]);

      // The frame the wire carries is complete: TypeScript rebuilds the signed
      // hash from it, deltas included, and reaches the same digest the engine
      // signed.
      const rebuilt = await computeFrameHash({ ...frame, accountTxs: [tx] });
      expect(rebuilt).toBe(frame.stateHash);

      // And the state that frame commits is the state TypeScript reaches by
      // applying the same transaction to the same account.
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

      // A runtime that could not make its own record durable takes the wave
      // back, and the same request reaches the same candidate again.
      await client.abort(first.token);
      const second = await client.prepareAccountWave(request);
      const again = second.result as unknown[];
      expect(Buffer.from(again[5] as Uint8Array).toString('hex'))
        .toBe(Buffer.from(wave[5] as Uint8Array).toString('hex'));
      expect(readFrame((again[3] as unknown[][])[0]!).stateHash).toBe(frame.stateHash);

      const committed = (await client.commit(second.token)) as unknown[];
      expect(Buffer.from(committed[1] as Uint8Array).toString('hex'))
        .toBe(Buffer.from(again[1] as Uint8Array).toString('hex'));

      await client.shutdown();
    } finally {
      client.kill();
    }
  });
});
