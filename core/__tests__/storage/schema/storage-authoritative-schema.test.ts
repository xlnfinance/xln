import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { Level } from 'level';

import {
  validatePersistedAccountJClaimPathNode,
  validatePersistedCertifiedBoardPathNode,
  validateStorageAccountDocValue,
  validateStorageEntityCoreDocValue,
  validateStorageFrameRecordValue,
  validateStorageHeadValue,
  validateStorageSnapshotManifestValue,
} from '../../../storage/schema/authoritative-schema';
import { decodeValidatedBuffer, encodeBuffer } from '../../../storage/codec/codec';
import { createEmptyEnv } from '../../../runtime';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../../../storage/wal/snapshot';
import { computeStorageFrameHash } from '../../../storage/hashes';
import type { RuntimeFrame } from '../../../storage/types';
import { createEmptyBatch } from '../../../jurisdiction/machine/batch';
import { validateDurableRuntimeMachineSnapshot } from '../../../storage/wal/runtime-machine-schema';
import { validateEntityTx } from '../../../entity/tx-validation';
import { buildEntityTransactionProposalAction } from '../../../entity/auth/authorization';
import { hashEntityCommandTxs } from '../../../entity/command/command-codec';
import {
  KEY_HEAD,
  STORAGE_SCHEMA_VERSION,
  keyAccountJClaimPathNode,
  keyCertifiedBoardPathNode,
  keyFrame,
  keyLiveAccount,
  keyLiveBook,
  keyLiveEntity,
  keySnapshotManifest,
} from '../../../storage/keys';
import { decodeStorageBookHeader } from '../../../storage/schema/book-graph-codec';
import { prepareRuntimeMachineGraphRows } from '../../../storage/wal/runtime-machine-graph';
import { readStorageFramePayloads, readStorageFrameRecord } from '../../../storage/read/read';
import { prepareRuntimeOutputRows } from '../../../storage/wal/outbox-payload';

const paths: string[] = [];

afterEach(() => {
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});

const reopenDecode = async <T>(
  label: string,
  key: Buffer,
  validator: (value: unknown) => T,
): Promise<T> => {
  const path = `/tmp/xln-rdb-schema-${label}-${process.pid}-${Date.now()}`;
  paths.push(path);
  const first = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await first.open();
  await first.put(key, encodeBuffer({}));
  await first.close();
  const reopened = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await reopened.open();
  try {
    return decodeValidatedBuffer(await reopened.get(key), validator);
  } finally {
    await reopened.close();
  }
};

const reopenDecodeValue = async <T>(
  label: string,
  key: Buffer,
  value: unknown,
  validator: (value: unknown) => T,
): Promise<T> => {
  const path = `/tmp/xln-rdb-schema-${label}-${process.pid}-${Date.now()}`;
  paths.push(path);
  const first = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await first.open();
  await first.put(key, encodeBuffer(value));
  await first.close();
  const reopened = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  await reopened.open();
  try {
    return decodeValidatedBuffer(await reopened.get(key), validator);
  } finally {
    await reopened.close();
  }
};

describe('authoritative RDB schemas survive a real close/reopen boundary', () => {
  const entityId = `0x${'11'.repeat(32)}`;
  const counterpartyId = `0x${'22'.repeat(32)}`;
  const hash = `0x${'33'.repeat(32)}`;
  const families = [
    ['head', KEY_HEAD, validateStorageHeadValue],
    ['frame', keyFrame(1), validateStorageFrameRecordValue],
    ['snapshot-manifest', keySnapshotManifest(1), validateStorageSnapshotManifestValue],
    ['entity', keyLiveEntity(entityId), validateStorageEntityCoreDocValue],
    ['account', keyLiveAccount(entityId, counterpartyId), validateStorageAccountDocValue],
    ['book-header', keyLiveBook(entityId, '1:2'), decodeStorageBookHeader],
    [
      'certified-board-path',
      keyCertifiedBoardPathNode(entityId, { kind: 'leaf', key: hash }),
      validatePersistedCertifiedBoardPathNode,
    ],
    [
      'account-j-path',
      keyAccountJClaimPathNode(entityId, counterpartyId, 0, { kind: 'leaf', key: hash }),
      validatePersistedAccountJClaimPathNode,
    ],
  ] as const;

  for (const [family, key, validator] of families) {
    test(`rejects a malformed ${family} value after reopen`, async () => {
      await expect(reopenDecode(family, key, validator)).rejects.toThrow();
    });
  }

  test('rejects a snapshot history pointer above the current materialized pointer', async () => {
    await expect(reopenDecodeValue('head-pointer-order', KEY_HEAD, {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      latestHeight: 4,
      latestMaterializedHeight: 2,
      latestSnapshotHeight: 3,
      snapshotPeriodFrames: 10,
      retainSnapshots: 2,
      epochMaxBytes: Number.MAX_SAFE_INTEGER,
      accountMerkleRadix: 16,
      epochReplayBytes: 0,
      retainedWalBytes: 0,
    }, validateStorageHeadValue)).rejects.toThrow(
      'STORAGE_HEAD_INVALID_SNAPSHOT_AFTER_MATERIALIZED',
    );
  });

  test('rejects retired runtime-machine and entity-context bodies at the frame boundary', async () => {
    const env = createEmptyEnv('storage-runtime-machine-schema');
    const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
    runtimeMachine['infrastructure'] = { pendingCommittedJOutbox: 'CORRUPT' };
    const frame = {
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      frameHash: hash,
      replicaMetaDigest: hash,
      postStateHash: hash,
      materializedState: true,
      canonicalStateHash: hash,
      canonicalEntityHashes: [],
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      entityContexts: new Map([[`0x${'aa'.repeat(32)}:signer-b`, {
        version: 1,
        proposerReplicaId: `0x${'aa'.repeat(32)}:signer-a`,
        entityId: `0x${'aa'.repeat(32)}`,
        proposerSignerId: 'signer-a',
        parentFrameHash: 'genesis',
        height: 1,
        gossipProfiles: [],
        peerAssertions: [],
        htlc: { version: 1, entries: [], originated: [] },
      }]]),
      runtimeMachine,
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };

    await expect(reopenDecodeValue(
      'frame-runtime-machine-outbox',
      keyFrame(1),
      frame,
      validateStorageFrameRecordValue,
    )).rejects.toThrow('STORAGE_FRAME_INVALID_FIELDS');
  });

  test('rejects the retired runtimeStateHash field instead of accepting a duplicate root', () => {
    expect(() => validateStorageFrameRecordValue({
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      frameHash: hash,
      replicaMetaDigest: hash,
      postStateHash: hash,
      materializedState: false,
      runtimeStateHash: hash,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeOutputCount: 0,
      runtimeOutputsDigest: hash,
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    })).toThrow('STORAGE_FRAME_INVALID_FIELDS');
  });

  test('rejects materialization overlays inside a Runtime WAL frame', () => {
    const frame = {
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      frameHash: hash,
      replicaMetaDigest: hash,
      postStateHash: hash,
      stateHash: '',
      hashMode: 'storage-merkle-v1',
      materializedState: false,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      overlayRecords: [],
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };

    expect(() => validateStorageFrameRecordValue(frame))
      .toThrow('STORAGE_FRAME_INVALID_FIELDS');
  });

  test('rejects unknown runtime-state fields and corrupt nested J entries', () => {
    const base = buildDurableRuntimeMachineSnapshot(createEmptyEnv('runtime-machine-corrupt-variants'));
    const unknownState = structuredClone(base);
    unknownState['infrastructure'] = { unexpected: true };
    expect(() => validateDurableRuntimeMachineSnapshot(unknownState, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_RUNTIME_STATE_FIELDS:missing=none:extra=unexpected');

    const corruptOutboxEntry = structuredClone(base);
    corruptOutboxEntry['infrastructure'] = {
      pendingCommittedJOutbox: [{ jurisdictionName: 'Testnet', jTxs: 'CORRUPT' }],
    };
    expect(() => validateDurableRuntimeMachineSnapshot(corruptOutboxEntry, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_RUNTIME_STATE_PENDING_COMMITTED_J_OUTBOX_0_TXS');

    const corruptJReplica = structuredClone(base);
    corruptJReplica['jReplicas'] = [[
      'Testnet',
      {
        name: 'Testnet',
        blockNumber: 0n,
        stateRoot: new Uint8Array(32),
        mempool: [],
        blockDelayMs: 300,
        lastBlockTimestamp: 0,
        position: { x: 0, y: 0, z: 0 },
        contracts: { unexpected: '0x01' },
      },
    ]];
    expect(() => validateDurableRuntimeMachineSnapshot(corruptJReplica, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_J_REPLICAS_0_VALUE_CONTRACTS_FIELDS');
  });

  test('rejects a persisted Runtime mempool as a retired durable field', () => {
    // The Runtime mempool is ephemeral replica-envelope state. A machine
    // snapshot written by the retired format carried it as `runtimeInput`;
    // that shape must fail loudly instead of restoring unframed inputs.
    const env = createEmptyEnv('runtime-machine-retired-pending-input');
    const current = buildDurableRuntimeMachineSnapshot(env);
    expect(current['runtimeInput']).toBeUndefined();
    const retired = {
      ...current,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
    };
    expect(() => validateDurableRuntimeMachineSnapshot(retired, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_FIELDS');
  });

  test('rejects a V1 Runtime machine without its persisted frame cadence', () => {
    const current = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-missing-frame-cadence'),
    );
    delete current['runtimeConfig'];
    expect(() => validateDurableRuntimeMachineSnapshot(current, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_FIELDS:missing=runtimeConfig:extra=none');
  });

  test('rejects a noncanonical RuntimeId before durable snapshot restore', () => {
    const snapshot = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-runtime-id'),
    );
    snapshot['runtimeId'] = `0x${'AB'.repeat(20)}`;
    expect(() => validateDurableRuntimeMachineSnapshot(snapshot, 'RUNTIME_MACHINE'))
      .toThrow('Invalid RuntimeId');
  });

  test('rejects RAM transport queues as retired durable machine fields', () => {
    const current = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-retired-queues'),
    );
    expect(current['pendingOutputs']).toBeUndefined();
    expect(current['networkInbox']).toBeUndefined();
    expect(current['pendingNetworkOutputs']).toBeUndefined();
    for (const field of ['pendingOutputs', 'networkInbox', 'pendingNetworkOutputs']) {
      expect(() => validateDurableRuntimeMachineSnapshot(
        { ...current, [field]: [] },
        'RUNTIME_MACHINE',
      )).toThrow('RUNTIME_MACHINE_FIELDS');
    }
  });

  test('recursively rejects malformed EntityTx payloads in every nested carrier', () => {
    const corruptIndividual = { type: 'chat', data: 'CORRUPT' } as never;
    const corruptCollective = { type: 'directPayment', data: 'CORRUPT' } as never;
    const entityCommand = {
      type: 'entityCommand',
      data: {
        version: 1,
        entityId,
        stackKey: hash,
        boardHash: hash,
        boardEpoch: 0,
        authorSignerId: `0x${'44'.repeat(20)}`,
        authorSigner: `0x${'44'.repeat(20)}`,
        nonce: 1n,
        txsHash: hashEntityCommandTxs([corruptIndividual]),
        txs: [corruptIndividual],
        signature: `0x${'55'.repeat(65)}`,
      },
    };
    const propose = {
      type: 'propose',
      data: {
        proposer: `0x${'44'.repeat(20)}`,
        action: buildEntityTransactionProposalAction([corruptCollective]),
      },
    };
    for (const [index, tx] of [entityCommand, propose].entries()) {
      expect(() => validateEntityTx(tx, `NESTED_${index}`)).toThrow();
    }
  });

  test('rejects a local enqueue hidden inside a persisted EntityTx', () => {
    expect(() => validateEntityTx({
      type: 'accountInput',
      data: {
        kind: 'enqueue',
        fromEntityId: entityId,
        toEntityId: counterpartyId,
        domain: {
          chainId: 31_337,
          depositoryAddress: `0x${'11'.repeat(20)}`,
        },
        disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
        watchSeed: hash,
        txs: [],
      },
    }, 'ACCOUNT_INPUT_WAL')).toThrow('ACCOUNT_INPUT_WAL_DATA_KIND_INVALID:enqueue');
  });

  test('exactly decodes persisted Account inputs before restore', () => {
    const base = {
      kind: 'ack',
      fromEntityId: entityId,
      toEntityId: counterpartyId,
      domain: {
        chainId: 31_337,
        depositoryAddress: `0x${'11'.repeat(20)}`,
      },
      disputeConfig: { leftResponseSeconds: 10, rightResponseSeconds: 10 },
      watchSeed: hash,
    };
    const validAck = {
      ...base,
      ack: {
        height: 1,
        frameHash: hash,
        disputeHanko: {
          hash,
          proofBodyHash: hash,
          proofNonce: 1,
          proposerIsLeft: true,
        },
      },
    };

    expect(() => validateEntityTx({
      type: 'accountInput',
      data: validAck,
    }, 'ACCOUNT_INPUT_WAL')).not.toThrow();

    expect(() => validateEntityTx({
      type: 'accountInput',
      data: {
        ...validAck,
        ack: {
          ...validAck.ack,
          disputeHanko: {
            ...validAck.ack.disputeHanko,
            proofNonce: '1',
          },
        },
      },
    }, 'ACCOUNT_INPUT_WAL')).toThrow(
      'ACCOUNT_INPUT_WAL_DATA_ACK_DISPUTE_HANKO_PROOF_NONCE',
    );

    expect(() => validateEntityTx({
      type: 'accountInput',
      data: { ...validAck, unexpected: true },
    }, 'ACCOUNT_INPUT_WAL')).toThrow(
      'ACCOUNT_INPUT_WAL_DATA_FIELDS:missing=none:extra=unexpected',
    );
  });

  test('valid nested outbox round-trips without changing frame hash or restore state', async () => {
    const env = createEmptyEnv('storage-runtime-machine-roundtrip');
    const batch = createEmptyBatch();
    batch.reserveToReserve.push({ receivingEntity: `0x${'ab'.repeat(32)}`, tokenId: 1, amount: 7n });
    env.infrastructure = {
      pendingCommittedJOutbox: [{
        jurisdictionName: 'Testnet',
        jTxs: [{
          type: 'batch',
          entityId,
          data: {
            batch,
            batchHash: hash,
            encodedBatch: '0x01',
            entityNonce: 1,
            batchGeneration: 1,
            batchSize: 1,
            signerId: `0x${'44'.repeat(20)}`,
            runtimeSubmitAttempt: {
              attemptId: hash,
              attemptNumber: 1,
              attemptedAt: 1,
              batchGeneration: 1,
            },
          },
          timestamp: 1,
        }],
      }],
    };
    const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
    const machineGraph = prepareRuntimeMachineGraphRows(runtimeMachine);
    if (!machineGraph.root) throw new Error('TEST_RUNTIME_MACHINE_ROOT_MISSING');
    const emptyOutputs = prepareRuntimeOutputRows(1, []).commitment;
    const frameBase: RuntimeFrame = {
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      replicaMetaDigest: hash,
      postStateHash: hash,
      materializedState: true,
      canonicalStateHash: hash,
      canonicalEntityHashes: [],
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeMachineRoot: machineGraph.root,
      runtimeOutputCount: emptyOutputs.count,
      runtimeOutputsDigest: emptyOutputs.digest,
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };
    const frame = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };

    const path = `/tmp/xln-rdb-schema-frame-runtime-machine-roundtrip-${process.pid}-${Date.now()}`;
    paths.push(path);
    const first = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await first.open();
    await first.batch([
      {
        type: 'put',
        key: KEY_HEAD,
        value: encodeBuffer({
          schemaVersion: STORAGE_SCHEMA_VERSION,
          latestHeight: 1,
          latestMaterializedHeight: 1,
          latestSnapshotHeight: 1,
          snapshotPeriodFrames: 1,
          retainSnapshots: 1,
          epochMaxBytes: Number.MAX_SAFE_INTEGER,
          accountMerkleRadix: 16,
          epochReplayBytes: 0,
          retainedWalBytes: 0,
        }),
      },
      { type: 'put', key: keyFrame(1), value: encodeBuffer(frame) },
      ...machineGraph.rows.map(row => ({ type: 'put' as const, ...row })),
    ]);
    await first.close();
    const reopened = new Level<Buffer, Buffer>(path, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
    await reopened.open();
    const decoded = await readStorageFrameRecord(reopened, 1);
    expect(decoded).not.toBeNull();
    if (!decoded) throw new Error('STORAGE_FRAME_ROUNDTRIP_MISSING');
    expect(decoded.canonicalStateHash).toBe(hash);
    expect(Object.hasOwn(decoded, 'runtimeStateHash')).toBe(false);
    const payloads = await readStorageFramePayloads(reopened, decoded);
    await reopened.close();
    expect(computeStorageFrameHash(decoded)).toBe(frame.frameHash);
    expect(payloads.entityContexts).toEqual(new Map());
    const restored = createEmptyEnv('storage-runtime-machine-roundtrip-restored');
    restoreDurableRuntimeSnapshot(restored, payloads.runtimeMachine!);
    expect(restored.infrastructure?.pendingCommittedJOutbox).toEqual(
      env.infrastructure.pendingCommittedJOutbox,
    );
  });
});
