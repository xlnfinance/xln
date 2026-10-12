/** Explicit offline TS Account import; the original signed checkpoint stays immutable. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Level } from 'level';
import { deriveSignerAddressSync, deriveSignerKeySync } from '../../../../../account/crypto';
import { requireAccountDeltaTransformerAddress } from '../../../../../account/consensus/helpers';
import { generateLazyEntityId } from '../../../../../entity/factory';
import { computeEntityAccountValueHash } from '../../../../../entity/consensus/state-root';
import { PersistentEntityAccountMap } from '../../../../../entity/state/persistent-account-map';
import { toRuntimeMachineRootHash } from '../../../../../protocol/hashes';
import { authoritySessionIdentityFor } from '../../../../../rscore/process/session-identity';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROCESS_PROFILE,
  RSCORE_PROTOCOL_FINGERPRINT,
  RscoreProcessClient,
  type RscoreCheckpointChanges,
  type RscoreExactCheckpoint,
} from '../../../../../rscore/client';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  shadowIneligibilityReason,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from '../../../../../rscore/shadow-wire';
import { decodeBuffer } from '../../../../../storage/codec/codec';
import { iterateKeys } from '../../../../../storage/database/level';
import {
  keyLiveAccountPrefix,
  keyLiveReplicaMeta,
  keyLiveReplicaMetaPrefix,
  parseLiveAccountKey,
} from '../../../../../storage/keys';
import type { ConcreteCheckpointSourceExport } from '../../../../../storage/read/concrete-checkpoint-source';
import { hydrateAccountDocFromStorage } from '../../../../../storage/read/hydration';
import { validateStorageReplicaMeta } from '../../../../../storage/replica/replica-meta-validation';
import { readAccountStorageLayout } from '../../../../../storage/schema/account-layout';
import { validateStorageFrameRecordValue } from '../../../../../storage/schema/authoritative-schema';
import {
  prepareRscoreCheckpointStorage,
  type PreparedRscoreCheckpointStorage,
} from '../../../../../storage/schema/rscore/checkpoint';
import type { RuntimeDbLike } from '../../../../../storage/types';
import { decodeRuntimeMachineGraphLeaves } from '../../../../../storage/wal/runtime-machine-graph';
import { validateJReplicas } from '../../../../../storage/wal/runtime-machine-schema/j';
import type { AccountReplica } from '../../../../../types/account';

type ImportOptions = Readonly<{
  binaryPath: string;
  runtimeSeed: string;
  entitySignerLabel: string;
}>;
type HexRow = ConcreteCheckpointSourceExport['stateRows'][number];
type ImportAuthority = Readonly<{ owner: string; signerId: string; privateKey: Uint8Array }>;
const bytes = (value: string): Buffer => Buffer.from(value.slice(2), 'hex');
const hex = (value: Uint8Array): `0x${string}` => `0x${Buffer.from(value).toString('hex')}`;

const accountRows = async (db: RuntimeDbLike, owner: string): Promise<Map<string, AccountReplica>> => {
  const accounts = new Map<string, AccountReplica>();
  for await (const key of iterateKeys(db, { prefix: keyLiveAccountPrefix(owner) })) {
    const parsed = parseLiveAccountKey(key);
    const row = await readAccountStorageLayout(db, owner, parsed.counterpartyId, key);
    if (!row) throw new Error(`HLT_OFFLINE_IMPORT_ACCOUNT_MISSING:${owner}:${parsed.counterpartyId}`);
    const account = hydrateAccountDocFromStorage(row.doc);
    const ineligible = shadowIneligibilityReason(account.state);
    if (ineligible !== null) throw new Error(`HLT_OFFLINE_IMPORT_ACCOUNT_UNSUPPORTED:${ineligible}`);
    accounts.set(parsed.counterpartyId, account);
  }
  return accounts;
};

const ownerSigner = async (db: RuntimeDbLike, owner: string): Promise<string> => {
  const rows: string[] = [];
  for await (const key of iterateKeys(db, { prefix: keyLiveReplicaMetaPrefix(owner) })) {
    const meta = validateStorageReplicaMeta(decodeBuffer(await db.get(key)), 'HLT_OFFLINE_IMPORT_REPLICA');
    if (meta.entityId !== owner || !key.equals(keyLiveReplicaMeta(owner, meta.signerId))) {
      throw new Error(`HLT_OFFLINE_IMPORT_REPLICA_OWNER:${owner}`);
    }
    rows.push(meta.signerId);
  }
  // The existing Account authority process binds one lazy 1-of-1 owner key.
  const [signerId] = rows;
  if (signerId === undefined || rows.length !== 1 || generateLazyEntityId(rows, 1n).toLowerCase() !== owner) {
    throw new Error(`HLT_OFFLINE_IMPORT_SIGNER_BINDING:${owner}:${rows.length}`);
  }
  return signerId;
};

const checkpointContext = (source: ConcreteCheckpointSourceExport) => {
  const frame = validateStorageFrameRecordValue(decodeBuffer(bytes(source.frameBytes)));
  const expected = frame.runtimeMachineRoot;
  const entityHashes = frame.canonicalEntityHashes;
  if (
    frame.height !== source.height ||
    !expected ||
    expected.rootHash !== source.rootHash ||
    expected.leafCount !== source.leafCount ||
    entityHashes === undefined ||
    entityHashes.length === 0
  ) {
    throw new Error('HLT_OFFLINE_IMPORT_CHECKPOINT_BINDING');
  }
  const machine = decodeRuntimeMachineGraphLeaves(
    source.runtimeMachineLeaves.map(([key, value]) => ({
      pathBytes: bytes(key),
      valueBytes: bytes(value),
    })),
    { rootHash: toRuntimeMachineRootHash(source.rootHash), leafCount: source.leafCount },
  );
  const jReplicas = new Map(validateJReplicas(machine['jReplicas'], 'HLT_OFFLINE_IMPORT_J'));
  const runtimeId = machine['runtimeId'];
  if (typeof runtimeId !== 'string') throw new Error('HLT_OFFLINE_IMPORT_RUNTIME_ID');
  return { runtimeId, jReplicas, owners: new Set(entityHashes.map(row => row.entityId)) };
};

const signerKeyring = (options: ImportOptions, jurisdictions: Iterable<string>) =>
  new Map(
    [options.entitySignerLabel, ...Array.from(jurisdictions, name => `${options.entitySignerLabel}:${name}`)].map(
      label => [
        deriveSignerAddressSync(options.runtimeSeed, label).toLowerCase(),
        deriveSignerKeySync(options.runtimeSeed, label),
      ],
    ),
  );

const sourceRows = (source: ConcreteCheckpointSourceExport, owners: ReadonlySet<string>) => {
  const original = new Map(source.stateRows.map(([key, value]) => [key, value]));
  if (original.size !== source.stateRows.length) throw new Error('HLT_OFFLINE_IMPORT_DUPLICATE_ROW');
  for (const [key] of source.stateRows) {
    if (!owners.has(`0x${key.slice(4, 68)}`)) throw new Error('HLT_OFFLINE_IMPORT_FOREIGN_OWNER');
    if (key.startsWith('0x18') || key.startsWith('0x19')) throw new Error('HLT_OFFLINE_IMPORT_ALREADY_NATIVE');
  }
  return original;
};

const assertImportHello = (hello: unknown, authority: ImportAuthority): void => {
  if (!Array.isArray(hello) || hello.length !== 6) throw new Error('HLT_OFFLINE_IMPORT_HELLO_ARITY');
  const [abi, profile, workers, market, signer, owner] = hello;
  if (abi !== RSCORE_PROCESS_ABI_VERSION || profile !== RSCORE_PROCESS_PROFILE || workers !== 1) {
    throw new Error('HLT_OFFLINE_IMPORT_HELLO_PROFILE');
  }
  if (
    !(market instanceof Uint8Array) ||
    market.byteLength !== 32 ||
    hex(market) !== swapMarketPolicyDigest(swapMarketPolicyWire())
  ) {
    throw new Error('HLT_OFFLINE_IMPORT_HELLO_MARKET');
  }
  if (
    !(signer instanceof Uint8Array) ||
    signer.byteLength !== 20 ||
    hex(signer) !== authority.signerId ||
    !(owner instanceof Uint8Array) ||
    owner.byteLength !== 32 ||
    hex(owner) !== authority.owner
  ) {
    throw new Error('HLT_OFFLINE_IMPORT_HELLO_AUTHORITY');
  }
};

const openImportClient = async (
  binaryPath: string,
  runtimeId: string,
  authority: ImportAuthority,
): Promise<RscoreProcessClient> => {
  const client = new RscoreProcessClient(binaryPath, authoritySessionIdentityFor(runtimeId, authority.owner));
  try {
    assertImportHello(await client.hello(1, swapMarketPolicyWire(), authority), authority);
    return client;
  } catch (error) {
    client.kill();
    throw error;
  }
};

const verifyImportedCheckpoint = async (
  binaryPath: string,
  runtimeId: string,
  authority: ImportAuthority,
  checkpoints: readonly RscoreExactCheckpoint[],
): Promise<void> => {
  const [exact] = checkpoints;
  if (!exact || checkpoints.length !== 1) throw new Error('HLT_OFFLINE_IMPORT_EXACT_COUNT');
  const verifier = await openImportClient(binaryPath, runtimeId, authority);
  try {
    await verifier.restoreExact(exact.restoreToken, exact.accounts);
  } finally {
    verifier.kill();
  }
};

const exportImportedForest = async (
  client: RscoreProcessClient,
  accounts: ReadonlyMap<string, AccountReplica>,
  owner: string,
  context: ReturnType<typeof checkpointContext>,
): Promise<RscoreCheckpointChanges> => {
  const seeds = Array.from(accounts, ([counterparty, account]) =>
    accountSeedWire(
      owner,
      counterparty,
      account.state,
      accountEnvelopeWire(account),
      accountConsensusWire(account),
      requireAccountDeltaTransformerAddress(context, account.state),
    ),
  );
  await client.bootstrapAccounts(0, seeds, true);
  const forest = PersistentEntityAccountMap.fromEntries(accounts, owner, computeEntityAccountValueHash);
  return client.exportCheckpoint(bytes(forest.rootHash()));
};

const importOwnerAccounts = async (
  db: RuntimeDbLike,
  owner: string,
  context: ReturnType<typeof checkpointContext>,
  keyring: ReturnType<typeof signerKeyring>,
  options: ImportOptions,
): Promise<PreparedRscoreCheckpointStorage> => {
  const signerId = await ownerSigner(db, owner);
  const privateKey = keyring.get(signerId);
  if (!privateKey) throw new Error(`HLT_OFFLINE_IMPORT_SIGNER_UNRESOLVED:${signerId}`);
  const accounts = await accountRows(db, owner);
  const authority = { owner, signerId, privateKey };
  const client = await openImportClient(options.binaryPath, context.runtimeId, authority);
  try {
    const checkpoint = await exportImportedForest(client, accounts, owner, context);
    const prepared = await prepareRscoreCheckpointStorage(db, [
      {
        ownerEntityId: owner,
        protocolFingerprint: hex(RSCORE_PROTOCOL_FINGERPRINT),
        checkpoint,
      },
    ]);
    await verifyImportedCheckpoint(options.binaryPath, context.runtimeId, authority, prepared.exactCheckpoints);
    return prepared;
  } finally {
    client.kill();
  }
};

/** Only the offline copy gains native rows; Rust restore binds them to the original Entity roots. */
export const importOfflineCheckpointAccounts = async (
  source: ConcreteCheckpointSourceExport,
  options: ImportOptions,
): Promise<ConcreteCheckpointSourceExport> => {
  const context = checkpointContext(source);
  const keyring = signerKeyring(options, context.jReplicas.keys());
  const original = sourceRows(source, context.owners);
  const directory = mkdtempSync(join(tmpdir(), 'xln-offline-account-import-'));
  const db = new Level<Buffer, Buffer>(directory, { keyEncoding: 'buffer', valueEncoding: 'buffer' });
  try {
    await db.open();
    const sourceBatch = db.batch();
    for (const [key, value] of source.stateRows) sourceBatch.put(bytes(key), bytes(value));
    await sourceBatch.write();
    for (const owner of context.owners) {
      const prepared = await importOwnerAccounts(db, owner, context, keyring, options);
      for (const key of prepared.dels) original.delete(hex(key));
      for (const { key, value } of prepared.puts) original.set(hex(key), hex(value));
    }
    const stateRows: HexRow[] = [...original].sort(([left], [right]) => left.localeCompare(right));
    return { ...source, stateRows };
  } finally {
    await db.close();
    rmSync(directory, { recursive: true, force: true });
  }
};
