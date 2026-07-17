import { afterEach, describe, expect, test } from 'bun:test';
import { rmSync } from 'fs';
import { Level } from 'level';

import {
  validateAccountJClaimNodeValue,
  validateCertifiedBoardNodeValue,
  validateConsumptionNodeValue,
  validateStorageAccountDocValue,
  validateStorageBookDocValue,
  validateStorageDiffRecordValue,
  validateStorageEntityCoreDocValue,
  validateStorageFrameRecordValue,
  validateStorageHeadValue,
  validateStorageMerkleBranchDocValue,
  validateStorageMerkleLeafDocValue,
  validateStorageMerkleRootDocValue,
  validateStorageSnapshotManifestValue,
} from '../storage/authoritative-schema';
import { decodeValidatedBuffer, encodeBuffer } from '../storage/codec';
import { createEmptyEnv } from '../runtime';
import { buildDurableRuntimeMachineSnapshot, restoreDurableRuntimeSnapshot } from '../wal/snapshot';
import { computeStorageFrameHash } from '../storage/hashes';
import type { StorageFrameRecord } from '../storage/types';
import { createEmptyBatch } from '../jurisdiction/batch';
import {
  decodePersistedFrameJournal,
  encodePersistedFrameJournal,
} from '../wal/store';
import { validateDurableRuntimeMachineSnapshot } from '../wal/runtime-machine-schema';
import { validateEntityTx } from '../wal/runtime-machine-schema/entity-tx';
import { buildEntityTransactionProposalAction } from '../entity/authorization';
import { hashEntityCommandTxs } from '../entity/command-codec';
import {
  KEY_HEAD,
  keyAccountJClaimNode,
  keyCertifiedBoardNode,
  keyConsumptionNode,
  keyDiff,
  keyFrame,
  keyLiveAccount,
  keyLiveBook,
  keyLiveEntity,
  keyMerkleBranch,
  keyMerkleLeaf,
  keyMerkleRoot,
  keySnapshotManifest,
} from '../storage/keys';

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
    ['diff', keyDiff(1), validateStorageDiffRecordValue],
    ['entity', keyLiveEntity(entityId), validateStorageEntityCoreDocValue],
    ['account', keyLiveAccount(entityId, counterpartyId), validateStorageAccountDocValue],
    ['book', keyLiveBook(entityId, '1:2'), validateStorageBookDocValue],
    ['merkle-root', keyMerkleRoot(entityId, 'runtime-roots'), validateStorageMerkleRootDocValue],
    ['merkle-branch', keyMerkleBranch(entityId, 'runtime-roots', Buffer.from([0])), validateStorageMerkleBranchDocValue],
    ['merkle-leaf', keyMerkleLeaf(entityId, 'runtime-roots', Buffer.from([0])), validateStorageMerkleLeafDocValue],
    ['certified-board-cas', keyCertifiedBoardNode(hash), validateCertifiedBoardNodeValue],
    ['consumption-cas', keyConsumptionNode(hash), validateConsumptionNodeValue],
    ['account-j-cas', keyAccountJClaimNode(hash), validateAccountJClaimNodeValue],
  ] as const;

  for (const [family, key, validator] of families) {
    test(`rejects a malformed ${family} value after reopen`, async () => {
      await expect(reopenDecode(family, key, validator)).rejects.toThrow();
    });
  }

  test('rejects nested runtime-machine outbox corruption at the frame decode boundary', async () => {
    const env = createEmptyEnv('storage-runtime-machine-schema');
    const runtimeMachine = buildDurableRuntimeMachineSnapshot(env);
    runtimeMachine['runtimeState'] = { pendingCommittedJOutbox: 'CORRUPT' };
    const frame = {
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      frameHash: hash,
      replicaMetaDigest: hash,
      stateHash: hash,
      hashMode: 'storage-merkle-v1',
      materializedState: true,
      entityHashes: [],
      runtimeStateHash: hash,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeMachineBeforeApply: buildDurableRuntimeMachineSnapshot(env),
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
    )).rejects.toThrow('STORAGE_FRAME_INVALID_MACHINE_RUNTIME_STATE_PENDING_COMMITTED_J_OUTBOX');
  });

  test('WAL and storage share the same nested runtime-machine schema', () => {
    const env = createEmptyEnv('wal-runtime-machine-schema');
    const validMachine = buildDurableRuntimeMachineSnapshot(env);
    const corruptMachine = structuredClone(validMachine);
    corruptMachine['runtimeState'] = { pendingCommittedJOutbox: 'CORRUPT' };

    expect(() => decodePersistedFrameJournal(encodePersistedFrameJournal({
      height: 1,
      timestamp: 1,
      replicaMetaDigest: hash,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeMachineBeforeApply: validMachine,
      runtimeMachine: corruptMachine,
      logs: [],
    }), 1)).toThrow(
      'WAL_RUNTIME_MACHINE_INVALID:height=1_RUNTIME_STATE_PENDING_COMMITTED_J_OUTBOX',
    );
  });

  test('rejects unknown runtime-state fields and corrupt nested J entries', () => {
    const base = buildDurableRuntimeMachineSnapshot(createEmptyEnv('runtime-machine-corrupt-variants'));
    const unknownState = structuredClone(base);
    unknownState['runtimeState'] = { unexpected: true };
    expect(() => validateDurableRuntimeMachineSnapshot(unknownState, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_RUNTIME_STATE_FIELDS:missing=none:extra=unexpected');

    const corruptOutboxEntry = structuredClone(base);
    corruptOutboxEntry['runtimeState'] = {
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
      .toThrow('RUNTIME_MACHINE_J_REPLICAS_0_CONTRACTS_FIELDS');
  });

  test('rejects malformed RuntimeTx and EntityTx payloads before restore', () => {
    const corruptRuntimeTx = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-corrupt-runtime-tx'),
    );
    corruptRuntimeTx['runtimeInput'] = {
      runtimeTxs: [{ type: 'importJ', data: 'CORRUPT' }],
      entityInputs: [],
    };
    expect(() => validateDurableRuntimeMachineSnapshot(corruptRuntimeTx, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_RUNTIME_INPUT_RUNTIME_TX_0_DATA');

    const corruptEntityTx = buildDurableRuntimeMachineSnapshot(
      createEmptyEnv('runtime-machine-corrupt-entity-tx'),
    );
    corruptEntityTx['runtimeInput'] = {
      runtimeTxs: [],
      entityInputs: [{
        entityId,
        signerId: `0x${'44'.repeat(20)}`,
        entityTxs: [{ type: 'chat', data: 'CORRUPT' }],
      }],
    };
    expect(() => validateDurableRuntimeMachineSnapshot(corruptEntityTx, 'RUNTIME_MACHINE'))
      .toThrow('RUNTIME_MACHINE_RUNTIME_INPUT_ENTITY_INPUT_0_ENTITY_TX_0_DATA');
  });

  test('recursively rejects malformed EntityTx payloads in every nested carrier', () => {
    const corruptIndividual = { type: 'chat', data: 'CORRUPT' } as never;
    const corruptCollective = { type: 'directPayment', data: 'CORRUPT' } as never;
    const entityCommand = {
      type: 'entityCommand',
      data: {
        version: 2,
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
    const consensusOutput = {
      type: 'consensusOutput',
      data: {
        origin: {
          sourceEntityId: entityId,
          lane: 'generic',
          sequence: 1n,
          semanticHash: hash,
          height: 1,
          frameHash: hash,
          outputIndex: 0,
        },
        outputHanko: '0x01',
        targetEntityId: counterpartyId,
        entityTxs: [corruptIndividual],
      },
    };
    const reissue = {
      type: 'reissueCertifiedOutput',
      data: {
        targetEntityId: counterpartyId,
        targetSignerId: `0x${'44'.repeat(20)}`,
        sequence: 1n,
        semanticHash: hash,
        entityTxs: [corruptIndividual],
      },
    };

    for (const [index, tx] of [entityCommand, propose, consensusOutput, reissue].entries()) {
      expect(() => validateEntityTx(tx, `NESTED_${index}`)).toThrow('DATA');
    }
  });

  test('valid nested outbox round-trips without changing frame hash or restore state', async () => {
    const env = createEmptyEnv('storage-runtime-machine-roundtrip');
    const batch = createEmptyBatch();
    batch.flashloans.push({ tokenId: 1, amount: 7n });
    env.runtimeState = {
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
    const frameBase: StorageFrameRecord = {
      height: 1,
      timestamp: 1,
      prevFrameHash: hash,
      replicaMetaDigest: hash,
      stateHash: hash,
      hashMode: 'storage-merkle-v1',
      materializedState: true,
      entityHashes: [],
      runtimeStateHash: hash,
      runtimeInput: { runtimeTxs: [], entityInputs: [] },
      runtimeMachineBeforeApply: runtimeMachine,
      runtimeMachine,
      touchedEntities: [],
      touchedAccounts: [],
      touchedBookEntities: [],
    };
    const frame = { ...frameBase, frameHash: computeStorageFrameHash(frameBase) };

    const decoded = await reopenDecodeValue(
      'frame-runtime-machine-roundtrip',
      keyFrame(1),
      frame,
      validateStorageFrameRecordValue,
    );
    expect(computeStorageFrameHash(decoded)).toBe(frame.frameHash);
    const restored = createEmptyEnv('storage-runtime-machine-roundtrip-restored');
    restoreDurableRuntimeSnapshot(restored, decoded.runtimeMachine!);
    expect(restored.runtimeState?.pendingCommittedJOutbox).toEqual(
      env.runtimeState.pendingCommittedJOutbox,
    );
  });
});
