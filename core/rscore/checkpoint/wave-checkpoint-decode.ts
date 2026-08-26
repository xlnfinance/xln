/** Strict transport decoder for the full checkpoint rows returned by a wave. */
import type { RscoreWireValue } from '../process-wire-value';
import {
  decodeRscoreCheckpointSectionEntry,
  decodeRscoreCheckpointSectionKey,
  type RscoreAccountStateTrees,
  type RscoreCheckpointSectionName,
} from './checkpoint-restore-state';
import {
  buildRscoreAccountRestore,
  type RscoreDecodedAccountRestore,
} from './checkpoint-restore';
import {
  decodeRscoreConsensusSeed,
  type RscoreConsensusSeed,
} from './checkpoint-restore-consensus';
import type { AccountReplica } from '../../types/account';
import { RSCORE_CUTOVER_VERIFY } from '../cutover/verify';
import {
  rscoreCheckpointBytes,
  rscoreCheckpointList,
  rscoreCheckpointTuple,
} from './checkpoint-wire';
import {
  PersistentAccountStateMap,
  type AccountStateMapKey,
  type AccountStateMapNamespace,
} from '../../account/state/persistent-state-map';
import { buffersEqual } from '../../protocol/serialization';

type RscoreCheckpointTreeDescriptor = Readonly<{ root: string; leafCount: number }>;

type RscoreCheckpointNodePut =
  | Readonly<{
      kind: 'branch';
      path: Uint8Array;
      children: readonly Readonly<{
        slot: number;
        kind: 'branch' | 'leaf';
        path: Uint8Array;
        edgeHash: string;
      }>[];
    }>
  | Readonly<{
      kind: 'leaf';
      path: Uint8Array;
      key: Uint8Array;
      value: RscoreWireValue;
    }>;

type RscoreCheckpointNodeDelete =
  | Readonly<{ kind: 'branch'; path: Uint8Array }>
  | Readonly<{ kind: 'leaf'; path: Uint8Array; key: Uint8Array }>;

type RscoreCheckpointNodeChanges = Readonly<{
  puts: readonly RscoreCheckpointNodePut[];
  dels: readonly RscoreCheckpointNodeDelete[];
}>;

export type RscoreAccountCheckpointRow = Readonly<{
  /** Exact validated process row; storage persists these bytes without re-encoding. */
  wire: readonly RscoreWireValue[];
  accountId: string;
  entityAccountLeaf: string;
  header: readonly RscoreWireValue[];
  sections: Readonly<{
    deltas: RscoreCheckpointTreeDescriptor;
    locks: RscoreCheckpointTreeDescriptor;
    lendingIntents: RscoreCheckpointTreeDescriptor;
    swapOffers: RscoreCheckpointTreeDescriptor;
    rebalanceFeePolicies: RscoreCheckpointTreeDescriptor;
  }>;
  nodeChanges: Readonly<{
    deltas: RscoreCheckpointNodeChanges;
    locks: RscoreCheckpointNodeChanges;
    lendingIntents: RscoreCheckpointNodeChanges;
    swapOffers: RscoreCheckpointNodeChanges;
    rebalanceFeePolicies: RscoreCheckpointNodeChanges;
  }>;
  /**
   * The consensus half of the row: mempool, pending frame, acknowledgement
   * and dispute drafts. It does not depend on the state trees, so it decodes
   * without the Account the changes diff against.
   */
  consensus: RscoreConsensusSeed;
}>;

/**
 * One wave row bound to the Account it changes.
 *
 * The changes alone say nothing: they are a diff against the Account the
 * Entity already holds, so the decoded seed only exists once that Account is
 * named. Everything the row claims — both roots and the Entity leaf — is
 * recomputed from the result.
 */
export type RscoreResolvedAccountRow = RscoreAccountCheckpointRow & Readonly<{
  decoded: RscoreDecodedAccountRestore;
}>;

const fail = (code: string): never => {
  throw new Error(`RSCORE_WAVE_DECODE:${code}`);
};

const uint = (value: unknown, code: string): number => {
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return fail(`${code}:integer`);
    return Number(value);
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return fail(`${code}:integer`);
  }
  return value;
};

const text = (value: unknown, code: string): string =>
  typeof value === 'string' ? value : fail(`${code}:text`);

const variableBytes = (value: unknown, code: string): Uint8Array =>
  value instanceof Uint8Array ? value : fail(`${code}:bytes`);

const path = (value: unknown, code: string): Uint8Array => {
  const parsed = variableBytes(value, code);
  for (const slot of parsed) if (slot > 15) return fail(`${code}:slot:${slot}`);
  return parsed;
};

const descriptor = (value: unknown, code: string): RscoreCheckpointTreeDescriptor => {
  const row = rscoreCheckpointTuple(value, 2, code);
  return {
    root: `0x${Buffer.from(rscoreCheckpointBytes(row[0], 32, `${code}_ROOT`)).toString('hex')}`,
    leafCount: uint(row[1], `${code}.leafCount`),
  };
};

const put = (value: unknown, code: string): RscoreCheckpointNodePut => {
  const row = rscoreCheckpointList(value, code);
  const tag = uint(row[0], `${code}.tag`);
  if (tag === 0) {
    const branch = rscoreCheckpointTuple(row, 3, `${code}_BRANCH`);
    const children = rscoreCheckpointList(branch[2], `${code}_CHILDREN`).map((entry, index) => {
      const child = rscoreCheckpointTuple(entry, 4, `${code}_CHILD_${index}`);
      const slot = uint(child[0], `${code}.child.${index}.slot`);
      if (slot > 15) return fail(`${code}.child.${index}.slot:${slot}`);
      const childKind = uint(child[1], `${code}.child.${index}.kind`);
      if (childKind !== 0 && childKind !== 1) return fail(`${code}.child.${index}.kind:${childKind}`);
      return {
        slot,
        kind: childKind === 0 ? 'branch' as const : 'leaf' as const,
        path: path(child[2], `${code}.child.${index}.path`),
        edgeHash: `0x${Buffer.from(
          rscoreCheckpointBytes(child[3], 32, `${code}_CHILD_${index}_EDGE_HASH`),
        ).toString('hex')}`,
      };
    });
    for (let index = 1; index < children.length; index += 1) {
      const previous = children[index - 1];
      const current = children[index];
      if (previous === undefined || current === undefined) {
        return fail(`${code}.children:bounds:${index}`);
      }
      if (previous.slot >= current.slot) return fail(`${code}.children:order`);
    }
    return { kind: 'branch', path: path(branch[1], `${code}.path`), children };
  }
  if (tag === 1) {
    const leaf = rscoreCheckpointTuple(row, 4, `${code}_LEAF`);
    const key = variableBytes(leaf[2], `${code}.key`);
    if (key.byteLength === 0) return fail(`${code}.key:empty`);
    return { kind: 'leaf', path: path(leaf[1], `${code}.path`), key, value: leaf[3] as RscoreWireValue };
  }
  return fail(`${code}.tag:${tag}`);
};

const del = (value: unknown, code: string): RscoreCheckpointNodeDelete => {
  const row = rscoreCheckpointList(value, code);
  const tag = uint(row[0], `${code}.tag`);
  if (tag === 0) {
    const branch = rscoreCheckpointTuple(row, 2, `${code}_BRANCH`);
    return { kind: 'branch', path: path(branch[1], `${code}.path`) };
  }
  if (tag === 1) {
    const leaf = rscoreCheckpointTuple(row, 3, `${code}_LEAF`);
    const key = variableBytes(leaf[2], `${code}.key`);
    if (key.byteLength === 0) return fail(`${code}.key:empty`);
    return { kind: 'leaf', path: path(leaf[1], `${code}.path`), key };
  }
  return fail(`${code}.tag:${tag}`);
};

const changes = (value: unknown, code: string): RscoreCheckpointNodeChanges => {
  const row = rscoreCheckpointTuple(value, 2, code);
  const puts = rscoreCheckpointList(row[0], `${code}_PUTS`)
    .map((entry, index) => put(entry, `${code}.put.${index}`));
  const dels = rscoreCheckpointList(row[1], `${code}_DELS`)
    .map((entry, index) => del(entry, `${code}.del.${index}`));
  return { puts, dels };
};

/**
 * Apply one section's leaf changes to the tree the Entity already holds.
 *
 * Branch records are the engine's own radix bookkeeping and are ignored here:
 * this side re-derives every branch from the leaves it ends up with, and then
 * checks the root and the leaf count against what the engine committed. A
 * diff against the wrong prior Account cannot survive that check.
 */
const applySectionChanges = (
  section: RscoreCheckpointSectionName,
  prior: PersistentAccountStateMap<AccountStateMapKey, unknown> | undefined,
  descriptorValue: RscoreCheckpointTreeDescriptor,
  nodeChanges: RscoreCheckpointNodeChanges,
): PersistentAccountStateMap<AccountStateMapKey, unknown> => {
  let tree = prior
    ?? PersistentAccountStateMap.empty<AccountStateMapKey, unknown>(section as AccountStateMapNamespace);
  let leafIndex = 0;
  for (const record of nodeChanges.puts) {
    if (record.kind === 'branch') continue;
    const [key, value] = decodeRscoreCheckpointSectionEntry(section, record.key, record.value, leafIndex);
    if (decodeRscoreCheckpointSectionKey(section, record.key, leafIndex) !== key) {
      return fail(`postAccount.${section}.put.${leafIndex}:key`);
    }
    leafIndex += 1;
    tree = tree.updated(key, value);
  }
  for (const [index, record] of nodeChanges.dels.entries()) {
    if (record.kind === 'branch') continue;
    tree = tree.removed(decodeRscoreCheckpointSectionKey(section, record.key, index));
  }
  if (!RSCORE_CUTOVER_VERIFY) return tree;
  if (tree.size !== descriptorValue.leafCount) {
    return fail(`postAccount.${section}.tree:leafCount:${tree.size}:${descriptorValue.leafCount}`);
  }
  const root = tree.rootHash();
  if (root !== descriptorValue.root) {
    return fail(`postAccount.${section}.tree:root:${root}:${descriptorValue.root}`);
  }
  return tree;
};

/** Bind one wave row to the Account it diffs against and decode the result. */
export const resolveRscoreWaveAccount = (
  row: RscoreAccountCheckpointRow,
  prior: AccountReplica | null,
): RscoreResolvedAccountRow => {
  const treeFor = <Section extends RscoreCheckpointSectionName>(
    section: Section,
  ): RscoreAccountStateTrees[Section] =>
    applySectionChanges(
      section,
      prior?.state[section] as PersistentAccountStateMap<AccountStateMapKey, unknown> | undefined,
      row.sections[section],
      row.nodeChanges[section],
    ) as RscoreAccountStateTrees[Section];
  const trees: RscoreAccountStateTrees = {
    deltas: treeFor('deltas'),
    locks: treeFor('locks'),
    lendingIntents: treeFor('lendingIntents'),
    swapOffers: treeFor('swapOffers'),
    rebalanceFeePolicies: treeFor('rebalanceFeePolicies'),
  };
  return {
    ...row,
    decoded: buildRscoreAccountRestore(
      row.accountId,
      row.entityAccountLeaf,
      row.header,
      trees,
      row.consensus,
      RSCORE_CUTOVER_VERIFY,
    ),
  };
};

const header = (
  value: unknown,
  accountId: Uint8Array,
): readonly RscoreWireValue[] => {
  const row = rscoreCheckpointTuple(value, 9, 'WAVE_POST_ACCOUNT_HEADER');
  const owner = rscoreCheckpointBytes(row[0], 32, 'WAVE_POST_ACCOUNT_OWNER');
  if (text(row[1], 'postAccount.header.signerId').length === 0) {
    return fail('postAccount.header.signerId:empty');
  }
  const identity = rscoreCheckpointTuple(row[2], 5, 'WAVE_POST_ACCOUNT_IDENTITY');
  if (uint(identity[0], 'postAccount.header.chainId') === 0) {
    return fail('postAccount.header.chainId:zero');
  }
  rscoreCheckpointBytes(identity[1], 20, 'WAVE_POST_ACCOUNT_DEPOSITORY');
  const left = rscoreCheckpointBytes(identity[2], 32, 'WAVE_POST_ACCOUNT_LEFT');
  const right = rscoreCheckpointBytes(identity[3], 32, 'WAVE_POST_ACCOUNT_RIGHT');
  const leftHex = Buffer.from(left).toString('hex');
  const rightHex = Buffer.from(right).toString('hex');
  if (leftHex >= rightHex) return fail('postAccount.header.parties:order');
  const counterparty = buffersEqual(Buffer.from(owner), Buffer.from(left))
    ? right
    : buffersEqual(Buffer.from(owner), Buffer.from(right)) ? left : undefined;
  if (counterparty === undefined) return fail('postAccount.header.owner:notParty');
  if (!buffersEqual(Buffer.from(accountId), Buffer.from(counterparty))) {
    return fail('postAccount.header.accountId:notCounterparty');
  }
  rscoreCheckpointBytes(identity[4], 32, 'WAVE_POST_ACCOUNT_WATCH_SEED');
  const dispute = rscoreCheckpointTuple(row[3], 2, 'WAVE_POST_ACCOUNT_DISPUTE');
  uint(dispute[0], 'postAccount.header.leftResponseSeconds');
  uint(dispute[1], 'postAccount.header.rightResponseSeconds');
  uint(row[4], 'postAccount.header.jNonce');
  uint(row[5], 'postAccount.header.lastFinalizedJHeight');
  const carried = rscoreCheckpointTuple(row[6], 6, 'WAVE_POST_ACCOUNT_CARRIED');
  for (let index = 0; index < 4; index += 1) {
    rscoreCheckpointBytes(carried[index], 32, `WAVE_POST_ACCOUNT_CARRIED_ROOT_${index}`);
  }
  for (let index = 4; index < 6; index += 1) {
    const accumulator = rscoreCheckpointTuple(carried[index], 2, `WAVE_POST_ACCOUNT_ACCUMULATOR_${index}`);
    rscoreCheckpointBytes(accumulator[0], 32, `WAVE_POST_ACCOUNT_ACCUMULATOR_ROOT_${index}`);
    uint(accumulator[1], `postAccount.header.accumulator.${index}.count`);
  }
  // Null on the round wire: the engine hands the envelope back only to a
  // reader that holds no Account of its own.
  if (row[7] !== null) rscoreCheckpointTuple(row[7], 2, 'WAVE_POST_ACCOUNT_ENVELOPE');
  if (row[8] !== null) rscoreCheckpointBytes(row[8], 20, 'WAVE_POST_ACCOUNT_DELTA_TRANSFORMER');
  return row;
};

export const decodeRscoreWavePostAccount = (value: unknown): RscoreAccountCheckpointRow => {
  const row = rscoreCheckpointTuple(value, 10, 'WAVE_POST_ACCOUNT');
  const accountId = rscoreCheckpointBytes(row[0], 32, 'WAVE_POST_ACCOUNT_ID');
  const parsedHeader = header(row[2], accountId);
  const rawSections = rscoreCheckpointTuple(row[3], 5, 'WAVE_POST_ACCOUNT_SECTIONS');
  const sections = {
    deltas: descriptor(rawSections[0], 'WAVE_POST_ACCOUNT_DELTAS'),
    locks: descriptor(rawSections[1], 'WAVE_POST_ACCOUNT_LOCKS'),
    lendingIntents: descriptor(rawSections[2], 'WAVE_POST_ACCOUNT_LENDING'),
    swapOffers: descriptor(rawSections[3], 'WAVE_POST_ACCOUNT_SWAPS'),
    rebalanceFeePolicies: descriptor(rawSections[4], 'WAVE_POST_ACCOUNT_POLICIES'),
  };
  const nodeChanges = {
    deltas: changes(row[4], 'postAccount.deltas'),
    locks: changes(row[5], 'postAccount.locks'),
    lendingIntents: changes(row[6], 'postAccount.lendingIntents'),
    swapOffers: changes(row[7], 'postAccount.swapOffers'),
    rebalanceFeePolicies: changes(row[8], 'postAccount.rebalanceFeePolicies'),
  };
  return {
    wire: row,
    accountId: `0x${Buffer.from(accountId).toString('hex')}`,
    entityAccountLeaf: `0x${Buffer.from(
      rscoreCheckpointBytes(row[1], 32, 'WAVE_POST_ACCOUNT_LEAF'),
    ).toString('hex')}`,
    header: parsedHeader,
    sections,
    nodeChanges,
    consensus: decodeRscoreConsensusSeed(row[9], RSCORE_CUTOVER_VERIFY),
  };
};
