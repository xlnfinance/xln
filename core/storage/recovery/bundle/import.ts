import type { Level } from 'level';
import type { RuntimeReplica } from '../../../runtime/types';
import type { RuntimeDbLike, PersistedFrameJournal } from '../../types';
import type { StorageDbRole } from '../../runtime-dbs';
import { withStorageWriterLock } from '../../runtime-dbs';
import { iterateKeys } from '../../database/level';
import { writeBatch } from '../../codec/codec';
import { readStorageHead } from '../../read/read';
import { verifyStorageTailIntegrity } from '../../read/verify';
import { assertRuntimeActivityViewEmpty, resetRuntimeActivityViewAtFloor } from '../../history/runtime-activity-view';
import { validateRuntimeRecording } from './recording';
import { assertRuntimeRecoveryBundleAuthenticity } from './index';
import { deriveSignerAddressSync, deriveSignerKeySync, registerSignerKey } from '../../../account/crypto';
import type { RuntimeRecording } from './types';

type RuntimeModule = typeof import('../../../runtime');
export type RecoveryArchiveImportDeps = Pick<RuntimeModule,
  'createEmptyEnv' | 'restoreEnvFromRecoveryBundles' | 'persistRestoredEnvToDB' |
  'replayRecoveryFrameJournals' | 'saveEnvToDB' | 'readPersistedFrameJournal' |
  'loadEnvFromDB' | 'closeRuntimeDb' | 'closeInfraDb' | 'getRuntimeWalDb' |
  'tryOpenRuntimeWalDb' | 'tryOpenStorageDb' | 'getInfraDb'
> & {
  getStorageDb(env: RuntimeReplica, role: StorageDbRole): Level<Buffer, Buffer>;
  tryOpenInfraDb(env: RuntimeReplica): Promise<boolean>;
};
export type RecoveryArchiveImportOptions = {
  onPublicationBoundary?: (boundary: 'before-publish' | 'after-publish') => void | Promise<void>;
};

const assertEmpty = async (db: RuntimeDbLike): Promise<void> => {
  if (!db.keys) throw new Error('RECOVERY_IMPORT_KEYS_UNSUPPORTED');
  for await (const _key of iterateKeys(db, {})) throw new Error('RECOVERY_IMPORT_DESTINATION_NOT_EMPTY');
};

const assertFreshDestination = async (deps: RecoveryArchiveImportDeps, env: RuntimeReplica): Promise<void> => {
  // The canonical opener also resolves any interrupted epoch rotation before
  // emptiness is checked. A missing previous epoch is normal on a fresh device.
  if (!await deps.tryOpenStorageDb(env, 'current')) throw new Error('RECOVERY_IMPORT_DESTINATION_OPEN_FAILED');
  await assertEmpty(deps.getStorageDb(env, 'current'));
  const previous = deps.getStorageDb(env, 'previous');
  await previous.open();
  await assertEmpty(previous);
  if (!await deps.tryOpenRuntimeWalDb(env) || !await deps.tryOpenInfraDb(env))
    throw new Error('RECOVERY_IMPORT_DESTINATION_OPEN_FAILED');
  await assertEmpty(deps.getRuntimeWalDb(env));
  await assertEmpty(deps.getInfraDb(env));
  await assertRuntimeActivityViewEmpty(env);
};

const registerArchiveSigners = (recording: RuntimeRecording, seed: string): void => {
  for (const bundle of recording.bundles) {
    assertRuntimeRecoveryBundleAuthenticity(bundle, seed, recording.runtimeId);
    for (const signer of bundle.signers) {
      const label = String((signer.derivationIndex ?? signer.index) + 1);
      const address = deriveSignerAddressSync(seed, label);
      if (address !== signer.address) throw new Error('RECOVERY_IMPORT_SIGNER_DERIVATION_MISMATCH');
      registerSignerKey(seed, address, deriveSignerKeySync(seed, label));
    }
  }
};

const persistVerifiedFrame = async (
  deps: RecoveryArchiveImportDeps, stage: RuntimeReplica, frame: PersistedFrameJournal,
): Promise<void> => {
  await deps.replayRecoveryFrameJournals(stage, [frame]);
  // The replay guard has been released. This is the ordinary writer, with
  // original accepted input, verified outputs and signed Entity contexts.
  const saved = await deps.saveEnvToDB(stage, frame.runtimeInput, frame.runtimeOutputs, frame.entityContexts ?? new Map());
  if (saved.staleWriterStopped) throw new Error('RECOVERY_IMPORT_STAGE_WRITER_STOPPED');
  const stored = await deps.readPersistedFrameJournal(stage, frame.height);
  for (const key of ['replicaMetaDigest', 'postStateHash', 'runtimeOutputsDigest', 'runtimeOutputCount'] as const) {
    if (!stored || stored[key] !== frame[key])
      throw new Error(`RECOVERY_IMPORT_STAGE_COMMITMENT_MISMATCH:${frame.height}:${key}`);
  }
};

const publishArchive = async (
  deps: RecoveryArchiveImportDeps, stage: RuntimeReplica, target: RuntimeReplica,
  height: number, options: RecoveryArchiveImportOptions,
): Promise<void> => {
  const source = deps.getRuntimeWalDb(stage);
  const head = await readStorageHead(source);
  if (!head || head.latestHeight !== height || stage.state.height !== height)
    throw new Error('RECOVERY_IMPORT_STAGE_TIP_MISMATCH');
  await verifyStorageTailIntegrity(source, { tailFrames: 10_001 });
  await withStorageWriterLock(target, async () => {
    await assertFreshDestination(deps, target);
    const batch = deps.getRuntimeWalDb(target).batch();
    for await (const key of iterateKeys(source, {})) batch.put(key, await source.get(key));
    await options.onPublicationBoundary?.('before-publish');
    // All rows were produced by the canonical codecs/writer. One sync batch
    // publishes checkpoint, full retained tail and head together: a crash must
    // never expose the pre-payment prefix as a recovered spendable wallet.
    await writeBatch(batch, { sync: true });
    await options.onPublicationBoundary?.('after-publish');
  });
};

const clearStage = async (deps: RecoveryArchiveImportDeps, stage: RuntimeReplica): Promise<void> => {
  // This private namespace has never been exposed as a wallet. Never call
  // clearDB here: its Node implementation clears the entire Runtime root.
  for (const role of ['current', 'previous'] as const) {
    if (await deps.tryOpenStorageDb(stage, role)) await deps.getStorageDb(stage, role).clear();
  }
  if (await deps.tryOpenRuntimeWalDb(stage)) await deps.getRuntimeWalDb(stage).clear();
  await resetRuntimeActivityViewAtFloor(stage, 0);
};

const buildAndPublishArchive = async (
  deps: RecoveryArchiveImportDeps, recording: RuntimeRecording, stage: RuntimeReplica,
  target: RuntimeReplica, options: RecoveryArchiveImportOptions,
): Promise<void> => {
  await deps.persistRestoredEnvToDB(stage);
  for (const bundle of recording.bundles) {
    if (bundle.kind !== 'journal_tail') continue;
    for (const frame of bundle.frames ?? []) await persistVerifiedFrame(deps, stage, frame);
  }
  await publishArchive(deps, stage, target, recording.targetHeight, options);
};

/** Fresh-device import. Existing local truth always wins, even over a valid archive. */
export const restoreRuntimeFromRecording = async (
  deps: RecoveryArchiveImportDeps, input: RuntimeRecording, runtimeSeed: string,
  options: RecoveryArchiveImportOptions = {},
): Promise<RuntimeReplica> => {
  const recording = validateRuntimeRecording(input);
  registerArchiveSigners(recording, runtimeSeed);
  const stage = await deps.restoreEnvFromRecoveryBundles(
    recording.bundles.filter(bundle => bundle.kind !== 'journal_tail'),
    { runtimeSeed, runtimeId: recording.runtimeId, readOnly: true },
  );
  stage.dbNamespace = `recovery-stage-${crypto.randomUUID()}`;
  const target = deps.createEmptyEnv(runtimeSeed);
  if (target.runtimeId !== recording.runtimeId) throw new Error('RECOVERY_IMPORT_TRUSTED_IDENTITY_MISMATCH');
  const results = await Promise.allSettled([buildAndPublishArchive(deps, recording, stage, target, options)]);
  results.push(...await Promise.allSettled([clearStage(deps, stage)]));
  results.push(...await Promise.allSettled([
    deps.closeRuntimeDb(stage), deps.closeInfraDb(stage), deps.closeRuntimeDb(target), deps.closeInfraDb(target),
  ]));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'RECOVERY_IMPORT_AND_CLEANUP_FAILED');
  // Sparse WAL needs its cumulative overlay rebuilt by the normal loader.
  // Resuming the detached tip directly would lose changes at materialization.
  const restored = await deps.loadEnvFromDB(recording.runtimeId, runtimeSeed);
  if (!restored || restored.state.height !== recording.targetHeight) throw new Error('RECOVERY_IMPORT_REOPEN_TIP_MISMATCH');
  // The disposable activity view is absent on a fresh device. Start it at the
  // imported WAL tip so the first live frame appends at H+1 without a gap.
  await resetRuntimeActivityViewAtFloor(restored, recording.targetHeight);
  return restored;
};
