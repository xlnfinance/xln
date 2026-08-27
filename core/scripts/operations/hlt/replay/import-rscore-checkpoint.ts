/**
 * Explicit one-time offline import of a canonical TypeScript Account forest.
 *
 * This is fixture/migration tooling, never an alternative Runtime recovery path. The
 * copied State DB is still frozen at the materialized TS base; an isolated
 * rscore process converts that exact in-memory Account forest into the
 * canonical 0x17/0x18/0x19 checkpoint rows before native replay starts.
 */

import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { Level } from 'level';

import { requireAccountDeltaTransformerAddress } from '../../../../account/consensus/helpers';
import { computeEntityAccountValueHash } from '../../../../entity/consensus/state-root';
import type { EntityReplica } from '../../../../entity/types';
import type { ManagedEntityIdentity } from '../../../../orchestrator/daemon-control';
import { buffersEqual } from '../../../../protocol/serialization';
import { PersistentRadixValueMap } from '../../../../protocol/state/persistent-radix-value-map';
import {
  authoritySessionIdentityFor,
} from '../../../../rscore/authority-driver';
import { decodeRscoreAccountRestoreRow } from '../../../../rscore/checkpoint/checkpoint-restore';
import { assertRscoreCheckpointCandidate } from '../../../../rscore/checkpoint/checkpoint-wire';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROCESS_PROFILE,
  RSCORE_PROTOCOL_FINGERPRINT,
  RscoreProcessClient,
  type RscoreWireValue,
} from '../../../../rscore/client';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  shadowIneligibilityReason,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from '../../../../rscore/shadow-wire';
import { loadRscoreCheckpoint, prepareRscoreCheckpointStorage } from '../../../../storage/schema/rscore/checkpoint';
import { buildStorageReplicaMetaCommitment } from '../../../../storage/replica/replicas';
import { iterateKeys } from '../../../../storage/database/level';
import { keyLiveReplicaMeta, keyLiveReplicaMetaPrefix } from '../../../../storage/keys';
import type { RuntimeDbLike } from '../../../../storage/types';
import type { RuntimeReplica } from '../../../../runtime/types';

const protocolFingerprint = `0x${RSCORE_PROTOCOL_FINGERPRINT.toString('hex')}`;

export type OfflineRscoreImportEvidence = Readonly<{
  ownerEntityId: string;
  accountsRoot: string;
  signerDigest: string;
  accountCount: number;
  physicalPuts: number;
  physicalDels: number;
}>;

const exactHello = (
  raw: unknown,
  workers: number,
  market: readonly RscoreWireValue[],
  identity: ManagedEntityIdentity,
): void => {
  if (!Array.isArray(raw) || raw.length !== 6) throw new Error('NATIVE_FIXTURE_RSCORE_HELLO_ARITY');
  const [abi, profile, actualWorkers, marketDigest, signer, entity] = raw;
  if (abi !== RSCORE_PROCESS_ABI_VERSION || profile !== RSCORE_PROCESS_PROFILE || actualWorkers !== workers) {
    throw new Error(`NATIVE_FIXTURE_RSCORE_HELLO_IDENTITY:${String(abi)}:${String(profile)}:${String(actualWorkers)}`);
  }
  const expectedMarketDigest = swapMarketPolicyDigest(market);
  const actualMarketDigest = marketDigest instanceof Uint8Array
    ? `0x${Buffer.from(marketDigest).toString('hex')}`
    : '<invalid>';
  const actualSigner = signer instanceof Uint8Array
    ? `0x${Buffer.from(signer).toString('hex')}`
    : '<invalid>';
  const actualEntity = entity instanceof Uint8Array
    ? `0x${Buffer.from(entity).toString('hex')}`
    : '<invalid>';
  if (
    actualMarketDigest !== expectedMarketDigest ||
    actualSigner !== identity.signerId ||
    actualEntity !== identity.entityId
  ) {
    throw new Error(
      `NATIVE_FIXTURE_RSCORE_HELLO_BINDING:${actualMarketDigest}:${actualSigner}:${actualEntity}`,
    );
  }
};

const sortedSeeds = (
  env: RuntimeReplica,
  entity: EntityReplica,
): RscoreWireValue[][] => [...entity.state.accounts]
  .sort(([left], [right]) => left.localeCompare(right))
  .map(([counterpartyId, account]) => {
    const ineligible = shadowIneligibilityReason(account.state);
    if (ineligible !== null) {
      throw new Error(`NATIVE_FIXTURE_RSCORE_IMPORT_INELIGIBLE:${counterpartyId}:${ineligible}`);
    }
    return accountSeedWire(
      entity.entityId,
      counterpartyId,
      account.state,
      accountEnvelopeWire(account),
      accountConsensusWire(account),
      requireAccountDeltaTransformerAddress(env.state, account.state),
    );
  });

const exactBootstrapRoot = (raw: unknown, expectedRoot: string): string => {
  if (!Array.isArray(raw) || raw.length !== 2 || raw[0] !== 0 || !(raw[1] instanceof Uint8Array)) {
    throw new Error('NATIVE_FIXTURE_RSCORE_BOOTSTRAP_RESPONSE');
  }
  const root = `0x${Buffer.from(raw[1]).toString('hex')}`;
  if (root !== expectedRoot) {
    throw new Error(`NATIVE_FIXTURE_RSCORE_BOOTSTRAP_ROOT:${root}:${expectedRoot}`);
  }
  return root;
};

const signerDigest = (
  rows: readonly ReturnType<typeof decodeRscoreAccountRestoreRow>[],
): Buffer => {
  const digest = createHash('sha256').update('xln.rscore.signer-config.v1');
  for (const row of [...rows].sort((left, right) => left.accountId.localeCompare(right.accountId))) {
    const signer = row.stateSeed.signerId;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(signer));
    digest
      .update(Buffer.from(row.accountId.slice(2), 'hex'))
      .update(Buffer.from(row.stateSeed.ownerEntityId.slice(2), 'hex'))
      .update(length)
      .update(signer);
  }
  return digest.digest();
};

const forestRoot = (
  rows: readonly ReturnType<typeof decodeRscoreAccountRestoreRow>[],
): string => PersistentRadixValueMap.fromMap(
  rows.map(row => [row.accountId, row.entityAccountLeaf] as const),
  {
    radix: 16,
    ownKey: accountId => accountId.toLowerCase(),
    keyBytes: accountId => Buffer.from(accountId.slice(2), 'hex'),
    valueHash: leaf => leaf,
    ownValue: leaf => leaf,
  },
).rootHash();

const applyCheckpoint = async (
  db: RuntimeDbLike,
  plan: Awaited<ReturnType<typeof prepareRscoreCheckpointStorage>>,
  replicaMetaEntries: readonly Readonly<{ key: Buffer; value: Buffer }>[],
): Promise<void> => {
  const batch = db.batch();
  for (const key of plan.dels) batch.del(key);
  for (const put of plan.puts) batch.put(put.key, put.value);
  for (const entry of replicaMetaEntries) batch.put(entry.key, entry.value);
  await batch.write({ sync: true });
};

const exactReplicaMetaEntries = async (
  db: RuntimeDbLike,
  env: RuntimeReplica,
  entity: EntityReplica,
  expectedDigest: string,
): Promise<Readonly<{ entries: Array<{ key: Buffer; value: Buffer }>; digest: string }>> => {
  for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix() })) {
    throw new Error(`NATIVE_FIXTURE_RSCORE_REPLICA_META_ALREADY_PRESENT:0x${key.toString('hex')}`);
  }
  const commitment = buildStorageReplicaMetaCommitment(env);
  const expectedKey = keyLiveReplicaMeta(entity.entityId, entity.signerId);
  if (
    commitment.digest !== expectedDigest ||
    commitment.entries.length !== 1 ||
    !buffersEqual(commitment.entries[0]!.key, expectedKey)
  ) {
    throw new Error(
      `NATIVE_FIXTURE_RSCORE_REPLICA_META_COMMITMENT:` +
      `${commitment.digest}:${expectedDigest}:${commitment.entries.length}`,
    );
  }
  return commitment;
};

const assertLoadedCheckpoint = async (
  db: RuntimeDbLike,
  entity: EntityReplica,
  expectedRoot: string,
): Promise<Readonly<{ signerDigest: string; accountCount: number }>> => {
  const loaded = await loadRscoreCheckpoint(db, entity.entityId);
  if (!loaded) throw new Error('NATIVE_FIXTURE_RSCORE_CHECKPOINT_MISSING_AFTER_IMPORT');
  if (loaded.protocolFingerprint !== protocolFingerprint) {
    throw new Error('NATIVE_FIXTURE_RSCORE_CHECKPOINT_FINGERPRINT');
  }
  const decoded = loaded.accounts.map(decodeRscoreAccountRestoreRow);
  const expectedAccounts = [...entity.state.accounts]
    .sort(([left], [right]) => left.localeCompare(right));
  if (decoded.length !== expectedAccounts.length || loaded.restoreToken[4] !== expectedAccounts.length) {
    throw new Error('NATIVE_FIXTURE_RSCORE_CHECKPOINT_ACCOUNT_COUNT');
  }
  for (const [index, [accountId, account]] of expectedAccounts.entries()) {
    const row = decoded[index];
    if (
      row?.accountId !== accountId ||
      row.stateSeed.ownerEntityId !== entity.entityId ||
      row.stateSeed.signerId !== entity.signerId ||
      row.entityAccountLeaf !== computeEntityAccountValueHash(account)
    ) {
      throw new Error(`NATIVE_FIXTURE_RSCORE_CHECKPOINT_ACCOUNT_BINDING:${accountId}`);
    }
  }
  const computedRoot = forestRoot(decoded);
  const tokenRoot = `0x${Buffer.from(loaded.restoreToken[2]).toString('hex')}`;
  const computedSignerDigest = signerDigest(decoded);
  if (
    computedRoot !== expectedRoot ||
    tokenRoot !== expectedRoot ||
    !buffersEqual(computedSignerDigest, Buffer.from(loaded.restoreToken[3]))
  ) {
    throw new Error(`NATIVE_FIXTURE_RSCORE_CHECKPOINT_COMMITMENT:${computedRoot}:${tokenRoot}`);
  }
  return {
    signerDigest: `0x${computedSignerDigest.toString('hex')}`,
    accountCount: decoded.length,
  };
};

export const importRscoreCheckpointIntoFrozenState = async (options: Readonly<{
  mode: 'offline-pre-authority-import';
  env: RuntimeReplica;
  entity: EntityReplica;
  identity: ManagedEntityIdentity;
  stateDbPath: string;
  timestamp: number;
  expectedReplicaMetaDigest: string;
  binaryPath?: string;
}>): Promise<OfflineRscoreImportEvidence> => {
  if (options.mode !== 'offline-pre-authority-import') {
    throw new Error('NATIVE_FIXTURE_RSCORE_OFFLINE_IMPORT_MODE');
  }
  const binaryPath = options.binaryPath ?? process.env['XLN_RSCORE_BINARY'] ?? resolve(
    import.meta.dir,
    '../../../../../rscore/target/release/xln-rscore',
  );
  if (!existsSync(binaryPath)) throw new Error(`NATIVE_FIXTURE_RSCORE_BINARY_MISSING:${binaryPath}`);
  const client = new RscoreProcessClient(
    binaryPath,
    authoritySessionIdentityFor(options.env.runtimeId!, options.entity.entityId),
  );
  const db = new Level<Buffer, Buffer>(options.stateDbPath, {
    valueEncoding: 'buffer',
    keyEncoding: 'binary',
  });
  try {
    await db.open();
    if (await loadRscoreCheckpoint(db, options.entity.entityId)) {
      throw new Error('NATIVE_FIXTURE_RSCORE_OFFLINE_IMPORT_ALREADY_PRESENT');
    }
    const replicaMeta = await exactReplicaMetaEntries(
      db,
      options.env,
      options.entity,
      options.expectedReplicaMetaDigest,
    );
    const workers = 1;
    const market = swapMarketPolicyWire();
    exactHello(await client.hello(workers, market, {
      privateKey: hexToWireBytes(options.identity.privateKeyHex, 32, 'NATIVE_FIXTURE_PRIVATE_KEY'),
      signerId: options.identity.signerId,
    }), workers, market, options.identity);
    const expectedRoot = options.entity.state.accounts.rootHash();
    const seeds = sortedSeeds(options.env, options.entity);
    const root = exactBootstrapRoot(await client.bootstrapAccounts(0, seeds, true), expectedRoot);

    // AccountOutbound is deliberately a second-half visit and therefore
    // requires the matching empty inbound visit. Neither visit changes the
    // imported forest; together they exercise the real production boundary.
    const inbound = await client.accountInbound({
      ownerEntityId: hexToWireBytes(options.entity.entityId, 32, 'NATIVE_FIXTURE_OWNER'),
      expectedAccountsRoot: hexToWireBytes(root, 32, 'NATIVE_FIXTURE_ACCOUNTS_ROOT'),
      entityTimestamp: options.timestamp,
      finalizedJHeight: options.entity.state.lastFinalizedJHeight,
      rows: [],
      postAccounts: false,
    });
    if (inbound.accountsRoot !== expectedRoot) {
      throw new Error(`NATIVE_FIXTURE_RSCORE_EMPTY_INBOUND_ROOT:${inbound.accountsRoot}:${expectedRoot}`);
    }
    const outbound = await client.accountOutbound({
      ownerEntityId: hexToWireBytes(options.entity.entityId, 32, 'NATIVE_FIXTURE_OWNER'),
      timestamp: options.timestamp,
      jHeight: options.entity.state.lastFinalizedJHeight,
      creates: [],
      admits: [],
      propose: [],
      materialize: [],
      failedHtlcRoutes: [],
      postAccounts: false,
      checkpointDue: true,
    });
    if (!outbound.checkpoint) throw new Error('NATIVE_FIXTURE_RSCORE_CHECKPOINT_NOT_EMITTED');
    if (outbound.checkpoint.accounts.length !== seeds.length) {
      throw new Error(
        `NATIVE_FIXTURE_RSCORE_IMPORT_CHECKPOINT_INCOMPLETE:` +
        `${outbound.checkpoint.accounts.length}:${seeds.length}`,
      );
    }
    assertRscoreCheckpointCandidate(outbound.checkpoint, {
      revision: outbound.revision,
      accountsRoot: expectedRoot,
      accountCount: seeds.length,
    });
    const plan = await prepareRscoreCheckpointStorage(db, [{
      ownerEntityId: options.entity.entityId,
      protocolFingerprint,
      checkpoint: outbound.checkpoint,
    }]);
    await applyCheckpoint(db, plan, replicaMeta.entries);
    const verified = await assertLoadedCheckpoint(db, options.entity, expectedRoot);
    const storedReplicaMeta = await db.get(replicaMeta.entries[0]!.key);
    if (!buffersEqual(storedReplicaMeta, replicaMeta.entries[0]!.value)) {
      throw new Error('NATIVE_FIXTURE_RSCORE_REPLICA_META_STORAGE_MISMATCH');
    }
    return {
      ownerEntityId: options.entity.entityId,
      accountsRoot: expectedRoot,
      signerDigest: verified.signerDigest,
      accountCount: verified.accountCount,
      physicalPuts: plan.puts.length + replicaMeta.entries.length,
      physicalDels: plan.dels.length,
    };
  } finally {
    await client.shutdown().catch(() => client.kill());
    await db.close().catch(() => undefined);
  }
};
