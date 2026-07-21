import { ethers } from 'ethers';

import type {
  AccountMachine,
  ConsensusConfig,
  EntityFrameAuthority,
  EntityLeaderState,
  EntityState,
} from '../../types';
import { compareStableText } from '../../protocol/serialization';
import {
  cloneAccountInputWithoutPostCommitHankos,
  cloneAccountTxWithoutPostCommitHankos,
} from './hanko-witness';
import { computeBookCommitmentHash } from '../../orderbook/commitment';
import { createStructuredLogger } from '../../infra/logger';
import { isRuntimePerfProfileEnabled } from '../../infra/perf-runtime-flags';
import { getPerfMs } from '../../utils';
import { computeIntegrityDigest } from '../../infra/integrity-checksum';

const entityRootLog = createStructuredLogger('entity.state-root');

export const ENTITY_CONSENSUS_STATE_FIELDS = [
  'entityId',
  'height',
  'timestamp',
  'nonces',
  'entityCommandNonces',
  'messages',
  'proposals',
  'config',
  'prevFrameHash',
  'leaderState',
  'reserves',
  'accounts',
  'externalWallet',
  'deferredAccountProposals',
  'lastFinalizedJHeight',
  'jBlockChain',
  'jHistoryFinality',
  'certifiedBoardState',
  'accountInputQueue',
  'crontabState',
  'jBatchState',
  'entityProviderActionState',
  'batchHistory',
  'entityEncPubKey',
  'entityEncPrivKey',
  'profileEncryptionManifest',
  'profile',
  'htlcRoutes',
  'htlcFeesEarned',
  'htlcNotes',
  'consumptionAccumulator',
  'certifiedOutputSequences',
  'outDebtsByToken',
  'inDebtsByToken',
  'orderbookExt',
  'lockBook',
  'swapTradingPairs',
  'pendingSwapFillRatios',
  'crossJurisdictionSwaps',
  'pendingCrossJurisdictionFillAcks',
  'crossJurisdictionBookAdmissions',
  'hubRebalanceConfig',
  'lending',
] as const satisfies readonly (keyof EntityState)[];

type AssertNoMissingEntityStateField<T extends never> = T;
export type EntityConsensusStateFieldCoverage = AssertNoMissingEntityStateField<
  Exclude<keyof EntityState, typeof ENTITY_CONSENSUS_STATE_FIELDS[number]>
>;

export const ENTITY_STATE_ROOT_EXCLUDED_FIELDS = [
  'prevFrameHash',
  'jBlockChain',
  'entityEncPubKey',
  'entityEncPrivKey',
  'htlcNotes',
] as const satisfies readonly (keyof EntityState)[];

type CanonicalEntry = readonly [CanonicalValue, CanonicalValue];
type CanonicalProperty = readonly [string, CanonicalValue];
type CanonicalValue =
  | readonly ['Null']
  | readonly ['Undefined']
  | readonly ['Boolean', boolean]
  | readonly ['Number', string]
  | readonly ['String', string]
  | readonly ['BigInt', string]
  | readonly ['Date', string]
  | readonly ['Buffer', string]
  | readonly ['TypedArray', string, string]
  | readonly ['Array', readonly CanonicalValue[]]
  | readonly ['Map', readonly CanonicalEntry[]]
  | readonly ['Set', readonly CanonicalValue[]]
  | readonly ['Object' | 'NullObject', readonly CanonicalProperty[]];

const canonicalText = (value: CanonicalValue): string => JSON.stringify(value);

const compareCanonicalValues = (left: CanonicalValue, right: CanonicalValue): number =>
  compareStableText(canonicalText(left), canonicalText(right));

const canonicalBytes = (value: ArrayBufferView): string => {
  const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return ethers.hexlify(bytes);
};

const assertNoOwnExtensions = (
  value: object,
  allowedStringKeys: ReadonlySet<string> = new Set(),
): void => {
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    if (!allowedStringKeys.has(key)) throw new Error(`ENTITY_STATE_ROOT_EXTRA_PROPERTY:${key}`);
  }
};

type CanonicalStack = Map<object, string>;

const objectChildPath = (path: string, key: string): string =>
  /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;

const canonicalMap = (value: Map<unknown, unknown>, stack: CanonicalStack, path: string): CanonicalValue => {
  assertNoOwnExtensions(value);
  const entries = Array.from(value.entries()).map(([key, entry], index) => [
    canonicalizeEntityConsensusValue(key, stack, `${path}.<map-key:${index}>`),
    canonicalizeEntityConsensusValue(entry, stack, `${path}.<map-value:${index}>`),
  ] as const satisfies CanonicalEntry);
  entries.sort((left, right) => {
    const byKey = compareCanonicalValues(left[0]!, right[0]!);
    return byKey !== 0 ? byKey : compareCanonicalValues(left[1]!, right[1]!);
  });
  return ['Map', entries];
};

const canonicalSet = (value: Set<unknown>, stack: CanonicalStack, path: string): CanonicalValue => {
  assertNoOwnExtensions(value);
  return ['Set', Array.from(value.values())
    .map((entry, index) => canonicalizeEntityConsensusValue(entry, stack, `${path}.<set:${index}>`))
    .sort(compareCanonicalValues)];
};

const canonicalArray = (value: unknown[], stack: CanonicalStack, path: string): CanonicalValue => {
  const allowedKeys = new Set<string>(['length']);
  const items: CanonicalValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new Error(`ENTITY_STATE_ROOT_SPARSE_ARRAY:index=${index}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`ENTITY_STATE_ROOT_ARRAY_DESCRIPTOR_INVALID:index=${index}`);
    }
    items.push(canonicalizeEntityConsensusValue(descriptor.value, stack, `${path}[${index}]`));
  }
  assertNoOwnExtensions(value, allowedKeys);
  return ['Array', items];
};

const canonicalObject = (value: object, stack: CanonicalStack, path: string): CanonicalValue => {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_OBJECT:${Object.prototype.toString.call(value)}`);
  }
  const properties: CanonicalProperty[] = [];
  const keys = Reflect.ownKeys(value);
  if (keys.some(key => typeof key === 'symbol')) throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
  for (const key of (keys as string[]).sort(compareStableText)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new Error(`ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID:key=${key}`);
    }
    properties.push([
      key,
      canonicalizeEntityConsensusValue(descriptor.value, stack, objectChildPath(path, key)),
    ]);
  }
  return [prototype === null ? 'NullObject' : 'Object', properties];
};

export const canonicalizeEntityConsensusValue = (
  value: unknown,
  stack: CanonicalStack = new Map(),
  path = '$',
): CanonicalValue => {
  if (value === null) return ['Null'];
  if (value === undefined) return ['Undefined'];
  if (typeof value === 'string') return ['String', value];
  if (typeof value === 'boolean') return ['Boolean', value];
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ENTITY_STATE_ROOT_NON_FINITE_NUMBER:${String(value)}`);
    return ['Number', Object.is(value, -0) ? '-0' : String(value)];
  }
  if (typeof value === 'bigint') return ['BigInt', value.toString()];
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_VALUE:${typeof value}`);
  }
  if (value instanceof Date) {
    assertNoOwnExtensions(value);
    return ['Date', value.toISOString()];
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    assertNoOwnExtensions(value, new Set(Array.from({ length: value.length }, (_, index) => String(index))));
    return ['Buffer', canonicalBytes(value)];
  }
  if (ArrayBuffer.isView(value)) {
    const byteView = value as ArrayBufferView & { length?: number };
    const allowed = new Set(Array.from({ length: byteView.length ?? 0 }, (_, index) => String(index)));
    assertNoOwnExtensions(value, allowed);
    return ['TypedArray', value.constructor.name, canonicalBytes(value)];
  }

  const object = value as object;
  const ancestorPath = stack.get(object);
  if (ancestorPath) throw new Error(`ENTITY_STATE_ROOT_CYCLE:path=${path}:ancestor=${ancestorPath}`);
  stack.set(object, path);
  try {
    if (value instanceof Map) return canonicalMap(value, stack, path);
    if (value instanceof Set) return canonicalSet(value, stack, path);
    if (Array.isArray(value)) return canonicalArray(value, stack, path);
    return canonicalObject(object, stack, path);
  } finally {
    stack.delete(object);
  }
};

const quotedCanonicalText = (value: string): string => JSON.stringify(value);

/**
 * Emits exactly the same tagged JSON bytes as canonicalText(canonicalize(...))
 * without first allocating a second full object graph. Large hub Entities keep
 * many Account records, so the former tree-then-stringify path doubled the hot
 * frame walk and its allocation pressure.
 */
const encodeCanonicalEntityConsensusValueDirect = (
  value: unknown,
  stack: CanonicalStack = new Map(),
  path = '$',
): string => {
  if (value === null) return '["Null"]';
  if (value === undefined) return '["Undefined"]';
  if (typeof value === 'string') return `["String",${quotedCanonicalText(value)}]`;
  if (typeof value === 'boolean') return `["Boolean",${value ? 'true' : 'false'}]`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`ENTITY_STATE_ROOT_NON_FINITE_NUMBER:${String(value)}`);
    return `["Number",${quotedCanonicalText(Object.is(value, -0) ? '-0' : String(value))}]`;
  }
  if (typeof value === 'bigint') return `["BigInt",${quotedCanonicalText(value.toString())}]`;
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_VALUE:${typeof value}`);
  }
  if (value instanceof Date) {
    assertNoOwnExtensions(value);
    return `["Date",${quotedCanonicalText(value.toISOString())}]`;
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    assertNoOwnExtensions(value, new Set(Array.from({ length: value.length }, (_, index) => String(index))));
    return `["Buffer",${quotedCanonicalText(canonicalBytes(value))}]`;
  }
  if (ArrayBuffer.isView(value)) {
    const byteView = value as ArrayBufferView & { length?: number };
    const allowed = new Set(Array.from({ length: byteView.length ?? 0 }, (_, index) => String(index)));
    assertNoOwnExtensions(value, allowed);
    return `["TypedArray",${quotedCanonicalText(value.constructor.name)},${quotedCanonicalText(canonicalBytes(value))}]`;
  }

  const object = value as object;
  const ancestorPath = stack.get(object);
  if (ancestorPath) throw new Error(`ENTITY_STATE_ROOT_CYCLE:path=${path}:ancestor=${ancestorPath}`);
  stack.set(object, path);
  try {
    if (value instanceof Map) {
      assertNoOwnExtensions(value);
      const entries = Array.from(value.entries()).map(([key, entry], index) => ({
        key: encodeCanonicalEntityConsensusValueDirect(key, stack, `${path}.<map-key:${index}>`),
        value: encodeCanonicalEntityConsensusValueDirect(entry, stack, `${path}.<map-value:${index}>`),
      }));
      entries.sort((left, right) => {
        const byKey = compareStableText(left.key, right.key);
        return byKey !== 0 ? byKey : compareStableText(left.value, right.value);
      });
      return `["Map",[${entries.map(entry => `[${entry.key},${entry.value}]`).join(',')}]]`;
    }
    if (value instanceof Set) {
      assertNoOwnExtensions(value);
      const entries = Array.from(value.values())
        .map((entry, index) => encodeCanonicalEntityConsensusValueDirect(entry, stack, `${path}.<set:${index}>`))
        .sort(compareStableText);
      return `["Set",[${entries.join(',')}]]`;
    }
    if (Array.isArray(value)) {
      const allowedKeys = new Set<string>(['length']);
      const entries: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        if (!Object.prototype.hasOwnProperty.call(value, key)) {
          throw new Error(`ENTITY_STATE_ROOT_SPARSE_ARRAY:index=${index}`);
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor?.enumerable || !('value' in descriptor)) {
          throw new Error(`ENTITY_STATE_ROOT_ARRAY_DESCRIPTOR_INVALID:index=${index}`);
        }
        entries.push(encodeCanonicalEntityConsensusValueDirect(descriptor.value, stack, `${path}[${index}]`));
      }
      assertNoOwnExtensions(value, allowedKeys);
      return `["Array",[${entries.join(',')}]]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`ENTITY_STATE_ROOT_UNSUPPORTED_OBJECT:${Object.prototype.toString.call(value)}`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key === 'symbol')) throw new Error('ENTITY_STATE_ROOT_SYMBOL_KEY');
    const properties = (keys as string[]).sort(compareStableText).map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !('value' in descriptor)) {
        throw new Error(`ENTITY_STATE_ROOT_OBJECT_DESCRIPTOR_INVALID:key=${key}`);
      }
      const encoded = encodeCanonicalEntityConsensusValueDirect(
        descriptor.value,
        stack,
        objectChildPath(path, key),
      );
      return `[${quotedCanonicalText(key)},${encoded}]`;
    });
    return `[${prototype === null ? '"NullObject"' : '"Object"'},[${properties.join(',')}]]`;
  } finally {
    stack.delete(object);
  }
};

type AccountWithReplicaCaches = AccountMachine & {
  frameHistory?: unknown;
  provider?: unknown;
  ethersProvider?: unknown;
};

const projectSettlementWorkspace = (
  workspace: AccountMachine['settlementWorkspace'],
): unknown => {
  if (!workspace) return undefined;
  const {
    leftHanko: _leftHanko,
    rightHanko: _rightHanko,
    postSettlementDisputeProof,
    ...unsignedWorkspace
  } = workspace;
  if (!postSettlementDisputeProof) return unsignedWorkspace;
  const {
    leftHanko: _postLeftHanko,
    rightHanko: _postRightHanko,
    ...unsignedPostSettlement
  } = postSettlementDisputeProof;
  return { ...unsignedWorkspace, postSettlementDisputeProof: unsignedPostSettlement };
};

const projectPendingWithdrawals = (
  withdrawals: AccountMachine['pendingWithdrawals'],
): Map<string, unknown> => new Map(Array.from(withdrawals.entries()).map(([requestId, withdrawal]) => {
  const { signature: _signature, ...unsignedWithdrawal } = withdrawal;
  return [requestId, unsignedWithdrawal];
}));

const projectOrderbookConsensusState = (
  orderbookExt: EntityState['orderbookExt'],
): Record<string, unknown> | undefined => {
  if (!orderbookExt) return undefined;
  return {
    // The expanded bucket tree stays consensus-bound through its incremental
    // per-book commitment. Unchanged order/level/bucket hashes survive the
    // working-state clone, so one fill rehashes only its dirty ancestry.
    books: new Map(Array.from(orderbookExt.books.entries()).map(([pairId, book]) => [
      pairId,
      computeBookCommitmentHash(book),
    ])),
    // orderPairs is a deterministic cancel index rebuilt from books.
    hubProfile: orderbookExt.hubProfile,
    referrals: orderbookExt.referrals,
  };
};

/**
 * These bilateral fields are already committed by AccountFrame.accountStateRoot.
 * Re-embedding them into the parent Entity root made every hub frame serialize
 * the complete resting-liquidity map twice. The Entity commitment retains the
 * current/pending Account frames (and therefore their roots) plus every local
 * lifecycle field below. A field may be added here only when it is covered by
 * accountStateRootEntries in account/state-root.ts.
 */
const ACCOUNT_ROOT_COMMITTED_FIELDS = [
  'domain',
  'leftEntity',
  'rightEntity',
  'watchSeed',
  'deltas',
  'globalCreditLimits',
  'jNonce',
  'disputeConfig',
  'locks',
  'pulls',
  'swapOffers',
  'subcontracts',
  'lendingIntents',
  'settlementWorkspace',
  'lastFinalizedJHeight',
  'leftPendingJClaims',
  'rightPendingJClaims',
  'requestedRebalance',
  'requestedRebalanceFeeState',
  'rebalanceFeePolicies',
] as const satisfies readonly (keyof AccountMachine)[];

const projectAccountConsensusState = (account: AccountMachine): Record<string, unknown> => {
  const projected = { ...account } as AccountWithReplicaCaches as unknown as Record<string, unknown>;
  delete projected['clonedForValidation'];
  delete projected['frameHistory'];
  delete projected['provider'];
  delete projected['ethersProvider'];
  // Transport routing is validator-local: local keys and observed profiles can
  // differ while the certified output payload remains identical.
  delete projected['pendingAccountInputSignerId'];
  // Entity quorum Hankos and counterparty proofs authenticate already-bound
  // hashes. They are attached after the Entity frame hash exists, so including
  // them here would be circular. Retain the unsigned frames, hashes and nonces.
  delete projected['hankoSignature'];
  delete projected['currentFrameHanko'];
  delete projected['counterpartyFrameHanko'];
  delete projected['currentDisputeProofHanko'];
  delete projected['counterpartyDisputeProofHanko'];
  delete projected['counterpartySettlementHanko'];
  projected['mempool'] = account.mempool.map(cloneAccountTxWithoutPostCommitHankos);
  if (account.settlementWorkspace) {
    projected['settlementWorkspace'] = projectSettlementWorkspace(account.settlementWorkspace);
  } else {
    delete projected['settlementWorkspace'];
  }
  projected['pendingWithdrawals'] = projectPendingWithdrawals(account.pendingWithdrawals);
  if (account.pendingAccountInput) {
    projected['pendingAccountInput'] = cloneAccountInputWithoutPostCommitHankos(account.pendingAccountInput);
  } else {
    delete projected['pendingAccountInput'];
  }
  if (account.lastOutboundFrameAck) {
    projected['lastOutboundFrameAck'] = {
      ...account.lastOutboundFrameAck,
      response: cloneAccountInputWithoutPostCommitHankos(account.lastOutboundFrameAck.response),
    };
  } else {
    delete projected['lastOutboundFrameAck'];
  }
  for (const field of ACCOUNT_ROOT_COMMITTED_FIELDS) delete projected[field];
  return projected as Record<string, unknown>;
};

const normalizeAuthoritySignerId = (value: string): string => value.trim().toLowerCase();

const normalizeAuthorityConfig = (config: ConsensusConfig): ConsensusConfig => {
  const shares: Record<string, bigint> = {};
  for (const [rawSignerId, share] of Object.entries(config.shares)) {
    const signerId = normalizeAuthoritySignerId(rawSignerId);
    if (!signerId || Object.prototype.hasOwnProperty.call(shares, signerId)) {
      throw new Error(`ENTITY_FRAME_AUTHORITY_DUPLICATE_SIGNER:${rawSignerId}`);
    }
    shares[signerId] = share;
  }
  return {
    ...structuredClone(config),
    validators: config.validators.map(normalizeAuthoritySignerId),
    shares,
  };
};

const CONSENSUS_CONFIG_KEYS = new Set(['mode', 'threshold', 'validators', 'shares', 'jurisdiction']);
const JURISDICTION_CONFIG_KEYS = new Set([
  'address',
  'name',
  'chainId',
  'depositoryAddress',
  'entityProviderAddress',
  'registrationBlock',
  'entityProviderDeploymentBlock',
  'blockTimeMs',
  'rebalancePolicyUsd',
]);
const REBALANCE_POLICY_KEYS = new Set(['r2cRequestSoftLimit', 'hardLimit', 'maxFee']);

const requireConsensusAddress = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`ENTITY_STATE_ROOT_JURISDICTION_FIELD_REQUIRED:${field}`);
  }
  return value.trim().toLowerCase();
};

/**
 * Consensus binds the jurisdiction stack, never a validator's RPC locator or
 * display label. Two honest validators commonly reach the same chain through
 * different URLs; committing either URL would make identical replay fork.
 */
export const projectConsensusConfigCommitment = (config: ConsensusConfig): Record<string, unknown> => {
  assertNoOwnExtensions(config, CONSENSUS_CONFIG_KEYS);
  const normalized = normalizeAuthorityConfig(config);
  const jurisdiction = normalized.jurisdiction;
  if (jurisdiction) {
    assertNoOwnExtensions(jurisdiction, JURISDICTION_CONFIG_KEYS);
    if (jurisdiction.rebalancePolicyUsd) {
      assertNoOwnExtensions(jurisdiction.rebalancePolicyUsd, REBALANCE_POLICY_KEYS);
    }
  }
  return {
    mode: normalized.mode,
    threshold: normalized.threshold,
    validators: normalized.validators,
    shares: normalized.shares,
    ...(jurisdiction ? {
      jurisdiction: {
        ...(jurisdiction.chainId !== undefined ? { chainId: jurisdiction.chainId } : {}),
        depositoryAddress: requireConsensusAddress(jurisdiction.depositoryAddress, 'depositoryAddress'),
        entityProviderAddress: requireConsensusAddress(jurisdiction.entityProviderAddress, 'entityProviderAddress'),
        ...(jurisdiction.registrationBlock !== undefined
          ? { registrationBlock: jurisdiction.registrationBlock }
          : {}),
        ...(jurisdiction.entityProviderDeploymentBlock !== undefined
          ? { entityProviderDeploymentBlock: jurisdiction.entityProviderDeploymentBlock }
          : {}),
        ...(jurisdiction.blockTimeMs !== undefined ? { blockTimeMs: jurisdiction.blockTimeMs } : {}),
        ...(jurisdiction.rebalancePolicyUsd ? {
          rebalancePolicyUsd: structuredClone(jurisdiction.rebalancePolicyUsd),
        } : {}),
      },
    } : {}),
  };
};

export const projectEntityConsensusState = (
  state: EntityState,
  expandAccounts = true,
): Record<string, unknown> => {
  const projected = { ...state } as Partial<EntityState>;
  // The previous-frame link is committed by the outer Entity frame payload.
  // The committed state then stores this frame's hash here, so including it in
  // its own state root would be circular.
  delete projected.prevFrameHash;
  // Finalized J effects and the exact current anchor/root are authoritative.
  // These bounded event bodies are only a local display/audit cache and may be
  // absent after restore without changing the Entity consensus state.
  delete projected.jBlockChain;
  delete projected.entityEncPubKey;
  delete projected.entityEncPrivKey;
  delete projected.htlcNotes;
  const orderbookExt = projectOrderbookConsensusState(state.orderbookExt);
  return {
    ...projected,
    config: projectConsensusConfigCommitment(state.config),
    accounts: expandAccounts
      ? new Map(Array.from(state.accounts.entries()).map(([counterpartyId, account]) => [
          counterpartyId,
          projectAccountConsensusState(account),
        ]))
      : state.accounts,
    ...(orderbookExt ? { orderbookExt } : {}),
  };
};

export const encodeCanonicalEntityConsensusValue = (value: unknown): string =>
  encodeCanonicalEntityConsensusValueDirect(value);

export const encodeCanonicalEntityConsensusState = (state: EntityState): string =>
  encodeCanonicalEntityConsensusValue({
    domain: 'xln.entity.consensus-state',
    state: projectEntityConsensusState(state),
  });

const UTF8 = new TextEncoder();

type EntitySectionCommitment = {
  field: string;
  digest: string;
  encodedBytes: number;
};

type EntityAccountCommitmentEntry = {
  account: AccountMachine;
  encodedKey: string;
  encodedValue: string;
};

type EntityAccountCommitmentCache = Map<string, EntityAccountCommitmentEntry>;

const ENTITY_ACCOUNT_COMMITMENT_CACHE = Symbol('xln.entity.account-commitment-cache');
type EntityStateWithCommitmentCache = EntityState & {
  [ENTITY_ACCOUNT_COMMITMENT_CACHE]?: EntityAccountCommitmentCache;
};

const readEntityAccountCommitmentCache = (
  state: EntityState,
): EntityAccountCommitmentCache | undefined =>
  (state as EntityStateWithCommitmentCache)[ENTITY_ACCOUNT_COMMITMENT_CACHE];

const writeEntityAccountCommitmentCache = (
  state: EntityState,
  cache: EntityAccountCommitmentCache,
): void => {
  Object.defineProperty(state, ENTITY_ACCOUNT_COMMITMENT_CACHE, {
    value: cache,
    configurable: true,
    writable: true,
    enumerable: false,
  });
};

export const invalidateEntityAccountCommitment = (
  state: EntityState,
  counterpartyId: string,
): void => {
  readEntityAccountCommitmentCache(state)?.delete(counterpartyId.toLowerCase());
};

export const forkEntityAccountCommitmentCache = (
  source: EntityState,
  target: EntityState,
): void => {
  const sourceCache = readEntityAccountCommitmentCache(source);
  if (!sourceCache) return;
  const targetCache: EntityAccountCommitmentCache = new Map();
  for (const [counterpartyId, entry] of sourceCache) {
    const account = target.accounts.get(counterpartyId);
    if (!account) continue;
    targetCache.set(counterpartyId, { ...entry, account });
  }
  writeEntityAccountCommitmentCache(target, targetCache);
};

const encodeEntityAccountsSection = (
  state: EntityState,
  cold: boolean,
): string => {
  const cache = cold
    ? new Map<string, EntityAccountCommitmentEntry>()
    : (readEntityAccountCommitmentCache(state) ?? new Map<string, EntityAccountCommitmentEntry>());
  const entries = Array.from(state.accounts.entries()).map(([rawCounterpartyId, account]) => {
    const counterpartyId = rawCounterpartyId.toLowerCase();
    const existing = cache.get(counterpartyId);
    if (existing?.account === account) {
      return { key: existing.encodedKey, value: existing.encodedValue };
    }
    const encodedKey = encodeCanonicalEntityConsensusValueDirect(rawCounterpartyId);
    const encodedValue = encodeCanonicalEntityConsensusValueDirect(projectAccountConsensusState(account));
    cache.set(counterpartyId, { account, encodedKey, encodedValue });
    return { key: encodedKey, value: encodedValue };
  });
  entries.sort((left, right) => {
    const byKey = compareStableText(left.key, right.key);
    return byKey !== 0 ? byKey : compareStableText(left.value, right.value);
  });
  if (!cold) writeEntityAccountCommitmentCache(state, cache);
  return `["Map",[${entries.map(entry => `[${entry.key},${entry.value}]`).join(',')}]]`;
};

/**
 * Entity state is intentionally a hierarchy, not one giant serialized blob.
 * Each complete top-level section is SHA-256 committed, then the small ordered
 * section map is bound by the signed Keccak Entity root. SHA-256 is only the
 * internal tree primitive; Hanko continues to sign the outer 32-byte Keccak.
 *
 * Counterexample: replacing a large cross-j route with only its orderId would
 * be fast but would silently unbind amounts/timeouts. This function hashes the
 * entire canonical value, so every nested consensus byte remains authoritative.
 */
const commitEntityConsensusSections = (
  projected: Record<string, unknown>,
  state?: EntityState,
  cold = false,
): EntitySectionCommitment[] => Object.entries(projected)
  .sort(([left], [right]) => compareStableText(left, right))
  .map(([field, value]) => {
    const encoded = field === 'accounts' && state
      ? encodeEntityAccountsSection(state, cold)
      : encodeCanonicalEntityConsensusValueDirect(value);
    return {
      field,
      digest: computeIntegrityDigest(UTF8.encode(encoded)),
      encodedBytes: encoded.length,
    };
  });

const computeEntityRootFromSections = (sections: readonly EntitySectionCommitment[]): string =>
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValueDirect({
    domain: 'xln.entity.consensus-state.sections',
    sections: sections.map(({ field, digest }) => ({ field, digest })),
  })));

export const computeCanonicalEntityConsensusStateHash = (state: EntityState): string => {
  const profile = isRuntimePerfProfileEnabled('XLN_ENTITY_STATE_ROOT_PROFILE', 'XLN_RUNTIME_PROCESS_PROFILE');
  const startedAt = getPerfMs();
  const projected = projectEntityConsensusState(state, false);
  const projectedAt = getPerfMs();
  const sections = commitEntityConsensusSections(projected, state);
  const sectionsAt = getPerfMs();
  const root = computeEntityRootFromSections(sections);
  const endedAt = getPerfMs();
  if (isRuntimePerfProfileEnabled('XLN_ENTITY_STATE_ROOT_AUDIT')) {
    const cold = computeCanonicalEntityConsensusStateHashCold(state);
    if (root !== cold) throw new Error(`ENTITY_STATE_ROOT_CACHE_MISMATCH:incremental=${root}:cold=${cold}`);
  }
  if (!profile) return root;
  const profileProjected = projectEntityConsensusState(state);
  const topLevelBytes = Object.entries(profileProjected)
    .map(([field, value]) => ({
      field,
      bytes: encodeCanonicalEntityConsensusValueDirect(value).length,
    }))
    .sort((left, right) => right.bytes - left.bytes)
    .slice(0, 8);
  const accountBytes = Array.from((profileProjected['accounts'] as Map<string, unknown>).entries())
    .map(([counterpartyId, value]) => ({
      counterparty: counterpartyId.slice(-8),
      bytes: encodeCanonicalEntityConsensusValueDirect(value).length,
      value,
    }))
    .sort((left, right) => right.bytes - left.bytes);
  const largestAccount = accountBytes[0];
  const largestAccountFields = largestAccount && typeof largestAccount.value === 'object' && largestAccount.value !== null
    ? Object.entries(largestAccount.value as Record<string, unknown>)
      .map(([field, value]) => ({
        field,
        bytes: encodeCanonicalEntityConsensusValueDirect(value).length,
      }))
      .sort((left, right) => right.bytes - left.bytes)
      .slice(0, 10)
    : [];
  entityRootLog.warn('profile', {
    entity: state.entityId.slice(-8),
    height: state.height,
    accounts: state.accounts.size,
    encodedBytes: sections.reduce((total, section) => total + section.encodedBytes, 0),
    rootInputBytes: sections.length * 32,
    topLevelBytes,
    ...(largestAccount ? {
      largestAccount: {
        counterparty: largestAccount.counterparty,
        bytes: largestAccount.bytes,
        fields: largestAccountFields,
      },
    } : {}),
    totalMs: Number((endedAt - startedAt).toFixed(3)),
    phases: {
      projection: Number((projectedAt - startedAt).toFixed(3)),
      sectionCommitments: Number((sectionsAt - projectedAt).toFixed(3)),
      rootKeccak: Number((endedAt - sectionsAt).toFixed(3)),
    },
  });
  return root;
};

/** Cold test/restore oracle: never trusts an in-memory Account leaf cache. */
export const computeCanonicalEntityConsensusStateHashCold = (state: EntityState): string =>
  computeEntityRootFromSections(commitEntityConsensusSections(projectEntityConsensusState(state, false), state, true));

export const assertEntityStateRootCache = (state: EntityState): string => {
  const incremental = computeCanonicalEntityConsensusStateHash(state);
  const cold = computeCanonicalEntityConsensusStateHashCold(state);
  if (incremental !== cold) {
    throw new Error(`ENTITY_STATE_ROOT_CACHE_MISMATCH:incremental=${incremental}:cold=${cold}`);
  }
  return incremental;
};

const normalizeAuthorityLeader = (
  config: ConsensusConfig,
  leaderState: EntityState['leaderState'],
): EntityLeaderState => {
  const activeValidatorId = normalizeAuthoritySignerId(
    leaderState?.activeValidatorId ?? config.validators[0] ?? '',
  );
  if (!activeValidatorId) throw new Error('ENTITY_FRAME_AUTHORITY_LEADER_MISSING');
  return {
    activeValidatorId,
    view: leaderState?.view ?? 0,
    changedAtHeight: leaderState?.changedAtHeight ?? 0,
  };
};

export const buildEntityFrameAuthority = (state: EntityState): EntityFrameAuthority => {
  const config = normalizeAuthorityConfig(state.config);
  return {
    config,
    leaderState: normalizeAuthorityLeader(config, state.leaderState),
  };
};

export const computeEntityFrameAuthorityRoot = (authority: EntityFrameAuthority): string =>
  ethers.keccak256(ethers.toUtf8Bytes(encodeCanonicalEntityConsensusValue({
    domain: 'xln.entity.frame-authority',
    authority: {
      config: projectConsensusConfigCommitment(authority.config),
      leaderState: normalizeAuthorityLeader(authority.config, authority.leaderState),
    },
  })));
