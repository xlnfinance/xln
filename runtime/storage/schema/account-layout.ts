/**
 * Canonical Account graph layout. The Account header is a bounded manifest;
 * scalar fields and Patricia nodes are separate typed LevelDB records. No
 * Account blob is encoded first, and recovery relinks the stored graph.
 */
import { computeIntegrityDigest } from '../../infra/integrity-checksum';
import { decodeBuffer, encodeBuffer } from '../codec/codec';
import { readRawOrNull } from '../database/level';
import type { RuntimeDbLike, StorageAccountDoc } from '../types';
import type { AccountReplica, AccountState } from '../../types/account';
import { STORAGE_ACCOUNT_FIELD_TAG, type StorageAccountField } from './account-field-tags';
import {
  ACCOUNT_STATE_MAP_NAMESPACES,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';
import {
  accountTreeStorageKeys,
  hydrateAccountTrees,
  projectAccountTreeChanges,
  projectAccountTreeDescriptors,
  type StorageAccountTreeDescriptor,
} from './account-graph-codec';
import { validateStorageAccountDocValue } from './schema-state-docs';
import {
  projectAccountEnvelopeGraph,
  projectAccountEnvelopeGraphChanges,
  readAccountEnvelopeGraph,
  type StorageAccountEnvelopeDescriptor,
} from './account-envelope-graph';

export { STORAGE_ACCOUNT_FIELD_TAG } from './account-field-tags';

export const MAX_INLINE_STORAGE_VALUE_BYTES = 10_000;

type AccountGraphManifest = Readonly<{
  version: 1;
  envelope: StorageAccountEnvelopeDescriptor;
  trees: readonly StorageAccountTreeDescriptor[];
}>;

export type AccountStorageLayout = Readonly<{
  representation: 'graph';
  logicalValue: Buffer;
  logicalHash: string;
  rootValue: Buffer;
  puts: Array<Readonly<{ key: Buffer; value: Buffer }>>;
  dels: Buffer[];
}>;

const TREE_FIELDS = new Set<StorageAccountField>([
  'state.deltas', 'state.locks', 'state.swapOffers', 'state.pulls',
  'state.subcontracts', 'state.lendingIntents', 'state.requestedRebalance',
  'state.requestedRebalanceFeeState', 'state.rebalanceFeePolicies',
  'pendingWithdrawals',
]);

const isStateField = (field: StorageAccountField): field is `state.${keyof AccountState & string}` =>
  field.startsWith('state.');

const stateFieldName = (field: `state.${keyof AccountState & string}`): keyof AccountState =>
  field.slice('state.'.length) as keyof AccountState;

const hasAccountField = (doc: StorageAccountDoc, field: StorageAccountField): boolean =>
  isStateField(field)
    ? Object.hasOwn(doc.state, stateFieldName(field))
    : Object.hasOwn(doc, field);

const scalarShadow = (doc: StorageAccountDoc): unknown => {
  const { policy: _policy, submittedAtByToken: _submitted, ...rebalance } = doc.shadow.rebalance;
  return { ...doc.shadow, rebalance };
};

const accountFieldValue = (doc: StorageAccountDoc, field: StorageAccountField): unknown => {
  if (field === 'shadow') return scalarShadow(doc);
  return isStateField(field)
    ? doc.state[stateFieldName(field)]
    : doc[field as keyof AccountReplica];
};

const assertKnownFields = (doc: StorageAccountDoc): void => {
  for (const field of Object.getOwnPropertyNames(doc)) {
    if (field !== 'state' && !(field in STORAGE_ACCOUNT_FIELD_TAG)) {
      throw new Error(`STORAGE_ACCOUNT_FIELD_UNKNOWN:${field}`);
    }
  }
  for (const field of Object.getOwnPropertyNames(doc.state)) {
    if (!(`state.${field}` in STORAGE_ACCOUNT_FIELD_TAG)) {
      throw new Error(`STORAGE_ACCOUNT_STATE_FIELD_UNKNOWN:${field}`);
    }
  }
};

const accountEnvelopeValue = (doc: StorageAccountDoc): Record<string, unknown> => {
  assertKnownFields(doc);
  const state: Record<string, unknown> = {};
  const replica: Record<string, unknown> = {};
  for (const field of Object.keys(STORAGE_ACCOUNT_FIELD_TAG) as StorageAccountField[]) {
    if (TREE_FIELDS.has(field) || !hasAccountField(doc, field)) continue;
    const value = accountFieldValue(doc, field);
    if (isStateField(field)) state[stateFieldName(field)] = value;
    else replica[field] = value;
  }
  return { ...replica, state };
};

const manifestValue = (
  envelope: StorageAccountEnvelopeDescriptor,
  trees: readonly StorageAccountTreeDescriptor[],
): Buffer => {
  const value = encodeBuffer({
    version: 1,
    envelope,
    trees,
  } satisfies AccountGraphManifest);
  if (value.byteLength >= MAX_INLINE_STORAGE_VALUE_BYTES) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_TOO_LARGE:${value.byteLength}`);
  }
  return value;
};

/** Bounded Account root record used by storage hashing and physical writes. */
export const projectAccountStorageRootValue = (doc: StorageAccountDoc): Buffer =>
  manifestValue(
    projectAccountEnvelopeGraph(accountEnvelopeValue(doc)).descriptor,
    projectAccountTreeDescriptors(doc),
  );

const record = (value: unknown, code: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(code);
  return value as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, expected: readonly string[], code: string): void => {
  const actual = Object.keys(value).sort();
  const sorted = [...expected].sort();
  if (actual.length !== sorted.length || actual.some((key, index) => key !== sorted[index])) {
    throw new Error(`${code}_FIELDS:${actual.join(',')}`);
  }
};

const decodeHash = (value: unknown, code: string): string => {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{64}$/.test(value)) throw new Error(code);
  return value;
};

const decodeTreeDescriptor = (value: unknown, index: number): StorageAccountTreeDescriptor => {
  const tree = record(value, `STORAGE_ACCOUNT_MANIFEST_TREE_${index}`);
  exactKeys(tree, ['namespace', 'rootHash', 'leafCount'], `STORAGE_ACCOUNT_MANIFEST_TREE_${index}`);
  const namespace = tree['namespace'];
  if (typeof namespace !== 'string' || !ACCOUNT_STATE_MAP_NAMESPACES.includes(namespace as AccountStateMapNamespace)) {
    throw new Error(`STORAGE_ACCOUNT_MANIFEST_TREE_NAMESPACE:${String(namespace)}`);
  }
  const leafCount = tree['leafCount'];
  if (!Number.isSafeInteger(leafCount) || Number(leafCount) < 0) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_TREE_COUNT');
  }
  return {
    namespace: namespace as AccountStateMapNamespace,
    rootHash: decodeHash(tree['rootHash'], 'STORAGE_ACCOUNT_MANIFEST_TREE_ROOT'),
    leafCount: Number(leafCount),
  };
};

/** Strict boundary decoder shared by recovery and snapshot graph verification. */
export const decodeAccountGraphManifest = (value: Buffer): AccountGraphManifest => {
  const manifest = record(decodeBuffer(value), 'STORAGE_ACCOUNT_MANIFEST_INVALID');
  exactKeys(manifest, ['version', 'envelope', 'trees'], 'STORAGE_ACCOUNT_MANIFEST');
  if (manifest['version'] !== 1 || !Array.isArray(manifest['trees'])) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_VERSION');
  }
  const envelope = record(manifest['envelope'], 'STORAGE_ACCOUNT_MANIFEST_ENVELOPE');
  exactKeys(envelope, ['rootHash', 'leafCount'], 'STORAGE_ACCOUNT_MANIFEST_ENVELOPE');
  const leafCount = envelope['leafCount'];
  if (!Number.isSafeInteger(leafCount) || Number(leafCount) < 0) {
    throw new Error('STORAGE_ACCOUNT_MANIFEST_ENVELOPE_COUNT');
  }
  const trees = manifest['trees'].map((raw, index) => decodeTreeDescriptor(raw, index));
  if (new Set(trees.map(tree => tree.namespace)).size !== trees.length) throw new Error('STORAGE_ACCOUNT_MANIFEST_TREE_DUPLICATE');
  return {
    version: 1,
    envelope: {
      rootHash: decodeHash(envelope['rootHash'], 'STORAGE_ACCOUNT_MANIFEST_ENVELOPE_ROOT'),
      leafCount: Number(leafCount),
    },
    trees,
  };
};

export const prepareAccountStorageLayout = async (
  _db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
  doc: StorageAccountDoc,
  previous?: StorageAccountDoc,
): Promise<AccountStorageLayout> => {
  const trees = projectAccountTreeDescriptors(doc);
  const envelope = projectAccountEnvelopeGraphChanges(
    entityId,
    counterpartyId,
    accountEnvelopeValue(doc),
    previous ? accountEnvelopeValue(previous) : undefined,
  );
  const rootValue = manifestValue(envelope.descriptor, trees);
  const graph = projectAccountTreeChanges(entityId, counterpartyId, doc, previous);
  return {
    representation: 'graph',
    logicalValue: rootValue,
    logicalHash: computeIntegrityDigest(rootValue),
    rootValue,
    puts: [
      { key: rootKey, value: rootValue },
      ...envelope.puts,
      ...graph.puts,
    ],
    dels: [
      ...envelope.dels,
      ...graph.dels,
    ],
  };
};

export const prepareAccountStorageDelete = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<Buffer[]> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return [];
  decodeAccountGraphManifest(root);
  return [
    rootKey,
    ...await accountTreeStorageKeys(db, entityId, counterpartyId),
  ];
};

const installTree = (
  state: Record<string, unknown>,
  replica: Record<string, unknown>,
  namespace: AccountStateMapNamespace,
  tree: unknown,
): void => {
  if (namespace === 'pendingWithdrawals') {
    replica['pendingWithdrawals'] = tree;
    return;
  }
  if (namespace === 'rebalanceShadowPolicy' || namespace === 'rebalanceShadowSubmitted') {
    const shadow = record(replica['shadow'], 'STORAGE_ACCOUNT_SHADOW_INVALID');
    const rebalance = record(shadow['rebalance'], 'STORAGE_ACCOUNT_SHADOW_REBALANCE_INVALID');
    replica['shadow'] = {
      ...shadow,
      rebalance: {
        ...rebalance,
        [namespace === 'rebalanceShadowPolicy' ? 'policy' : 'submittedAtByToken']: tree,
      },
    };
    return;
  }
  state[namespace] = tree;
};

export const readAccountStorageLayout = async (
  db: RuntimeDbLike,
  entityId: string,
  counterpartyId: string,
  rootKey: Buffer,
): Promise<{ doc: StorageAccountDoc; logicalValue: Buffer; representation: 'graph' } | null> => {
  const root = await readRawOrNull(db, rootKey);
  if (!root) return null;
  const manifest = decodeAccountGraphManifest(root);
  const replica = record(
    await readAccountEnvelopeGraph(db, entityId, counterpartyId, manifest.envelope),
    'STORAGE_ACCOUNT_ENVELOPE_INVALID',
  );
  const state = record(replica['state'], 'STORAGE_ACCOUNT_ENVELOPE_STATE_INVALID');
  const trees = await hydrateAccountTrees(db, entityId, counterpartyId, manifest.trees);
  for (const [namespace, tree] of trees) installTree(state, replica, namespace, tree);
  const doc = validateStorageAccountDocValue({ ...replica, state });
  return { doc, logicalValue: root, representation: 'graph' };
};
