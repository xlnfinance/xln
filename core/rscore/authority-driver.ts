/**
 * The Rust engine as the authority for one Entity's accounts, inside a real
 * Runtime frame.
 *
 * This is the canonical Account transition owner. Entity hands the complete
 * Runtime-frame work to one resident EntityRound; TypeScript does not execute
 * Account transitions on this path. The engine keeps the candidate private
 * until the Runtime WAL is durable, and every checked disagreement halts
 * rather than repairing or falling back.
 *
 * Order inside a frame, and the reason for it:
 *
 *   EntityRound        — Account inputs, Entity work, Account proposals
 *   parity             — verify commitments and typed effects at the boundary
 *   Runtime WAL fsync  — TypeScript's own record becomes durable
 *
 * Rust executes against an internal path-copy candidate. The next inbound
 * carries the Entity's canonical Account-forest root: naming the candidate
 * promotes it, naming the base drops it, and naming a piggybacked checkpoint
 * implicitly acknowledges that durable baseline. A failed WAL/DB write is
 * fail-stop. There is no second Commit/Abort/checkpoint-ACK protocol whose
 * answer could disagree with the WAL.
 */

import { createHash } from 'node:crypto';

import { createStructuredLogger } from '../support/logger';
import { getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import { getEntityReplicaById } from '../entity/replica/replica-lookup';
import {
  authorityAccountInputRow,
  buildAuthorityWave,
  type AuthorityCertifiedBoard,
  type AuthorityWave,
} from './authority-wave';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  shadowIneligibilityReason,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from './shadow-wire';
import { requireAccountDeltaTransformerAddress } from '../account/consensus/helpers';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROCESS_PROFILE,
  RSCORE_PROTOCOL_FINGERPRINT,
  type RscoreCheckpointChanges,
  type RscoreCheckpointToken,
  type RscoreExactCheckpoint,
  type RscoreProcessClient,
  type RscoreWireValue,
} from './client';
import {
  assertRscoreCheckpointCandidate,
  decodeRscoreCheckpointChanges,
} from './checkpoint/checkpoint-wire';
import { decodeRscoreAccountRestoreRow } from './checkpoint/checkpoint-restore';
import { PersistentRadixValueMap } from '../protocol/state/persistent-radix-value-map';
import type { AccountInput, AccountReplica } from '../types/account';
import type { RuntimeReplica } from '../runtime/types';
import { buffersEqual, safeStringify } from '../protocol/serialization';
import { DEFAULT_MATERIALIZE_PERIOD_FRAMES } from '../storage/keys';
import { entityOwnedSectionDigests, entitySnapshotWire } from './entity/snapshot-wire';
import { entityDeterministicContextWire, type RscoreEntityRound } from './entity/round-wire';
import type { EntityInfraContext } from '../types/entity/infra-context';
import type { EntityState } from '../entity/types';

const authorityLog = createStructuredLogger('rscore.authority');

type AuthorityRuntimeScope = Pick<
  RuntimeReplica,
  'runtimeId' | 'accountAuthoritySuppressed'
>;

const authorityTargetRuntimeId = (): string | undefined => {
  const configured = process.env['XLN_RSCORE_AUTHORITY_RUNTIME_ID'];
  if (configured === undefined || configured === '') return undefined;
  if (!/^0x[0-9a-f]{40}$/.test(configured)) {
    throw new Error(`RSCORE_AUTHORITY_RUNTIME_ID_INVALID:${configured}`);
  }
  return configured;
};

/**
 * Authority is process-configured but Runtime-scoped. HLT packs hundreds of
 * sovereign Runtime replicas into one process, so inheriting the flag must
 * never silently hand all of them to the H1 engine. Omitting the target keeps
 * the single-Runtime production process behavior; packed hosts name H1
 * explicitly.
 */
export const authorityDriverEnabled = (env?: AuthorityRuntimeScope): boolean => {
  if (process.env['XLN_RSCORE_AUTHORITY'] !== '1') return false;
  if (env?.accountAuthoritySuppressed === true) return false;
  const target = authorityTargetRuntimeId();
  if (target === undefined || env === undefined) return true;
  const runtimeId = String(env.runtimeId ?? '');
  if (!/^0x[0-9a-f]{40}$/.test(runtimeId)) {
    throw new Error(`RSCORE_AUTHORITY_RUNTIME_ID_MISSING:${runtimeId}`);
  }
  return runtimeId === target;
};

/**
 * A read-only replay never writes, so nothing it does can become durable —
 * which is exactly why it is the one place the engine may drive without a
 * Runtime WAL behind it. The recording's own frame roots are the check.
 *
 * Off by default: a read-only restore that silently started an engine would
 * make a diagnostic tool a second authority.
 */
export const authorityReplayEnabled = (): boolean =>
  process.env['XLN_RSCORE_AUTHORITY_REPLAY'] === '1'
  && process.env['XLN_RSCORE_AUTHORITY'] === '1';

/** Explicit feature gate while the resident Entity profile is proved in HLT. */
export const entityAuthorityDriverEnabled = (env?: AuthorityRuntimeScope): boolean =>
  authorityDriverEnabled(env)
  && process.env['XLN_RSCORE_ENTITY_AUTHORITY'] === '1';

export const authorityRuntimeSuppressed = (env: RuntimeReplica): boolean =>
  env.accountAuthoritySuppressed === true;

export const setAuthorityRuntimeSuppressed = (
  env: RuntimeReplica,
  suppressed: boolean,
): void => {
  if (suppressed) env.accountAuthoritySuppressed = true;
  else delete env.accountAuthoritySuppressed;
};

type Session = {
  client: RscoreProcessClient;
  ownerEntityId: string;
  /** Membership held by the resident engine at its accepted Account root. */
  residentAccounts: Set<string>;
  /** Exact Entity state is installed beside the resident Account forest. */
  entityResident: boolean;
  /** Fresh empty base returned by Rust; retained only until its first WAL commit. */
  bootstrapCheckpoint: RscoreCheckpointChanges | null;
};

type OpenFrame = {
  session: Session;
  /** The Entity input whose Rust path-copy candidate is currently open. */
  entityInput: AuthorityEntityStageHandle | null;
  /** Where the Rust engine stood after its most recent response. */
  latest: Readonly<{ revision: number; accountsRoot: string }> | null;
  /** Account forest selected by accepted Entity inputs in this Runtime frame. */
  acceptedAccountsRoot: string;
  /** Membership at Rust's currently held base/candidate head. */
  candidateAccounts: Set<string>;
  /** Repeatable exports keyed by the exact candidate root they describe. */
  checkpoints: Map<string, RscoreCheckpointChanges>;
  /** Produced during inbound and consumed during outbound without another IPC. */
  entityRound: RscoreEntityRound | null;
};

/** Names the Entity input and the parent root from which it started. */
export type AuthorityEntityStageHandle = Readonly<{
  ownerEntityId: string;
  baseAccountsRoot: string;
}>;

export type AuthorityCheckpointStorageInput = Readonly<{
  ownerEntityId: string;
  protocolFingerprint: string;
  checkpoint: RscoreCheckpointChanges;
}>;

/**
 * One session per Entity that holds accounts, keyed by Runtime object identity
 * and then Entity id. The engine signs as one board, and a Runtime hosts more
 * than one Entity — a hub and its book live side by side in the H1 Runtime.
 */
const sessions = new Map<RuntimeReplica, Map<string, Session | 'disabled'>>();
const allSessions = new Set<Session>();
const captured = new Map<RuntimeReplica, AuthorityWave>();
/** Candidates open in each Entity's engine, by Runtime. */
const pending = new Map<RuntimeReplica, OpenFrame[]>();
/** Original Account-operation arrival cursor for the active Runtime frame. */
const arrivalCursors = new Map<RuntimeReplica, number>();

const report = {
  waves: 0,
  inboundRounds: 0,
  outboundRounds: 0,
  framesProposed: 0,
  inputsApplied: 0,
  accountsSeeded: 0,
  emptyFrames: 0,
  finalizedFrames: 0,
  discardedEntityInputs: 0,
  failStops: 0,
  checkpointsPrepared: 0,
  checkpointValidations: 0,
  restores: 0,
  /** Microseconds spent inside the engine, as the engine itself measured. */
  engineMicros: 0,
  /** Microseconds the caller waited for the engine, transport included. */
  waveMicros: 0,
};

const authorityDriverReport = (): typeof report => ({ ...report });

/** A halt, not a warning: authority boundary checks must agree exactly. */
const halt = (code: string, detail: Record<string, unknown>): never => {
  authorityLog.error('authority.halt', { code, ...detail });
  console.error(`RSCORE_AUTHORITY_HALT ${code} ${safeStringify(detail)}`);
  throw new Error(`RSCORE_AUTHORITY_HALT:${code}`);
};

/**
 * Take the frame the collector holds before the reducer closes it. Called on
 * the Runtime frame boundary; the wave is prepared later, outside the mutation
 * the collector was watching.
 */
export const captureAuthorityWave = (env: RuntimeReplica, frameId: string): void => {
  if (!authorityDriverEnabled(env)) return;
  captured.set(env, buildAuthorityWave(frameId));
};

function sessionMap(
  env: RuntimeReplica,
  create: true,
): Map<string, Session | 'disabled'>;
function sessionMap(
  env: RuntimeReplica,
  create: false,
): Map<string, Session | 'disabled'> | undefined;
function sessionMap(
  env: RuntimeReplica,
  create: boolean,
): Map<string, Session | 'disabled'> | undefined {
  const existing = sessions.get(env);
  if (existing || !create) return existing;
  const created = new Map<string, Session | 'disabled'>();
  sessions.set(env, created);
  return created;
}

const sessionEntriesForRuntime = (env: RuntimeReplica): Session[] =>
  [...(sessionMap(env, false)?.values() ?? [])]
  .filter((session): session is Session => session !== 'disabled')
  .sort((left, right) => left.ownerEntityId.localeCompare(right.ownerEntityId));

const protocolFingerprint = `0x${RSCORE_PROTOCOL_FINGERPRINT.toString('hex')}`;

const authorityBindingDigest = (
  domain: string,
  ...parts: readonly Uint8Array[]
): Buffer => {
  const hasher = createHash('sha256').update(domain, 'utf8').update(Buffer.from([0]));
  for (const part of parts) hasher.update(part);
  return hasher.digest();
};

/**
 * Bind every process transcript to the sovereign Runtime and Account owner it
 * serves. Constant identities let a reply from one packed Runtime satisfy the
 * header checks of another; random identities make deterministic recovery
 * needlessly depend on host entropy. The real Runtime and owner identifiers
 * are fixed-width, so their concatenation is unambiguous under separate
 * domains.
 */
export const authoritySessionIdentityFor = (
  runtimeIdValue: string,
  ownerEntityId: string,
): Readonly<{
  engineGeneration: Buffer;
  runtimeId: Buffer;
  sessionId: Buffer;
}> => {
  const runtimeId = Buffer.from(hexToWireBytes(
    runtimeIdValue,
    20,
    'RSCORE_AUTHORITY_RUNTIME_ID_BYTES',
  ));
  const ownerId = Buffer.from(hexToWireBytes(
    ownerEntityId,
    32,
    'RSCORE_AUTHORITY_OWNER_ID_BYTES',
  ));
  return {
    engineGeneration: authorityBindingDigest(
      'xln.rscore.engine-generation.v1',
      runtimeId,
    ).subarray(0, 8),
    runtimeId,
    sessionId: authorityBindingDigest(
      'xln.rscore.authority-session.v1',
      runtimeId,
      ownerId,
    ).subarray(0, 16),
  };
};

/**
 * The signer this Runtime holds for an Entity, as the replica itself records
 * it: the signer's own address, which is also the single member of a lazy
 * board.
 */
const signerIdFor = (env: RuntimeReplica, entityId: string): string | null => {
  const replica = getEntityReplicaById(env, entityId);
  const signerId = String(replica?.signerId ?? '').trim().toLowerCase();
  return signerId === '' ? null : signerId;
};

const accountsOf = (env: RuntimeReplica, entityId: string): ReadonlyMap<string, AccountReplica> => {
  const replica = getEntityReplicaById(env, entityId);
  return replica?.state.accounts ?? new Map<string, AccountReplica>();
};

const authoritySignerFor = (
  env: RuntimeReplica,
  ownerEntityId: string,
): Readonly<{ signerId: string; privateKey: Uint8Array }> | string => {
  const signerId = signerIdFor(env, ownerEntityId);
  if (!signerId) return 'SIGNER_UNKNOWN';
  const expected = generateLazyEntityId([signerId], 1n).toLowerCase();
  if (expected !== ownerEntityId) return `ENTITY_NOT_LAZY_1_OF_1:${expected}`;
  const privateKey = getSignerPrivateKeyIfAvailable(env, signerId);
  if (!privateKey) return 'SIGNER_KEY_UNAVAILABLE';
  return { signerId, privateKey };
};

const openAuthoritySession = async (
  env: RuntimeReplica,
  ownerEntityId: string,
): Promise<Session | 'disabled'> => {
  const signer = authoritySignerFor(env, ownerEntityId);
  if (typeof signer === 'string') return disable(ownerEntityId, signer);
  const { signerId, privateKey } = signer;

  const { RscoreProcessClient } = await import('./client');
  const binaryPath = process.env['XLN_RSCORE_BINARY']
    ?? new URL('../../rscore/target/release/xlnrs', import.meta.url).pathname;
  const client = new RscoreProcessClient(
    binaryPath,
    authoritySessionIdentityFor(String(env.runtimeId ?? ''), ownerEntityId),
  );
  const workers = Number(process.env['XLN_RSCORE_AUTHORITY_WORKERS'] ?? '8');
  const market = swapMarketPolicyWire();
  try {
    const rawHello = await client.hello(workers, market, { privateKey, signerId });
    if (!Array.isArray(rawHello) || rawHello.length !== 6) {
      throw new Error('RSCORE_AUTHORITY_HELLO_ARITY');
    }
    const [abi, profile, actualWorkers, rawMarketDigest, rawSigner, rawEntity] = rawHello;
    if (abi !== RSCORE_PROCESS_ABI_VERSION) {
      throw new Error(`RSCORE_AUTHORITY_HELLO_ABI:${String(abi)}:${RSCORE_PROCESS_ABI_VERSION}`);
    }
    if (profile !== RSCORE_PROCESS_PROFILE) {
      throw new Error(`RSCORE_AUTHORITY_HELLO_PROFILE:${String(profile)}:${RSCORE_PROCESS_PROFILE}`);
    }
    if (actualWorkers !== workers) {
      throw new Error(`RSCORE_AUTHORITY_HELLO_WORKERS:${String(actualWorkers)}:${workers}`);
    }
    if (!(rawMarketDigest instanceof Uint8Array) || rawMarketDigest.byteLength !== 32) {
      throw new Error('RSCORE_AUTHORITY_HELLO_MARKET_BYTES');
    }
    const actualMarketDigest = `0x${Buffer.from(rawMarketDigest).toString('hex')}`;
    const expectedMarketDigest = swapMarketPolicyDigest(market);
    if (actualMarketDigest !== expectedMarketDigest) {
      throw new Error(
        `RSCORE_AUTHORITY_HELLO_MARKET:${actualMarketDigest}:${expectedMarketDigest}`,
      );
    }
    if (!(rawSigner instanceof Uint8Array) || rawSigner.byteLength !== 20) {
      throw new Error('RSCORE_AUTHORITY_HELLO_SIGNER_BYTES');
    }
    const derivedSigner = `0x${Buffer.from(rawSigner).toString('hex')}`.toLowerCase();
    if (derivedSigner !== signerId) {
      throw new Error(`RSCORE_AUTHORITY_HELLO_SIGNER:${derivedSigner}:${signerId}`);
    }
    if (!(rawEntity instanceof Uint8Array) || rawEntity.byteLength !== 32) {
      throw new Error('RSCORE_AUTHORITY_HELLO_ENTITY_BYTES');
    }
    const derivedEntity = `0x${Buffer.from(rawEntity).toString('hex')}`.toLowerCase();
    if (derivedEntity !== ownerEntityId) {
      throw new Error(`RSCORE_AUTHORITY_HELLO_ENTITY:${derivedEntity}:${ownerEntityId}`);
    }
  } catch (error) {
    client.kill();
    throw error;
  }
  return {
    client,
    ownerEntityId,
    residentAccounts: new Set(),
    entityResident: false,
    bootstrapCheckpoint: null,
  };
};

/**
 * Import the Accounts TypeScript already holds as the engine's starting state.
 *
 * This is not recovery and never runs in production: durable history enters
 * through RestoreExact, whose token binds every leaf, signer and revision. A
 * read-only replay of a recording made before the authority existed has no
 * such checkpoint, and the recording's own frame roots are what checks the
 * engine afterwards. It is loud, explicit and refused unless asked for.
 */
const authorityImportEnabled = (): boolean =>
  process.env['XLN_RSCORE_AUTHORITY_IMPORT'] === '1';

const importAccountsFromTypescript = async (
  env: RuntimeReplica,
  session: Session,
  accounts: ReadonlyMap<string, AccountReplica>,
): Promise<void> => {
  const seeds: Array<Readonly<{
    counterpartyId: string;
    seed: RscoreWireValue;
  }>> = [];
  const refused: Record<string, string> = {};
  for (const [counterpartyId, account] of [...accounts].sort(([left], [right]) =>
    (left < right ? -1 : left > right ? 1 : 0))) {
    try {
      const ineligible = shadowIneligibilityReason(account.state);
      if (ineligible !== null) {
        throw new Error(`AUTHORITY_IMPORT_INELIGIBLE:${ineligible}`);
      }
      seeds.push({
        counterpartyId,
        seed: accountSeedWire(
          session.ownerEntityId,
          counterpartyId,
          account.state,
          accountEnvelopeWire(account),
          accountConsensusWire(account),
          requireAccountDeltaTransformerAddress(env.state, account.state),
        ),
      });
    } catch (error) {
      refused[counterpartyId] = error instanceof Error ? error.message : String(error);
    }
  }
  if (Object.keys(refused).length > 0) {
    return halt('AUTHORITY_IMPORT_UNSUPPORTED_ACCOUNTS', {
      owner: session.ownerEntityId,
      refused,
    });
  }
  await session.client.bootstrapAccounts(0, seeds.map(row => row.seed), true);
  for (const row of seeds) {
    session.residentAccounts.add(row.counterpartyId);
  }
  authorityLog.error('authority.imported', {
    owner: session.ownerEntityId,
    accounts: seeds.length,
  });
  console.error(
    `RSCORE_AUTHORITY_IMPORT ${session.ownerEntityId} accounts=${seeds.length}`,
  );
  report.accountsSeeded += seeds.length;
};

const bootstrapResidentEntity = async (
  env: RuntimeReplica,
  session: Session,
): Promise<void> => {
  if (!entityAuthorityDriverEnabled(env)) return;
  const replica = getEntityReplicaById(env, session.ownerEntityId);
  if (replica == null) {
    return halt('ENTITY_BOOTSTRAP_REPLICA_MISSING', { owner: session.ownerEntityId });
  }
  const loaded = await session.client.bootstrapEntity(entitySnapshotWire(replica.state));
  const expectedRoot = accountMapRoot(replica.state.accounts, session.ownerEntityId);
  if (loaded.accountsRoot.toLowerCase() !== expectedRoot) {
    return halt('ENTITY_BOOTSTRAP_ACCOUNT_ROOT_MISMATCH', {
      owner: session.ownerEntityId,
      expected: expectedRoot,
      actual: loaded.accountsRoot,
    });
  }
  const expectedSections = entityOwnedSectionDigests(replica.state);
  if (safeStringify(loaded.ownedSections) !== safeStringify(expectedSections)) {
    return halt('ENTITY_BOOTSTRAP_SECTION_MISMATCH', {
      owner: session.ownerEntityId,
      expected: expectedSections,
      actual: loaded.ownedSections,
    });
  }
  session.entityResident = true;
};

const armSession = async (env: RuntimeReplica, ownerEntityId: string): Promise<Session | 'disabled'> => {
  const session = await openAuthoritySession(env, ownerEntityId);
  if (session === 'disabled') return session;
  const accounts = accountsOf(env, ownerEntityId);
  if (accounts.size !== 0 && authorityImportEnabled()) {
    await importAccountsFromTypescript(env, session, accounts);
  } else if (accounts.size !== 0) {
    session.client.kill();
    return halt('AUTHORITY_EXACT_RESTORE_REQUIRED', {
      owner: ownerEntityId,
      accountCount: accounts.size,
    });
  } else {
    const loaded = await session.client.bootstrapAccounts(0, []);
    if (!Array.isArray(loaded) || loaded.length !== 3 || loaded[2] === null) {
      session.client.kill();
      return halt('AUTHORITY_EMPTY_BOOTSTRAP_CHECKPOINT_MISSING', {
        owner: ownerEntityId,
      });
    }
    session.bootstrapCheckpoint = decodeRscoreCheckpointChanges(loaded[2]);
  }
  await bootstrapResidentEntity(env, session);
  authorityLog.error('authority.armed', {
    owner: ownerEntityId,
    accounts: 0,
    workers: Number(process.env['XLN_RSCORE_AUTHORITY_WORKERS'] ?? '8'),
  });
  return session;
};

const disable = (ownerEntityId: string, reason: string): 'disabled' => {
  authorityLog.error('authority.disabled', { owner: ownerEntityId, reason });
  console.error(`RSCORE_AUTHORITY_DISABLED ${ownerEntityId} ${reason}`);
  return 'disabled';
};

/**
 * Arm an empty engine before the first Account exists.
 *
 * Existing Account state may enter only through RestoreExact. Fresh membership
 * enters only through WaveOp::Create inside the abortable Runtime candidate;
 * importing TypeScript's current answer here would hide a missed transition.
 */
export const armAuthorityWave = async (
  env: RuntimeReplica,
  checkpointBarrierDue = false,
): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const materializePeriod = env.runtimeConfig?.storage?.materializePeriodFrames
    ?? DEFAULT_MATERIALIZE_PERIOD_FRAMES;
  if (!Number.isSafeInteger(materializePeriod) || materializePeriod < 1) {
    return halt('CHECKPOINT_PERIOD_INVALID', { materializePeriod });
  }
  const nextHeight = env.state.height + 1;
  env.accountAuthorityCheckpointDue = checkpointBarrierDue || nextHeight === 1
    || (nextHeight - 1) % materializePeriod === 0;
  const runtimeSessions = sessionMap(env, true);
  // A zero-account Entity must already own an empty session before the frame
  // that opens its first Account, otherwise Create would have nowhere to run.
  for (const replica of env.state.eReplicas.values()) {
    const ownerEntityId = replica.entityId.trim().toLowerCase();
    // Do not pre-arm unrelated registered/numbered Entities that happen to be
    // hosted by this Runtime. If one later tries to open an Account, its first
    // wave is refused as unarmed; nonempty state is never imported.
    if (
      replica.state.accounts.size === 0
      && typeof authoritySignerFor(env, ownerEntityId) === 'string'
    ) continue;
    const existing = runtimeSessions.get(ownerEntityId);
    if (existing === 'disabled') {
      return halt('OWNER_AUTHORITY_INELIGIBLE', { owner: ownerEntityId });
    }
    if (existing === undefined) {
      const armed = await armSession(env, ownerEntityId);
      if (armed === 'disabled') {
        return halt('OWNER_AUTHORITY_INELIGIBLE', { owner: ownerEntityId });
      }
      runtimeSessions.set(ownerEntityId, armed);
      allSessions.add(armed);
      continue;
    }
    const actual = new Set(replica.state.accounts.keys());
    const missing = [...actual]
      .filter(accountId => !existing.residentAccounts.has(accountId))
      .sort();
    const removed = [...existing.residentAccounts]
      .filter(accountId => !actual.has(accountId))
      .sort();
    if (missing.length > 0 || removed.length > 0) {
      halt('AUTHORITY_MEMBERSHIP_OUTSIDE_CANDIDATE', {
        owner: ownerEntityId,
        missing,
        removed,
      });
    }
  }
  if (pending.has(env)) {
    return halt('AUTHORITY_CANDIDATE_ALREADY_OPEN', {
      owners: (pending.get(env) ?? []).map(candidate => candidate.session.ownerEntityId),
    });
  }
  const candidates = sessionEntriesForRuntime(env).map(session => {
    const acceptedAccountsRoot = accountMapRoot(
      accountsOf(env, session.ownerEntityId),
      session.ownerEntityId,
    );
    return {
      session,
      entityInput: null,
      latest: null,
      acceptedAccountsRoot,
      candidateAccounts: new Set(session.residentAccounts),
      checkpoints: session.bootstrapCheckpoint === null
        ? new Map()
        : new Map([[acceptedAccountsRoot, session.bootstrapCheckpoint]]),
      entityRound: null,
    } satisfies OpenFrame;
  });
  pending.set(env, candidates);
  arrivalCursors.set(env, 0);
};

const exactCheckpointRoot = (checkpoint: RscoreExactCheckpoint): string =>
  `0x${Buffer.from(checkpoint.restoreToken[2]).toString('hex')}`.toLowerCase();

const accountMapRoot = (
  accounts: ReadonlyMap<string, AccountReplica>,
  ownerEntityId: string,
): string => {
  const rootHash = (accounts as ReadonlyMap<string, AccountReplica> & {
    rootHash?: () => string;
  }).rootHash;
  if (typeof rootHash !== 'function') {
    return halt('ACCOUNT_FOREST_NOT_CANONICAL', { owner: ownerEntityId });
  }
  return rootHash.call(accounts).trim().toLowerCase();
};

/**
 * Rebuild every Rust authority session from the exact materialized rows before
 * WAL-tail replay. In authority mode a missing owner or token is corruption,
 * never permission to bootstrap from the already-restored TypeScript answer.
 */
export const restoreAuthorityExact = async (
  env: RuntimeReplica,
  checkpoints: readonly RscoreExactCheckpoint[],
): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const expectedOwnerForests = new Map<string, { root: string; count: number }>();
  const requiredOwners = new Set<string>();
  for (const replica of env.state.eReplicas.values()) {
    const ownerEntityId = replica.entityId.trim().toLowerCase();
    const forest = {
      root: accountMapRoot(replica.state.accounts, ownerEntityId),
      count: replica.state.accounts.size,
    };
    const previous = expectedOwnerForests.get(ownerEntityId);
    if (previous !== undefined && (
      previous.root !== forest.root || previous.count !== forest.count
    )) {
      halt('DUPLICATE_OWNER_STATE_MISMATCH', {
        owner: ownerEntityId,
        firstRoot: previous.root,
        secondRoot: forest.root,
        firstCount: previous.count,
        secondCount: forest.count,
      });
    }
    expectedOwnerForests.set(ownerEntityId, forest);
    if (forest.count > 0) requiredOwners.add(ownerEntityId);
  }
  const ordered = [...checkpoints]
    .sort((left, right) => left.ownerEntityId.localeCompare(right.ownerEntityId));
  const actualOwners = ordered.map(checkpoint => checkpoint.ownerEntityId.trim().toLowerCase());
  const actualOwnerSet = new Set(actualOwners);
  const missingOwners = [...requiredOwners]
    .filter(owner => !actualOwnerSet.has(owner))
    .sort();
  const unknownOwners = actualOwners
    .filter(owner => !expectedOwnerForests.has(owner))
    .sort();
  if (
    actualOwnerSet.size !== actualOwners.length ||
    missingOwners.length > 0 ||
    unknownOwners.length > 0
  ) {
    halt('RESTORE_OWNER_SET_MISMATCH', {
      required: [...requiredOwners].sort(),
      actual: actualOwners,
      missing: missingOwners,
      unknown: unknownOwners,
    });
  }

  const opened: Array<{ ownerEntityId: string; session: Session }> = [];
  try {
    for (const checkpoint of ordered) {
      const ownerEntityId = checkpoint.ownerEntityId.trim().toLowerCase();
      if (checkpoint.protocolFingerprint.toLowerCase() !== protocolFingerprint) {
        halt('RESTORE_FINGERPRINT_MISMATCH', {
          owner: ownerEntityId,
          expected: protocolFingerprint,
          actual: checkpoint.protocolFingerprint,
        });
      }
      const expectedForest = expectedOwnerForests.get(ownerEntityId);
      if (expectedForest === undefined) {
        return halt('RESTORE_OWNER_MISSING', { owner: ownerEntityId });
      }
      const checkpointRoot = exactCheckpointRoot(checkpoint);
      if (
        checkpointRoot !== expectedForest.root ||
        checkpoint.restoreToken[4] !== expectedForest.count
      ) {
        halt('RESTORE_TYPESCRIPT_FOREST_MISMATCH', {
          owner: ownerEntityId,
          typescriptRoot: expectedForest.root,
          checkpointRoot,
          typescriptCount: expectedForest.count,
          checkpointCount: checkpoint.restoreToken[4],
        });
      }
      const session = await openAuthoritySession(env, ownerEntityId);
      if (session === 'disabled') {
        return halt('RESTORE_SESSION_DISABLED', { owner: ownerEntityId });
      }
      opened.push({ ownerEntityId, session });
      const restored = await session.client.restoreExact(
        checkpoint.restoreToken,
        checkpoint.accounts,
      );
      if (!checkpointTokensEqual(restored, checkpoint.restoreToken)) {
        halt('RESTORE_TOKEN_MISMATCH', {
          owner: ownerEntityId,
          expectedRevision: String(checkpoint.restoreToken[1]),
          restoredRevision: String(restored[1]),
        });
      }
      const restoredAccounts = accountsOf(env, ownerEntityId);
      session.residentAccounts = new Set(restoredAccounts.keys());
      await bootstrapResidentEntity(env, session);
      report.restores += 1;
    }
  } catch (error) {
    for (const { session } of opened) session.client.kill();
    throw error;
  }
  for (const existing of sessionMap(env, false)?.values() ?? []) {
    if (existing === 'disabled') continue;
    existing.client.kill();
    allSessions.delete(existing);
  }
  const installed = new Map<string, Session | 'disabled'>();
  for (const entry of opened) {
    installed.set(entry.ownerEntityId, entry.session);
    allSessions.add(entry.session);
  }
  sessions.set(env, installed);
  captured.delete(env);
  pending.delete(env);
  arrivalCursors.delete(env);
};

const candidateForOwner = (
  env: RuntimeReplica,
  ownerEntityId: string,
): OpenFrame | undefined => (pending.get(env) ?? [])
  .find(frame => frame.session.ownerEntityId === ownerEntityId);

/** The Entity input whose Rust path-copy candidate is currently open. */
export const authorityCutoverStageHandle = (
  env: RuntimeReplica,
  ownerEntityId: string,
): AuthorityEntityStageHandle | null =>
  candidateForOwner(env, ownerEntityId.trim().toLowerCase())?.entityInput ?? null;

const openEntityInputCandidate = (
  frame: OpenFrame,
  owner: string,
  expectedAccountsRoot: string,
): void => {
  const expected = expectedAccountsRoot.toLowerCase();
  if (frame.entityInput === null) {
    if (expected !== frame.acceptedAccountsRoot) {
      return halt('ENTITY_INPUT_PARENT_ROOT_MISMATCH', {
        owner,
        accepted: frame.acceptedAccountsRoot,
        requested: expectedAccountsRoot,
      });
    }
    frame.entityInput = { ownerEntityId: owner, baseAccountsRoot: expected };
    frame.entityRound = null;
    return;
  }
  if (expected !== frame.entityInput.baseAccountsRoot) {
    return halt('ENTITY_INPUT_RETRY_ROOT_MISMATCH', {
      owner,
      opened: frame.entityInput.baseAccountsRoot,
      requested: expectedAccountsRoot,
    });
  }
};

/**
 * One process crossing for Account inbound, Entity pay/orderbook work and
 * Account outbound. TypeScript may execute the same Entity logic as an oracle,
 * but the outbound phase consumes this cached result and performs no IPC.
 */
export const runAuthorityCutoverEntityBatch = async (
  env: RuntimeReplica,
  request: Readonly<{
    ownerEntityId: string;
    expectedAccountsRoot: string;
    entityState: EntityState;
    entityContext: EntityInfraContext;
    entityTimestamp: number;
    finalizedJHeight: number;
    inputs: readonly Readonly<{
      accountId: string;
      input: Extract<AccountInput, { kind: 'ack' | 'ack_frame' }>;
      counterpartyBoardAuthority?: AuthorityCertifiedBoard;
      localBoardAuthority?: AuthorityCertifiedBoard;
      genesisPolicy?: Readonly<{
        expectedDomain: AccountReplica['state']['domain'];
        shadowPolicyRoot: string;
        shadowPolicyRows: readonly (readonly [number, unknown])[];
        deltaTransformer: string;
        publicPinned: false;
      }>;
    }>[];
  }>,
): Promise<RscoreEntityRound | null> => {
  if (!entityAuthorityDriverEnabled(env)) return null;
  const owner = request.ownerEntityId.trim().toLowerCase();
  const frame = candidateForOwner(env, owner);
  if (frame === undefined) return null;
  if (!frame.session.entityResident) {
    return halt('ENTITY_RESIDENT_SESSION_REQUIRED', { owner });
  }
  if (request.entityState.entityId.trim().toLowerCase() !== owner) {
    return halt('ENTITY_ROUND_OWNER_MISMATCH', {
      owner,
      state: request.entityState.entityId,
    });
  }
  if (request.entityContext.height !== request.entityState.height + 1) {
    return halt('ENTITY_ROUND_HEIGHT_MISMATCH', {
      owner,
      parent: request.entityState.height,
      context: request.entityContext.height,
    });
  }
  const parentRoot = accountMapRoot(request.entityState.accounts, owner);
  if (parentRoot !== request.expectedAccountsRoot.toLowerCase()) {
    return halt('ENTITY_ROUND_PARENT_ROOT_MISMATCH', {
      owner,
      expected: request.expectedAccountsRoot,
      state: parentRoot,
    });
  }
  openEntityInputCandidate(frame, owner, request.expectedAccountsRoot);
  const rows = request.inputs.map((entry, index) => authorityAccountInputRow(
    index,
    entry.accountId,
    { kind: entry.input.kind, input: entry.input } as Parameters<typeof authorityAccountInputRow>[2],
    entry.genesisPolicy,
    entry.counterpartyBoardAuthority,
    entry.localBoardAuthority,
  ));
  const startedMs = performance.now();
  const round = await frame.session.client.entityRound({
    ownerEntityId: hexToWireBytes(owner, 32, 'AUTHORITY_ENTITY_OWNER'),
    expectedAccountsRoot: hexToWireBytes(
      request.expectedAccountsRoot,
      32,
      'AUTHORITY_ENTITY_EXPECTED_ACCOUNTS_ROOT',
    ),
    inboundTimestamp: request.entityTimestamp,
    inboundJHeight: request.finalizedJHeight,
    inboundRows: rows,
    // Entity Stage 2 consumes Account state committed by Stage 1. The full
    // resident round still defers root sealing, but must return the exact
    // changed inbound Account rows to the TypeScript oracle/followup path.
    inboundPostAccounts: true,
    entityHeight: request.entityContext.height,
    outboundTimestamp: request.entityTimestamp,
    outboundJHeight: request.finalizedJHeight,
    checkpointDue: env.accountAuthorityCheckpointDue === true,
    postAccounts: true,
    context: entityDeterministicContextWire(
      request.entityState,
      request.entityContext,
      request.entityState.config?.jurisdiction?.name,
    ),
  });
  if ((env.accountAuthorityCheckpointDue === true) !== (round.outbound.checkpoint !== null)) {
    return halt('ENTITY_ROUND_CHECKPOINT_PRESENCE', {
      owner,
      requested: env.accountAuthorityCheckpointDue === true,
      received: round.outbound.checkpoint !== null,
    });
  }
  if (round.outbound.checkpoint !== null) {
    const checkpointRoot = `0x${Buffer.from(
      round.outbound.checkpoint.restoreToken[2],
    ).toString('hex')}`.toLowerCase();
    frame.checkpoints.set(checkpointRoot, round.outbound.checkpoint);
  }
  for (const created of round.inbound.createdAccounts) {
    frame.candidateAccounts.add(created.accountId);
  }
  frame.latest = {
    revision: round.outbound.revision,
    accountsRoot: round.outbound.accountsRoot,
  };
  frame.entityRound = round;
  report.waves += 1;
  report.inboundRounds += 1;
  report.outboundRounds += 1;
  report.engineMicros += round.engineMicros;
  report.waveMicros += Math.round((performance.now() - startedMs) * 1_000);
  report.inputsApplied += round.inbound.applied.length;
  report.framesProposed += round.outbound.proposals.filter(row => row.frame !== null).length;
  return round;
};

export const authorityCutoverEntityRound = (
  env: RuntimeReplica,
  ownerEntityId: string,
): RscoreEntityRound | null => {
  if (!entityAuthorityDriverEnabled(env)) return null;
  const owner = ownerEntityId.trim().toLowerCase();
  const frame = candidateForOwner(env, owner);
  if (frame === undefined) return null;
  if (frame.entityInput === null || frame.entityRound === null) {
    return halt('ENTITY_ROUND_RESULT_MISSING', { owner });
  }
  return frame.entityRound;
};

/** Close the Entity bookkeeping marker; Rust already owns the new state. */
export const acceptAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const frame = requireOpenEntityInput(env, handle);
  if (frame.latest === null) {
    return halt('ENTITY_INPUT_ACCEPT_WITHOUT_ENGINE_RESULT', {
      owner: handle.ownerEntityId,
    });
  }
  frame.acceptedAccountsRoot = frame.latest.accountsRoot.toLowerCase();
  // Membership changes become authoritative only with the parent Entity
  // input that published them. Inbound may have created H=1 inside Rust
  // earlier, but a rejected Entity input must not advance this accepted set.
  frame.session.residentAccounts = new Set(frame.candidateAccounts);
  frame.entityInput = null;
  frame.entityRound = null;
};

const killAuthorityRuntime = (env: RuntimeReplica): void => {
  for (const session of sessionMap(env, false)?.values() ?? []) {
    if (session === 'disabled') continue;
    session.client.kill();
    allSessions.delete(session);
  }
  sessions.delete(env);
  captured.delete(env);
  pending.delete(env);
  arrivalCursors.delete(env);
  delete env.accountAuthorityCheckpointDue;
};

/** Leave the held candidate for root reconciliation on the next useful call. */
export const discardAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const frame = requireOpenEntityInput(env, handle);
  frame.acceptedAccountsRoot = handle.baseAccountsRoot;
  frame.candidateAccounts = new Set(frame.session.residentAccounts);
  frame.entityInput = null;
  frame.entityRound = null;
  report.discardedEntityInputs += 1;
};

const requireOpenEntityInput = (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle,
): OpenFrame => {
  const frame = candidateForOwner(env, handle.ownerEntityId);
  if (frame === undefined || frame.entityInput !== handle) {
    return halt('ENTITY_INPUT_HANDLE_STALE', { owner: handle.ownerEntityId });
  }
  return frame;
};

/** Nothing to seal: the accounts already moved in their owning subsystem. */
export const assertAuthorityFrameSettled = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const frames = pending.get(env);
  if (frames === undefined) return halt('AUTHORITY_FRAME_CANDIDATE_MISSING', {});
  if (frames.length === 0) {
    report.emptyFrames += 1;
    return;
  }
  for (const frame of frames) {
    if (frame.entityInput !== null) {
      return halt('AUTHORITY_FRAME_ENTITY_INPUT_OPEN', {
        owner: frame.session.ownerEntityId,
      });
    }
  }
};

/**
 * The exported rows must name the tree both sides believe they are at.
 *
 * The engine's own position comes from the last thing this frame did to it,
 * and TypeScript's from its own accounts forest. A checkpoint taken at a
 * boundary where those disagree would restore into a divergence.
 */
const assertCheckpointMatchesCandidate = (
  env: RuntimeReplica,
  candidate: OpenFrame,
  position: Readonly<{ revision: number | bigint; accountsRoot: string }>,
  checkpoint: RscoreCheckpointChanges,
): void => {
  const owner = candidate.session.ownerEntityId;
  const accounts = accountsOf(env, owner);
  const typescriptRoot = accountMapRoot(accounts, owner);
  const checkpointRoot = `0x${Buffer.from(checkpoint.restoreToken[2]).toString('hex')}`;
  try {
    assertRscoreCheckpointCandidate(checkpoint, {
      revision: position.revision,
      accountsRoot: position.accountsRoot,
      accountCount: accounts.size,
    });
  } catch {
    halt('CHECKPOINT_CANDIDATE_MISMATCH', {
      owner,
      candidateRevision: position.revision,
      checkpointRevision: String(checkpoint.restoreToken[1]),
      candidateRoot: position.accountsRoot,
      checkpointRoot,
      typescriptRoot,
      checkpointCount: checkpoint.restoreToken[4],
      typescriptCount: accounts.size,
    });
  }
  if (position.accountsRoot.toLowerCase() !== typescriptRoot) {
    halt('CHECKPOINT_CANDIDATE_MISMATCH', {
      owner,
      candidateRevision: position.revision,
      checkpointRevision: String(checkpoint.restoreToken[1]),
      candidateRoot: position.accountsRoot,
      checkpointRoot,
      typescriptRoot,
      checkpointCount: checkpoint.restoreToken[4],
      typescriptCount: accounts.size,
    });
  }
};

/** Select a piggybacked export or explicitly checkpoint an idle accepted root. */
export const prepareAuthorityCheckpoint = async (
  env: RuntimeReplica,
): Promise<readonly AuthorityCheckpointStorageInput[]> => {
  if (!authorityDriverEnabled(env) || env.accountAuthorityCheckpointDue !== true) {
    return [];
  }
  const candidates = pending.get(env);
  if (candidates === undefined) return halt('CHECKPOINT_CANDIDATE_MISSING', {});
  const inputs: AuthorityCheckpointStorageInput[] = [];
  for (const candidate of [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId))) {
    if (candidate.entityInput !== null) {
      return halt('CHECKPOINT_ENTITY_INPUT_OPEN', { owner: candidate.session.ownerEntityId });
    }
    let checkpoint = candidate.checkpoints.get(candidate.acceptedAccountsRoot);
    if (checkpoint === undefined) {
      // An idle barrier has no Entity round to piggyback on, so it uses the
      // single canonical checkpoint export bound to the accepted forest root.
      if (candidate.latest === null) {
        const root = candidate.acceptedAccountsRoot;
        if (!/^0x[0-9a-f]{64}$/.test(root)) {
          return halt('CHECKPOINT_ACCEPTED_ROOT_INVALID', {
            owner: candidate.session.ownerEntityId,
            root,
          });
        }
        const exported = await candidate.session.client.exportCheckpoint(
          Buffer.from(root.slice(2), 'hex'),
        );
        candidate.checkpoints.set(root, exported);
        checkpoint = exported;
      }
    }
    if (checkpoint === undefined) {
      return halt('CHECKPOINT_ACCEPTED_ROOT_NOT_EXPORTED', {
        owner: candidate.session.ownerEntityId,
        acceptedRoot: candidate.acceptedAccountsRoot,
        exportedRoots: [...candidate.checkpoints.keys()].sort(),
      });
    }
    const position = {
      revision: checkpoint.restoreToken[1],
      accountsRoot: `0x${Buffer.from(checkpoint.restoreToken[2]).toString('hex')}`,
    };
    assertCheckpointMatchesCandidate(env, candidate, position, checkpoint);
    report.checkpointsPrepared += 1;
    inputs.push({
      ownerEntityId: candidate.session.ownerEntityId,
      protocolFingerprint,
      checkpoint,
    });
  }
  return inputs;
};

const checkpointTokensEqual = (
  left: RscoreCheckpointToken,
  right: RscoreCheckpointToken,
): boolean =>
  BigInt(left[0]) === BigInt(right[0]) &&
  BigInt(left[1]) === BigInt(right[1]) &&
  buffersEqual(Buffer.from(left[2]), Buffer.from(right[2])) &&
  buffersEqual(Buffer.from(left[3]), Buffer.from(right[3])) &&
  left[4] === right[4];

type DecodedCheckpointAccount = ReturnType<typeof decodeRscoreAccountRestoreRow>;

const checkpointForestRoot = (accounts: readonly DecodedCheckpointAccount[]): string =>
  PersistentRadixValueMap.fromMap(
    accounts.map(account => [account.accountId, account.entityAccountLeaf] as const),
    {
      radix: 16,
      ownKey: accountId => accountId.toLowerCase(),
      keyBytes: accountId => Buffer.from(accountId.slice(2), 'hex'),
      valueHash: leaf => leaf,
      ownValue: leaf => leaf,
    },
  ).rootHash();

const checkpointSignerDigest = (accounts: readonly DecodedCheckpointAccount[]): Buffer => {
  const digest = createHash('sha256').update('xln.rscore.signer-config.v1');
  for (const account of [...accounts].sort((left, right) => left.accountId.localeCompare(right.accountId))) {
    const signerId = account.stateSeed.signerId;
    const length = Buffer.alloc(4);
    length.writeUInt32BE(Buffer.byteLength(signerId));
    digest
      .update(Buffer.from(account.accountId.slice(2), 'hex'))
      .update(Buffer.from(account.stateSeed.ownerEntityId.slice(2), 'hex'))
      .update(length)
      .update(signerId);
  }
  return digest.digest();
};

const validateMaterializedCheckpointRows = (
  owner: string,
  checkpoint: RscoreExactCheckpoint,
): void => {
  const accounts = checkpoint.accounts.map(decodeRscoreAccountRestoreRow);
  if (accounts.some(account => account.stateSeed.ownerEntityId !== owner)) {
    halt('CHECKPOINT_MATERIALIZATION_ACCOUNT_OWNER', { owner });
  }
  const ids = accounts.map(account => account.accountId);
  const outOfOrder = ids.some((id, index) => {
    const previous = ids[index - 1];
    return previous !== undefined && previous >= id;
  });
  if (new Set(ids).size !== ids.length || outOfOrder) {
    halt('CHECKPOINT_MATERIALIZATION_ACCOUNT_ORDER', { owner, ids });
  }
  const root = checkpointForestRoot(accounts);
  const expectedRoot = exactCheckpointRoot(checkpoint);
  const signerDigest = checkpointSignerDigest(accounts);
  if (
    root !== expectedRoot ||
    accounts.length !== checkpoint.restoreToken[4] ||
    !buffersEqual(signerDigest, Buffer.from(checkpoint.restoreToken[3]))
  ) {
    halt('CHECKPOINT_MATERIALIZATION_CONTENT_MISMATCH', {
      owner,
      root,
      expectedRoot,
      count: accounts.length,
      expectedCount: checkpoint.restoreToken[4],
      signerDigest: `0x${signerDigest.toString('hex')}`,
      expectedSignerDigest: `0x${Buffer.from(checkpoint.restoreToken[3]).toString('hex')}`,
    });
  }
};

/** Re-read and independently hash the planned physical overlay before WAL. */
export const validateAuthorityCheckpointMaterialization = (
  env: RuntimeReplica,
  checkpoints: readonly RscoreExactCheckpoint[],
): Promise<void> => {
  if (!authorityDriverEnabled(env)) return Promise.resolve();
  const expected = new Map(
    (pending.get(env) ?? [])
      .map(candidate => {
        const checkpoint = candidate.checkpoints.get(candidate.acceptedAccountsRoot);
        return checkpoint === undefined
          ? null
          : [candidate.session.ownerEntityId, { candidate, checkpoint }] as const;
      })
      .filter((entry): entry is Exclude<typeof entry, null> => entry !== null),
  );
  const ordered = [...checkpoints]
    .sort((left, right) => left.ownerEntityId.localeCompare(right.ownerEntityId));
  if (ordered.length !== expected.size) {
    halt('CHECKPOINT_MATERIALIZATION_OWNER_COUNT', {
      expected: [...expected.keys()].sort(),
      actual: ordered.map(checkpoint => checkpoint.ownerEntityId),
    });
  }
  const seen = new Set<string>();
  for (const checkpoint of ordered) {
    const owner = checkpoint.ownerEntityId.trim().toLowerCase();
    const expectedEntry = expected.get(owner);
    if (
      seen.has(owner) ||
      expectedEntry === undefined ||
      checkpoint.protocolFingerprint.toLowerCase() !== protocolFingerprint ||
      !checkpointTokensEqual(
        checkpoint.restoreToken,
        expectedEntry.checkpoint.restoreToken,
      )
    ) {
      halt('CHECKPOINT_MATERIALIZATION_IDENTITY_MISMATCH', {
        owner,
        duplicate: seen.has(owner),
        expectedOwner: expectedEntry?.candidate.session.ownerEntityId ?? null,
        expectedRevision: expectedEntry === undefined
          ? null
          : String(expectedEntry.checkpoint.restoreToken[1]),
        actualRevision: String(checkpoint.restoreToken[1]),
      });
    }
    seen.add(owner);
    validateMaterializedCheckpointRows(owner, checkpoint);
    report.checkpointValidations += 1;
  }
  return Promise.resolve();
};

/** The Runtime's own record is durable: release only TS-side frame bookkeeping. */
export const finalizeAuthorityFrameAfterWal = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const candidates = pending.get(env);
  if (candidates === undefined) return;
  const ordered = [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId));
  for (const candidate of ordered) {
    if (candidate.entityInput !== null) {
      return halt('COMMIT_ENTITY_INPUT_OPEN', { owner: candidate.session.ownerEntityId });
    }
    const typescriptRoot = accountMapRoot(
      accountsOf(env, candidate.session.ownerEntityId),
      candidate.session.ownerEntityId,
    );
    if (candidate.acceptedAccountsRoot !== typescriptRoot) {
      halt('COMMIT_ROOT_MISMATCH', {
        owner: candidate.session.ownerEntityId,
        engineRevision: candidate.latest?.revision ?? null,
        engineRoot: candidate.latest?.accountsRoot ?? null,
        accepted: candidate.acceptedAccountsRoot,
        typescriptRoot,
      });
    }
    report.finalizedFrames += 1;
    if (env.accountAuthorityCheckpointDue === true) {
      candidate.session.bootstrapCheckpoint = null;
    }
  }
  pending.delete(env);
  arrivalCursors.delete(env);
  delete env.accountAuthorityCheckpointDue;
};

/** A failed durable write after Account or checkpoint-cursor advance is a mandatory restart. */
export const failStopAuthorityFrame = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const candidates = pending.get(env);
  if (candidates === undefined) return;
  const mutated = candidates.filter(candidate =>
    candidate.latest !== null ||
    candidate.entityInput !== null ||
    candidate.checkpoints.size > 0,
  );
  if (mutated.length > 0) {
    report.failStops += 1;
    const owners = mutated.map(candidate => candidate.session.ownerEntityId).sort();
    killAuthorityRuntime(env);
    halt('WAL_FAILED_AFTER_ACCOUNT_MUTATION', { owners });
  }
  pending.delete(env);
  arrivalCursors.delete(env);
  delete env.accountAuthorityCheckpointDue;
};

export const printAuthorityDriverReport = (): void => {
  if (!authorityDriverEnabled()) return;
  console.error(`RSCORE_AUTHORITY_DRIVER ${safeStringify(authorityDriverReport())}`);
};

export const discardAuthorityRuntime = async (env: RuntimeReplica): Promise<void> => {
  killAuthorityRuntime(env);
  delete env.accountAuthorityFrameId;
};

export const shutdownAuthorityDriver = async (): Promise<void> => {
  for (const session of allSessions) {
    try { await session.client.shutdown(); } catch { session.client.kill(); }
  }
  allSessions.clear();
  sessions.clear();
  captured.clear();
  pending.clear();
  arrivalCursors.clear();
};
