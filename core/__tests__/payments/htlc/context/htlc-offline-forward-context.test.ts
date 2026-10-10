import { describe, expect, test } from 'bun:test';
import { getBytes, hexlify } from 'ethers';
import { x25519 } from '@noble/curves/ed25519.js';

import { deriveSignerKeySync } from '../../../../account/crypto';
import { applyCommittedHtlcLockFollowup } from '../../../../entity/tx/handlers/account/committed-htlc-followups';
import {
  assertHtlcPreparedInfraContext,
  materializeHtlcPreparedInfraContext,
} from '../../../../entity/paybook/materialize-context';
import { openWritableEntityAccounts, entity, makeAccount, makeJurisdiction, makeState, secret } from '../../../helpers/cross-j';
import { createOnionEnvelopes } from '../../../../protocol/htlc/codec/envelope';
import { hashHtlcSecret } from '../../../../protocol/htlc/utils';
import type { EntityTx } from '../../../../types/entity-tx';
import { MalformedEntityFrameInputError } from '../../../../entity/tx/processing/invariant-errors';
import {
  applyBookIntentProgram,
  createBookIntentProgram,
} from '../../../../entity/books/book-intents';

const x25519Public = (privateKey: string): string => hexlify(x25519.getPublicKey(getBytes(privateKey)));

describe('offline HTLC forwarding from committed Entity context', () => {
  test('rejects before outbound lock creation and queues the upstream error in the same Entity frame', async () => {
    const source = entity('11');
    const hub = entity('22');
    const target = entity('33');
    const jurisdiction = makeJurisdiction('offline-forward', 31_337, '44', '55');
    const signerId = entity('66');
    const state = makeState(hub, signerId, jurisdiction, source);
    openWritableEntityAccounts(state).set(
      target,
      makeAccount(hub, target, jurisdiction),
    );
    const hubPrivateKey = hexlify(deriveSignerKeySync(hub, 'entity-encryption'));
    const sourcePrivateKey = secret('71');
    const targetPrivateKey = secret('73');
    const publicKeys = new Map([
      [source, x25519Public(sourcePrivateKey)],
      [hub, state.entityEncryptionPublicKey],
      [target, x25519Public(targetPrivateKey)],
    ]);
    const preimage = secret('81');
    const hashlock = hashHtlcSecret(preimage);
    const domain = { chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress };
    const amount = 10n;
    const forwardAmount = 9n;
    const timelock = 100_000n;
    const revealBeforeHeight = 100;
    const envelope = await createOnionEnvelopes(
      [source, hub, target],
      preimage,
      publicKeys,
      [domain, domain],
      new Map([[hub, forwardAmount]]),
      undefined,
      state.timestamp,
      { hashlock, tokenId: 1, senderLockAmount: amount, timelock, revealBeforeHeight },
      () => sourcePrivateKey,
    );
    const lock = {
      type: 'htlc_lock' as const,
      data: {
        lockId: hashlock,
        hashlock,
        tokenId: 1,
        amount,
        timelock,
        revealBeforeHeight,
        envelope,
      },
    };
    const frame = {
      height: 1,
      timestamp: state.timestamp,
      jHeight: 0,
      accountTxs: [lock],
      prevFrameHash: '',
      accountStateRoot: secret('91'),
      stateHash: secret('92'),
    };
    const accountInput = {
      type: 'accountInput',
      data: {
        kind: 'ack_frame',
        fromEntityId: source,
        toEntityId: hub,
        domain,
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        proposal: { frame, frameHanko: secret('93') },
      },
    } satisfies EntityTx;
    const prepared = await materializeHtlcPreparedInfraContext({
      state,
      proposalTxs: [accountInput],
      entityEncryptionPublicKey: state.entityEncryptionPublicKey,
      entityEncryptionPrivateKey: hubPrivateKey,
      isEntityOnline: entityId => entityId !== target,
      profiles: [],
      parentFrameHash: state.prevFrameHash,
      height: state.height + 1,
      resolveRoute: async () => { throw new Error('test route resolver must not run'); },
    });
    expect(prepared.entries).toHaveLength(1);
    expect(prepared.entries[0]?.outcome).toEqual({ kind: 'reject', reason: 'next_hop_offline' });

    const committedContext = {
      version: 1 as const,
      proposerReplicaId: `${hub}:${signerId}`,
      entityId: hub,
      proposerSignerId: signerId,
      parentFrameHash: state.prevFrameHash,
      height: state.height + 1,
      gossipProfiles: [],
      peerAssertions: [{ entityId: target, online: false }],
      htlc: prepared,
    };
    await expect(assertHtlcPreparedInfraContext({
      state,
      proposalTxs: [accountInput],
      context: committedContext,
      entityEncryptionPrivateKey: hubPrivateKey,
    })).resolves.toBeUndefined();

    const accountTxs: Array<{ accountId: string; tx: unknown }> = [];
    const preparedEntry = prepared.entries[0];
    if (!preparedEntry) throw new Error('prepared HTLC entry missing');
    const sourceAccount = state.accounts.get(source);
    if (!sourceAccount) throw new Error('source Account missing');
    const bookIntents = createBookIntentProgram();
    await applyCommittedHtlcLockFollowup({
      env: {},
      state,
      newState: state,
      input: accountInput.data,
      account: sourceAccount,
      outputs: [],
      accountTxs,
      candidateEffects: [],
      bookIntentSlot: bookIntents.openSlot(),
      infraContext: committedContext,
      preparedHtlcEntriesByBinding: new Map([[`${frame.stateHash}:${hashlock}`, preparedEntry]]),
      consumedPreparedHtlcBindings: new Set(),
    } as never, lock, frame, source < hub, true);
    applyBookIntentProgram(state, bookIntents);
    expect(accountTxs).toEqual([{
      accountId: source,
      tx: {
        type: 'htlc_resolve',
        data: { lockId: hashlock, outcome: 'error', reason: 'next_hop_offline' },
      },
    }]);
  });

  test('a peer frame with two different locks for one hashlock rejects that accountInput', async () => {
    // Nothing before materialization rejects a duplicate hashlock inside one
    // Account frame (the duplicate-lockId check runs in Account apply). Two
    // different bindings used to throw a plain HTLC_PREPARED_BINDING_CONFLICT
    // and halt the proposer before Account validation could run.
    const source = entity('11');
    const hub = entity('22');
    const target = entity('33');
    const jurisdiction = makeJurisdiction('binding-conflict', 31_337, '44', '55');
    const state = makeState(hub, entity('66'), jurisdiction, source);
    openWritableEntityAccounts(state).set(target, makeAccount(hub, target, jurisdiction));
    const hubPrivateKey = hexlify(deriveSignerKeySync(hub, 'entity-encryption'));
    const sourcePrivateKey = secret('71');
    const publicKeys = new Map([
      [source, x25519Public(sourcePrivateKey)],
      [hub, state.entityEncryptionPublicKey],
      [target, x25519Public(secret('73'))],
    ]);
    const preimage = secret('81');
    const hashlock = hashHtlcSecret(preimage);
    const domain = { chainId: jurisdiction.chainId, depositoryAddress: jurisdiction.depositoryAddress };
    const envelope = await createOnionEnvelopes(
      [source, hub, target], preimage, publicKeys, [domain, domain],
      new Map([[hub, 9n]]), undefined, state.timestamp,
      { hashlock, tokenId: 1, senderLockAmount: 10n, timelock: 100_000n, revealBeforeHeight: 100 },
      () => sourcePrivateKey,
    );
    const lockOf = (amount: bigint) => ({
      type: 'htlc_lock' as const,
      data: { lockId: hashlock, hashlock, tokenId: 1, amount, timelock: 100_000n, revealBeforeHeight: 100, envelope },
    });
    const accountInput = {
      type: 'accountInput',
      data: {
        kind: 'ack_frame',
        fromEntityId: source,
        toEntityId: hub,
        domain,
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        proposal: {
          frame: {
            height: 1, timestamp: state.timestamp, jHeight: 0,
            accountTxs: [lockOf(10n), lockOf(11n)],
            prevFrameHash: '', accountStateRoot: secret('91'), stateHash: secret('92'),
          },
          frameHanko: secret('93'),
        },
      },
    } satisfies EntityTx;
    const error = await materializeHtlcPreparedInfraContext({
      state,
      proposalTxs: [accountInput],
      entityEncryptionPublicKey: state.entityEncryptionPublicKey,
      entityEncryptionPrivateKey: hubPrivateKey,
      isEntityOnline: () => true,
      profiles: [],
      parentFrameHash: state.prevFrameHash,
      height: state.height + 1,
      resolveRoute: async () => { throw new Error('test route resolver must not run'); },
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(MalformedEntityFrameInputError);
    expect((error as MalformedEntityFrameInputError).disposition).toBe('reject');
    expect((error as MalformedEntityFrameInputError).rejection).toBe(
      `HTLC_PREPARED_BINDING_CONFLICT:${secret('92')}:${hashlock}`,
    );
    expect((error as MalformedEntityFrameInputError).frameTx).toBe(accountInput);
  });
});
