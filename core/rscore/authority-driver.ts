/**
 * The Rust engine as the authority for one Entity's accounts, inside a real
 * Runtime frame.
 *
 * The mirror follows TypeScript. This does not: it is handed the same raw
 * inputs, in the same order, with the same clocks, and must reach the same
 * frames on its own. Safe mode, which is the only mode there is today:
 * TypeScript still executes and still decides, and every disagreement halts
 * the Runtime rather than being repaired quietly.
 *
 * Order inside a frame, and the reason for it:
 *
 *   collect raw wave  — while TypeScript applies it
 *   PrepareAccountWave — the engine reaches its own result, kept as candidate
 *   parity             — leaf by leaf, proposal by proposal, against TypeScript
 *   Runtime WAL fsync  — TypeScript's own record becomes durable
 *   Commit             — only now does the engine keep the wave
 *
 * A commit before the WAL would leave the engine ahead of the log after a
 * crash; an abort after it would leave it behind. The candidate exists so the
 * window between them is the only place either can happen, and it is closed by
 * one call.
 */

import { createHash } from 'node:crypto';

import { createStructuredLogger } from '../support/logger';
import { getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { computeFrameHash, getAccountFrameStructuralError } from '../account/consensus/frame/hash';
import { generateLazyEntityId } from '../entity/factory';
import {
  computeEntityAccountLeafDigest,
  computeEntityAccountValueHash,
  projectEntityAccountLeaf,
} from '../entity/consensus/state-root';
import { computeAccountStateRoot } from '../account/commitment/state-root';
import { getEntityReplicaById } from '../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../account/state/account-lookup';
import {
  buildAuthorityWave,
  describeAuthorityWaveOperation,
  type AuthorityWave,
  type AuthorityWaveOperation,
} from './authority-wave';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from './shadow-wire';
import { requireAccountDeltaTransformerAddress } from '../account/consensus/helpers';
import { waveOutputRow, type Wave } from './wave-decode';
import { cutoverAccountInputEvents } from './cutover/execute';
import type { RscoreAccountCheckpointRow } from './checkpoint/wave-checkpoint-decode';
import type { ShadowOutputRow } from './shadow-wire';
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
import { assertRscoreCheckpointCandidate } from './checkpoint/checkpoint-wire';
import type { AccountFrame, AccountReplica } from '../types/account';
import type { RoutedEntityInput, RuntimeReplica } from '../runtime/types';
import { buffersEqual, safeStringify } from '../protocol/serialization';
import { encodeCanonicalConsensusBytes } from '../protocol/serialization/binary-codec';
import { verifyHankoForHash } from '../hanko/signing';
import type { AccountAuthorityEntityOccurrence } from './authority/entity-stage';

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
  /**
   * Accounts a declared import could not express, so the engine's forest is
   * knowingly a subset of TypeScript's. Their whole-tree roots cannot agree
   * while this is nonzero; every imported Account's own leaf still must.
   */
  importRefused: number;
  /** Exact ids a declared import could not express, so membership excludes them. */
  importSkipped: Set<string>;
  /** Membership committed by Create or proven by RestoreExact. */
  seeded: Set<string>;
  /**
   * The leaf projection each account was seeded with. The engine carries the
   * fields it does not own itself, so when a leaf disagrees the first question
   * is which carried field this frame moved underneath it.
   */
  seededProjection: Map<string, Record<string, unknown>>;
};

type OpenAuthorityEntityStage = {
  handle: AuthorityEntityStageHandle;
  priorResult: Wave;
  latestResult: Wave;
  /**
   * Present only in cutover, where the stage is opened before TypeScript would
   * have executed and then grows one operation at a time. The handle the
   * Runtime accepts is built from this once the Entity input is done.
   */
  cutover?: CutoverStageState;
};

/** What one cutover stage has staged so far, in submission order. */
type CutoverStageState = {
  stageKey: Buffer;
  expectedAcceptedOrdinal: number;
  nextOperationIndex: number;
  operations: AuthorityWaveOperation[];
  createdAccounts: string[];
  payloadCursor: number;
  clock: Readonly<{
    timestamp: number;
    jHeight: number;
    entityTimestamp: number;
    finalizedJHeight: number;
  }>;
};

type PendingWave = {
  session: Session;
  token: Buffer;
  /** Latest cumulative candidate view; final only once sealed. */
  result: Wave;
  sealed: boolean;
  acceptedStageOrdinal: number;
  nextOperationIndex: number;
  operations: AuthorityWaveOperation[];
  expectedOutputs: Map<string, ShadowOutputRow[]>;
  /**
   * True once this candidate executed an operation authoritatively. There is
   * then no TypeScript output list to compare against — the engine's is the
   * only one — so publishing it is the whole answer.
   */
  cutover: boolean;
  openStage: OpenAuthorityEntityStage | null;
  /** Candidate-created membership promoted only after the Runtime WAL and Rust commit. */
  createdAccounts: string[];
  checkpoint?: RscoreCheckpointChanges;
};

/** Runtime-envelope handle for one still-abortable parent Entity transition. */
export type AuthorityEntityStageHandle = Readonly<{
  ownerEntityId: string;
  stageKey: Buffer;
  expectedAcceptedOrdinal: number;
  nextOperationIndex: number;
  operations: readonly AuthorityWaveOperation[];
  expectedOutputs: ReadonlyMap<string, readonly ShadowOutputRow[]>;
  createdAccounts: readonly string[];
}>;

export type AuthorityEntityStageInput = Readonly<{
  collectorFrameId: string | null;
  ownerEntityId: string;
  occurrence: AccountAuthorityEntityOccurrence;
  appliedInput: RoutedEntityInput;
  trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
  deferProposal: boolean;
  requiredEntityTxIndex?: number;
  fallbackTimestamp: number;
  fallbackFinalizedJHeight: number;
}>;

export type AuthorityCheckpointStorageInput = Readonly<{
  ownerEntityId: string;
  protocolFingerprint: string;
  checkpoint: RscoreCheckpointChanges;
}>;

/**
 * One session per Entity that holds accounts, keyed by Runtime object identity
 * and then Entity id: the
 * engine signs as one board, and a Runtime hosts more than one Entity — a hub
 * and its book live side by side in the H1 Runtime.
 */
const sessions = new Map<RuntimeReplica, Map<string, Session | 'disabled'>>();
const allSessions = new Set<Session>();
const captured = new Map<RuntimeReplica, AuthorityWave>();
/** Candidates open in each Entity's engine, by Runtime. */
const pending = new Map<RuntimeReplica, PendingWave[]>();
/** Original Account-operation arrival cursor for the active Runtime frame. */
const arrivalCursors = new Map<RuntimeReplica, number>();

const report = {
  waves: 0,
  framesProposed: 0,
  inputsApplied: 0,
  leavesChecked: 0,
  outputsChecked: 0,
  accountsSeeded: 0,
  emptyFrames: 0,
  commits: 0,
  aborts: 0,
  checkpointsPrepared: 0,
  checkpointValidations: 0,
  checkpointsCommitted: 0,
  restores: 0,
};

const authorityDriverReport = (): typeof report => ({ ...report });

/** A halt, not a warning: in safe mode the two engines must agree exactly. */
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
    ?? new URL('../../rscore/target/release/xln-rscore', import.meta.url).pathname;
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
    importRefused: 0,
    importSkipped: new Set(),
    seeded: new Set(),
    seededProjection: new Map(),
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
  const seeds: RscoreWireValue[] = [];
  const refused: Record<string, string> = {};
  for (const [counterpartyId, account] of [...accounts].sort(([left], [right]) =>
    (left < right ? -1 : left > right ? 1 : 0))) {
    try {
      seeds.push(accountSeedWire(
        session.ownerEntityId,
        counterpartyId,
        account.state,
        accountEnvelopeWire(account),
        accountConsensusWire(account),
        requireAccountDeltaTransformerAddress(env.state, account.state),
      ));
    } catch (error) {
      // An Account carrying something outside this profile — a cross-j pull in
      // flight, say — cannot be expressed to the engine. It is left out and
      // named, never quietly approximated: the first operation that touches it
      // halts as unseeded rather than executing against a state nobody built.
      refused[counterpartyId] = error instanceof Error ? error.message : String(error);
      session.importSkipped.add(counterpartyId);
      continue;
    }
    session.seeded.add(counterpartyId);
    session.seededProjection.set(counterpartyId, projectEntityAccountLeaf(account));
  }
  session.importRefused = Object.keys(refused).length;
  await session.client.bootstrapAccounts(0, seeds, true);
  authorityLog.error('authority.imported', {
    owner: session.ownerEntityId,
    accounts: seeds.length,
    refused,
  });
  console.error(
    `RSCORE_AUTHORITY_IMPORT ${session.ownerEntityId} accounts=${seeds.length}`
    + ` refused=${Object.keys(refused).length}`,
  );
  report.accountsSeeded += seeds.length;
};

const armSession = async (env: RuntimeReplica, ownerEntityId: string): Promise<Session | 'disabled'> => {
  const session = await openAuthoritySession(env, ownerEntityId);
  if (session === 'disabled') return session;
  const accounts = accountsOf(env, ownerEntityId);
  if (accounts.size !== 0 && authorityImportEnabled()) {
    await importAccountsFromTypescript(env, session, accounts);
    return session;
  }
  if (accounts.size !== 0) {
    session.client.kill();
    return halt('AUTHORITY_EXACT_RESTORE_REQUIRED', {
      owner: ownerEntityId,
      accountCount: accounts.size,
    });
  }
  await session.client.bootstrapAccounts(0, []);
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
export const armAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
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
    // Accounts a declared import refused are known-absent, not missing: the
    // engine was told about the gap and any operation touching one halts.
    const actual = new Set([...replica.state.accounts.keys()]
      .filter(accountId => !existing.importSkipped.has(accountId)));
    const missing = [...actual].filter(accountId => !existing.seeded.has(accountId)).sort();
    const removed = [...existing.seeded].filter(accountId => !actual.has(accountId)).sort();
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
  const candidates: PendingWave[] = [];
  pending.set(env, candidates);
  arrivalCursors.set(env, 0);
  try {
    for (const session of sessionEntriesForRuntime(env)) {
      candidates.push(await openTrackedCandidate(env, session));
    }
  } catch (error) {
    const abortErrors: unknown[] = [];
    for (const candidate of candidates) {
      try {
        await candidate.session.client.abort(candidate.token);
        report.aborts += 1;
      } catch (abortError) {
        candidate.session.client.kill();
        abortErrors.push(abortError);
      }
    }
    pending.delete(env);
    arrivalCursors.delete(env);
    if (abortErrors.length > 0) {
      throw new AggregateError(
        [error, ...abortErrors],
        'RSCORE_AUTHORITY_FRAME_OPEN_ABORT_FAILED',
      );
    }
    throw error;
  }
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
      session.seeded = new Set(restoredAccounts.keys());
      session.seededProjection = new Map(
        [...restoredAccounts.entries()].map(([counterpartyId, account]) => [
          counterpartyId,
          projectEntityAccountLeaf(account),
        ]),
      );
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

const openTrackedCandidate = async (
  env: RuntimeReplica,
  session: Session,
): Promise<PendingWave> => {
  let prepared: Awaited<ReturnType<RscoreProcessClient['prepareAccountWave']>>;
  try {
    // Prepare only allocates the Runtime-frame candidate. Every mutation is
    // subsequently owned by one abortable parent-Entity stage.
    prepared = await session.client.prepareAccountWave({ entities: [] });
  } catch (error) {
    session.client.kill();
    throw error;
  }
  try {
    await compareWithTypescript(
      env,
      session.ownerEntityId,
      prepared.result,
      new Map(),
      session,
    );
    return {
      session,
      token: prepared.token,
      result: prepared.result,
      sealed: false,
      acceptedStageOrdinal: 0,
      nextOperationIndex: 0,
      operations: [],
      expectedOutputs: new Map(),
      cutover: false,
      openStage: null,
      createdAccounts: [],
    };
  } catch (error) {
    try {
      await session.client.abort(prepared.token);
      report.aborts += 1;
    } catch (abortError) {
      session.client.kill();
      throw new AggregateError(
        [error, abortError],
        `RSCORE_AUTHORITY_CANDIDATE_OPEN_ABORT_FAILED:${session.ownerEntityId}`,
      );
    }
    throw error;
  }
};

const u64be = (value: number, label: string): Buffer => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label}:${String(value)}`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
};

const authorityOccurrenceBytes = (
  occurrence: AccountAuthorityEntityOccurrence,
): Buffer => {
  const value = occurrence.kind === 'runtime-input' ? occurrence.inputIndex : occurrence.ordinal;
  const bytes = Buffer.alloc(9);
  bytes[0] = occurrence.kind === 'runtime-input' ? 0 : 1;
  u64be(value, 'RSCORE_AUTHORITY_STAGE_OCCURRENCE').copy(bytes, 1);
  return bytes;
};

/** Exact retry-stable identity of one parent Entity transition savepoint. */
export const deriveAuthorityEntityStageKey = (
  runtimeId: string,
  ownerEntityId: string,
  acceptedStageOrdinal: number,
  occurrence: AccountAuthorityEntityOccurrence,
  appliedInput: RoutedEntityInput,
  trustedLocalRuntimeProtocol: 'cross-j' | 'account-work' | undefined,
  deferProposal: boolean,
  requiredEntityTxIndex: number | undefined,
): Buffer => createHash('sha256')
  .update('xln.rscore.entity-input-stage.v2', 'utf8')
  .update(Buffer.from([0]))
  .update(Buffer.from(hexToWireBytes(runtimeId, 20, 'AUTHORITY_STAGE_RUNTIME_ID')))
  .update(Buffer.from(hexToWireBytes(ownerEntityId, 32, 'AUTHORITY_STAGE_OWNER_ID')))
  .update(u64be(acceptedStageOrdinal, 'RSCORE_AUTHORITY_STAGE_ORDINAL'))
  .update(authorityOccurrenceBytes(occurrence))
  .update(Buffer.from(encodeCanonicalConsensusBytes([
    appliedInput,
    trustedLocalRuntimeProtocol ?? null,
    deferProposal,
    requiredEntityTxIndex ?? null,
  ])))
  .digest();

const candidateForOwner = (
  env: RuntimeReplica,
  ownerEntityId: string,
): PendingWave | undefined => (pending.get(env) ?? [])
  .find(candidate => candidate.session.ownerEntityId === ownerEntityId);

const mergeExpectedOutputs = (
  target: Map<string, ShadowOutputRow[]>,
  source: ReadonlyMap<string, readonly ShadowOutputRow[]>,
): void => {
  for (const [accountId, rows] of source) {
    const current = target.get(accountId) ?? [];
    current.push(...rows);
    target.set(accountId, current);
  }
};

const entityOfStageWave = (
  ownerEntityId: string,
  wave: AuthorityWave,
): Extract<AuthorityWave, { kind: 'wave' }>['entities'][number] => {
  if (wave.kind === 'ineligible') {
    return halt('ENTITY_STAGE_INELIGIBLE', { owner: ownerEntityId, reason: wave.reason });
  }
  if (wave.kind !== 'wave' || wave.entities.length !== 1) {
    return halt('ENTITY_STAGE_ARITY', {
      owner: ownerEntityId,
      kind: wave.kind,
      entities: wave.kind === 'wave' ? wave.entities.map(entity => entity.ownerEntityId) : [],
    });
  }
  const entity = wave.entities[0];
  if (entity === undefined || entity.ownerEntityId !== ownerEntityId) {
    return halt('ENTITY_STAGE_OWNER', {
      owner: ownerEntityId,
      actual: entity?.ownerEntityId ?? null,
    });
  }
  assertAuthorityWaveOperationLedger(wave);
  return entity;
};

/**
 * Replay the Account work observed while TypeScript evaluated one EntityInput
 * into its exact Rust savepoint. The caller owns accept/discard after deciding
 * whether the parent Entity transition commits.
 */
export const stageAuthorityEntityInput = async (
  env: RuntimeReplica,
  input: AuthorityEntityStageInput,
): Promise<AuthorityEntityStageHandle | null> => {
  if (!authorityDriverEnabled(env)) return null;
  const ownerEntityId = input.ownerEntityId.trim().toLowerCase();
  const candidate = candidateForOwner(env, ownerEntityId);
  if (input.collectorFrameId === null) {
    return halt('ENTITY_STAGE_COLLECTOR_MISSING', { owner: ownerEntityId });
  }
  if (candidate === undefined) {
    const unowned = buildAuthorityWave(input.collectorFrameId);
    if (unowned.kind === 'empty') return null;
    return halt('ENTITY_STAGE_OWNER_UNARMED', { owner: ownerEntityId, kind: unowned.kind });
  }
  if (candidate.sealed || candidate.openStage !== null) {
    return halt('ENTITY_STAGE_CANDIDATE_STATE', {
      owner: ownerEntityId,
      sealed: candidate.sealed,
      open: candidate.openStage?.handle.stageKey.toString('hex') ?? null,
    });
  }
  const wave = buildAuthorityWave(input.collectorFrameId, {
    operationIndexStart: candidate.nextOperationIndex,
    arrivalIndexStart: arrivalCursors.get(env) ?? 0,
    fallbackEntity: {
      ownerEntityId,
      timestamp: input.fallbackTimestamp,
      finalizedJHeight: input.fallbackFinalizedJHeight,
    },
  });
  const entity = entityOfStageWave(ownerEntityId, wave);
  arrivalCursors.set(
    env,
    (arrivalCursors.get(env) ?? 0) + entity.operations.length,
  );
  const visibleAccounts = new Set([
    ...candidate.session.seeded,
    ...candidate.createdAccounts,
  ]);
  const createdAccounts = deriveAuthorityCandidateCreates(
    ownerEntityId,
    visibleAccounts,
    entity.ops,
  );
  const runtimeId = String(env.runtimeId ?? '');
  const stageKey = deriveAuthorityEntityStageKey(
    runtimeId,
    ownerEntityId,
    candidate.acceptedStageOrdinal,
    input.occurrence,
    input.appliedInput,
    input.trustedLocalRuntimeProtocol,
    input.deferProposal,
    input.requiredEntityTxIndex,
  );
  const ownerBytes = hexToWireBytes(ownerEntityId, 32, 'AUTHORITY_STAGE_OWNER');
  const priorResult = candidate.result;
  let latestResult = priorResult;
  try {
    const opened = await candidate.session.client.beginEntityStage(
      candidate.token,
      stageKey,
      candidate.acceptedStageOrdinal,
      {
        ownerEntityId: ownerBytes,
        timestamp: entity.timestamp,
        jHeight: entity.jHeight,
        entityTimestamp: entity.entityTimestamp,
        finalizedJHeight: entity.finalizedJHeight,
        propose: entity.propose,
      },
    );
    const openedRoot = `0x${opened.accountsRoot.toString('hex')}`.toLowerCase();
    if (
      opened.revision !== priorResult.revision
      || openedRoot !== priorResult.accountsRoot.toLowerCase()
    ) {
      return halt('ENTITY_STAGE_BEGIN_STATE', {
        owner: ownerEntityId,
        expectedRevision: priorResult.revision,
        actualRevision: opened.revision,
        expectedRoot: priorResult.accountsRoot,
        actualRoot: openedRoot,
      });
    }
    if (entity.ops.length > 0) {
      latestResult = await candidate.session.client.applyAccountWave(
        candidate.token,
        stageKey,
        { entities: [{ ownerEntityId: ownerBytes, ops: entity.ops }] },
      );
      // Apply returns the step-local admission/peer verdict rows. Propose is a
      // distinct step and intentionally returns none of those rows, so bind
      // parity before advancing to it while retaining the later root as the
      // stage's terminal candidate view.
      assertAuthorityStageVerdictParity(
        ownerEntityId,
        stageKey,
        entity.operations,
        latestResult,
      );
    }
    if (entity.proposalAccountIds.length > 0) {
      latestResult = await candidate.session.client.proposeAccountWave(
        candidate.token,
        stageKey,
        {
          entities: [{
            ownerEntityId: ownerBytes,
            accountIds: entity.proposalAccountIds.map(accountId =>
              hexToWireBytes(accountId, 32, 'AUTHORITY_PROPOSAL_ACCOUNT')),
          }],
        },
      );
      assertAuthorityStageProposalParity(
        ownerEntityId,
        stageKey,
        entity.expectedProposals,
        latestResult,
      );
    }
  } catch (error) {
    try {
      await candidate.session.client.discardEntityStage(
        candidate.token,
        stageKey,
        candidate.acceptedStageOrdinal,
      );
    } catch (discardError) {
      candidate.session.client.kill();
      throw new AggregateError(
        [error, discardError],
        `RSCORE_AUTHORITY_ENTITY_STAGE_ABORT_FAILED:${ownerEntityId}`,
      );
    }
    throw error;
  }
  const handle: AuthorityEntityStageHandle = {
    ownerEntityId,
    stageKey,
    expectedAcceptedOrdinal: candidate.acceptedStageOrdinal,
    nextOperationIndex: candidate.nextOperationIndex + entity.operations.length,
    operations: [...entity.operations],
    expectedOutputs: new Map(
      [...entity.expectedOutputs].map(([accountId, rows]) => [accountId, [...rows]]),
    ),
    createdAccounts: [...createdAccounts],
  };
  candidate.openStage = { handle, priorResult, latestResult };
  return handle;
};

/**
 * One Account operation the Rust authority performs *instead of* TypeScript.
 *
 * The parity driver stages a whole Entity input after TypeScript executed it
 * and compares. Cutover cannot: there is no TypeScript result to compare
 * against, because TypeScript never runs the transition. So the stage opens on
 * the first operation and grows one operation at a time, and every operation
 * answers with the exact post-state row the caller materializes.
 */
export type AuthorityCutoverOperation =
  | Readonly<{
      kind: 'applyAccountInput';
      ownerEntityId: string;
      accountId: string;
      collectorFrameId: string;
      timestamp: number;
      jHeight: number;
      entityTimestamp: number;
      finalizedJHeight: number;
      occurrence: AccountAuthorityEntityOccurrence;
      appliedInput: RoutedEntityInput;
      trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
      deferProposal: boolean;
      requiredEntityTxIndex?: number;
    }>
  | Readonly<{
      kind: 'proposeAccountFrame';
      ownerEntityId: string;
      accountId: string;
      collectorFrameId: string;
      timestamp: number;
      jHeight: number;
      entityTimestamp: number;
      finalizedJHeight: number;
      occurrence: AccountAuthorityEntityOccurrence;
      appliedInput: RoutedEntityInput;
      trustedLocalRuntimeProtocol?: 'cross-j' | 'account-work';
      deferProposal: boolean;
      requiredEntityTxIndex?: number;
    }>;

export type AuthorityCutoverResult = Readonly<{
  wave: Wave;
  /** Exact post-state row for the operation's own Account, when it moved. */
  row: RscoreAccountCheckpointRow | null;
}>;

/** The stage this cutover Entity input opened, if it opened one. */
export const authorityCutoverStageHandle = (
  env: RuntimeReplica,
  ownerEntityId: string,
): AuthorityEntityStageHandle | null => {
  const candidate = candidateForOwner(env, ownerEntityId.trim().toLowerCase());
  const open = candidate?.openStage;
  if (candidate === undefined || open == null || open.cutover === undefined) return null;
  const state = open.cutover;
  const handle: AuthorityEntityStageHandle = {
    ownerEntityId: candidate.session.ownerEntityId,
    stageKey: state.stageKey,
    expectedAcceptedOrdinal: state.expectedAcceptedOrdinal,
    nextOperationIndex: state.nextOperationIndex,
    operations: [...state.operations],
    // Cutover has no TypeScript outputs to expect: the engine's are the only
    // ones, and they are published from its own verdicts.
    expectedOutputs: new Map(),
    createdAccounts: [...state.createdAccounts],
  };
  open.handle = handle;
  return handle;
};

const openCutoverStage = async (
  env: RuntimeReplica,
  candidate: PendingWave,
  operation: AuthorityCutoverOperation,
): Promise<OpenAuthorityEntityStage> => {
  const existing = candidate.openStage;
  if (existing !== null) {
    const state = existing.cutover;
    if (state === undefined) {
      return halt('CUTOVER_STAGE_NOT_CUTOVER', { owner: operation.ownerEntityId });
    }
    // One Entity input signs with one clock. A second clock inside the same
    // stage would stamp part of its work with a clock the Entity never used.
    if (
      state.clock.entityTimestamp !== operation.entityTimestamp
      || state.clock.finalizedJHeight !== operation.finalizedJHeight
      || (operation.kind === 'proposeAccountFrame'
        && (state.clock.timestamp !== operation.timestamp
          || state.clock.jHeight !== operation.jHeight))
    ) {
      return halt('CUTOVER_STAGE_CLOCK_CONFLICT', {
        owner: operation.ownerEntityId,
        stage: state.clock,
        operation: {
          kind: operation.kind,
          timestamp: operation.timestamp,
          jHeight: operation.jHeight,
          entityTimestamp: operation.entityTimestamp,
          finalizedJHeight: operation.finalizedJHeight,
        },
      });
    }
    return existing;
  }
  const runtimeId = String(env.runtimeId ?? '');
  const stageKey = deriveAuthorityEntityStageKey(
    runtimeId,
    candidate.session.ownerEntityId,
    candidate.acceptedStageOrdinal,
    operation.occurrence,
    operation.appliedInput,
    operation.trustedLocalRuntimeProtocol,
    operation.deferProposal,
    operation.requiredEntityTxIndex,
  );
  const opened = await candidate.session.client.beginEntityStage(
    candidate.token,
    stageKey,
    candidate.acceptedStageOrdinal,
    {
      ownerEntityId: hexToWireBytes(
        candidate.session.ownerEntityId,
        32,
        'AUTHORITY_STAGE_OWNER',
      ),
      timestamp: operation.timestamp,
      jHeight: operation.jHeight,
      entityTimestamp: operation.entityTimestamp,
      finalizedJHeight: operation.finalizedJHeight,
      // Every cutover stage may propose: the Entity worklist decides per
      // Account, and the engine refuses a proposal it has no clock for.
      propose: true,
    },
  );
  const openedRoot = `0x${opened.accountsRoot.toString('hex')}`.toLowerCase();
  if (
    opened.revision !== candidate.result.revision
    || openedRoot !== candidate.result.accountsRoot.toLowerCase()
  ) {
    return halt('CUTOVER_STAGE_BEGIN_STATE', {
      owner: candidate.session.ownerEntityId,
      expectedRevision: candidate.result.revision,
      actualRevision: opened.revision,
      expectedRoot: candidate.result.accountsRoot,
      actualRoot: openedRoot,
    });
  }
  candidate.cutover = true;
  const state: CutoverStageState = {
    stageKey,
    expectedAcceptedOrdinal: candidate.acceptedStageOrdinal,
    nextOperationIndex: candidate.nextOperationIndex,
    operations: [],
    createdAccounts: [],
    payloadCursor: 0,
    clock: {
      timestamp: operation.timestamp,
      jHeight: operation.jHeight,
      entityTimestamp: operation.entityTimestamp,
      finalizedJHeight: operation.finalizedJHeight,
    },
  };
  const open: OpenAuthorityEntityStage = {
    handle: {
      ownerEntityId: candidate.session.ownerEntityId,
      stageKey,
      expectedAcceptedOrdinal: candidate.acceptedStageOrdinal,
      nextOperationIndex: candidate.nextOperationIndex,
      operations: [],
      expectedOutputs: new Map(),
      createdAccounts: [],
    },
    priorResult: candidate.result,
    latestResult: candidate.result,
    cutover: state,
  };
  candidate.openStage = open;
  return open;
};

/**
 * Perform one Account operation in Rust and hand back its exact post-state.
 * The caller materializes the row into the canonical TypeScript replica; the
 * engine's execution is the only one that happened.
 */
export const runAuthorityCutoverOperation = async (
  env: RuntimeReplica,
  operation: AuthorityCutoverOperation,
): Promise<AuthorityCutoverResult | null> => {
  if (!authorityDriverEnabled(env)) return null;
  const ownerEntityId = operation.ownerEntityId.trim().toLowerCase();
  const accountId = operation.accountId.trim().toLowerCase();
  const candidate = candidateForOwner(env, ownerEntityId);
  if (candidate === undefined) return null;
  if (candidate.sealed) {
    return halt('CUTOVER_CANDIDATE_SEALED', { owner: ownerEntityId });
  }
  const open = await openCutoverStage(env, candidate, operation);
  const state = open.cutover;
  if (state === undefined) return halt('CUTOVER_STAGE_MISSING', { owner: ownerEntityId });
  const ownerBytes = hexToWireBytes(ownerEntityId, 32, 'AUTHORITY_STAGE_OWNER');
  let result: Wave;
  if (operation.kind === 'applyAccountInput') {
    const wave = buildAuthorityWave(operation.collectorFrameId, {
      operationIndexStart: state.nextOperationIndex,
      arrivalIndexStart: arrivalCursors.get(env) ?? 0,
      payloadSkip: state.payloadCursor,
      expectations: 'absent',
      fallbackEntity: {
        ownerEntityId,
        timestamp: operation.entityTimestamp,
        finalizedJHeight: operation.finalizedJHeight,
      },
    });
    if (wave.kind === 'ineligible') {
      return halt('CUTOVER_WAVE_INELIGIBLE', { owner: ownerEntityId, reason: wave.reason });
    }
    if (wave.kind === 'empty') {
      return halt('CUTOVER_WAVE_EMPTY', { owner: ownerEntityId, account: accountId });
    }
    const entity = entityOfStageWave(ownerEntityId, wave);
    if (entity.ops.length === 0) {
      return halt('CUTOVER_WAVE_NO_OPERATION', { owner: ownerEntityId, account: accountId });
    }
    state.payloadCursor += entity.ops.length;
    arrivalCursors.set(env, (arrivalCursors.get(env) ?? 0) + entity.operations.length);
    result = await candidate.session.client.applyAccountWave(
      candidate.token,
      state.stageKey,
      { entities: [{ ownerEntityId: ownerBytes, ops: entity.ops }] },
    );
    state.operations.push(...entity.operations);
    state.nextOperationIndex += entity.operations.length;
    state.createdAccounts.push(...deriveAuthorityCandidateCreates(
      ownerEntityId,
      new Set([...candidate.session.seeded, ...candidate.createdAccounts, ...state.createdAccounts]),
      entity.ops,
    ));
    report.inputsApplied += result.applied.length;
  } else {
    result = await candidate.session.client.proposeAccountWave(
      candidate.token,
      state.stageKey,
      {
        entities: [{
          ownerEntityId: ownerBytes,
          accountIds: [hexToWireBytes(accountId, 32, 'AUTHORITY_PROPOSAL_ACCOUNT')],
        }],
      },
    );
    report.framesProposed += result.proposals.filter(row => row.frame !== null).length;
  }
  open.latestResult = result;
  report.waves += 1;
  const row = result.postAccounts.find(candidateRow => candidateRow.accountId === accountId) ?? null;
  return { wave: result, row };
};

const requireOpenStage = (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle,
): Readonly<{ candidate: PendingWave; open: OpenAuthorityEntityStage }> => {
  const candidate = candidateForOwner(env, handle.ownerEntityId);
  const open = candidate?.openStage;
  if (
    candidate === undefined
    || open == null
    || open.handle !== handle
    || !buffersEqual(open.handle.stageKey, handle.stageKey)
  ) {
    return halt('ENTITY_STAGE_HANDLE_STALE', {
      owner: handle.ownerEntityId,
      key: handle.stageKey.toString('hex'),
    });
  }
  return { candidate, open };
};

export const acceptAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const { candidate, open } = requireOpenStage(env, handle);
  const receipt = await candidate.session.client.finalizeEntityStage(
    candidate.token,
    handle.stageKey,
    handle.expectedAcceptedOrdinal,
  );
  const expectedRoot = open.latestResult.accountsRoot.toLowerCase();
  const actualRoot = `0x${receipt.accountsRoot.toString('hex')}`.toLowerCase();
  if (
    receipt.acceptedStageOrdinal !== handle.expectedAcceptedOrdinal + 1
    || receipt.revision !== open.latestResult.revision
    || actualRoot !== expectedRoot
  ) {
    return halt('ENTITY_STAGE_ACCEPT_STATE', {
      owner: handle.ownerEntityId,
      expectedOrdinal: handle.expectedAcceptedOrdinal + 1,
      actualOrdinal: receipt.acceptedStageOrdinal,
      expectedRevision: open.latestResult.revision,
      actualRevision: receipt.revision,
      expectedRoot,
      actualRoot,
    });
  }
  candidate.result = open.latestResult;
  candidate.acceptedStageOrdinal = receipt.acceptedStageOrdinal;
  candidate.nextOperationIndex = handle.nextOperationIndex;
  candidate.operations.push(...handle.operations);
  mergeExpectedOutputs(candidate.expectedOutputs, handle.expectedOutputs);
  candidate.createdAccounts.push(...handle.createdAccounts);
  candidate.openStage = null;
};

export const discardAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const { candidate, open } = requireOpenStage(env, handle);
  const receipt = await candidate.session.client.discardEntityStage(
    candidate.token,
    handle.stageKey,
    handle.expectedAcceptedOrdinal,
  );
  const expectedRoot = open.priorResult.accountsRoot.toLowerCase();
  const actualRoot = `0x${receipt.accountsRoot.toString('hex')}`.toLowerCase();
  if (
    receipt.acceptedStageOrdinal !== handle.expectedAcceptedOrdinal
    || receipt.revision !== open.priorResult.revision
    || actualRoot !== expectedRoot
  ) {
    return halt('ENTITY_STAGE_DISCARD_STATE', {
      owner: handle.ownerEntityId,
      expectedOrdinal: handle.expectedAcceptedOrdinal,
      actualOrdinal: receipt.acceptedStageOrdinal,
      expectedRevision: open.priorResult.revision,
      actualRevision: receipt.revision,
      expectedRoot,
      actualRoot,
    });
  }
  candidate.result = open.priorResult;
  candidate.openStage = null;
};

/**
 * Hand the collected frame to the engine and hold its answer against
 * TypeScript's. Returns with a candidate pending in the engine, which the
 * caller must either commit (after its own record is durable) or abort.
 */
export const prepareAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const leaked = captured.get(env);
  captured.delete(env);
  if (leaked !== undefined && leaked.kind !== 'empty') {
    return halt('ACCOUNT_WORK_OUTSIDE_ENTITY_STAGE', {
      kind: leaked.kind,
      detail: leaked.kind === 'ineligible'
        ? leaked.reason
        : leaked.entities.map(entity => ({
            owner: entity.ownerEntityId,
            operations: entity.operations.length,
            proposals: entity.proposalAccountIds,
          })),
    });
  }
  const candidates = pending.get(env);
  if (candidates === undefined) {
    return halt('AUTHORITY_FRAME_CANDIDATE_MISSING', {});
  }
  if (candidates.length === 0) {
    report.emptyFrames += 1;
    return;
  }
  for (const candidate of candidates) {
    const ownerEntityId = candidate.session.ownerEntityId;
    if (candidate.openStage !== null || candidate.sealed) {
      return halt('AUTHORITY_FRAME_SEAL_STATE', {
        owner: ownerEntityId,
        sealed: candidate.sealed,
        open: candidate.openStage?.handle.stageKey.toString('hex') ?? null,
      });
    }
    const result = await candidate.session.client.sealAccountWave(candidate.token);
    assertAuthorityOperationCoverage(ownerEntityId, candidate.operations, result);
    await compareWithTypescript(
      env,
      ownerEntityId,
      result,
      candidate.cutover ? null : candidate.expectedOutputs,
      candidate.session,
    );
    candidate.result = result;
    candidate.sealed = true;
    report.waves += 1;
    report.framesProposed += result.proposals.filter(row => row.frame !== null).length;
    report.inputsApplied += result.applied.length;
  }
};

/**
 * Every account the wave touches must already be in the engine, seeded from
 * the state it had before this frame. An account opened during this very frame
 * has no such state: TypeScript created it while applying, and seeding it now
 * would seed the answer. That case halts rather than being papered over.
 */
export const deriveAuthorityCandidateCreates = (
  ownerEntityId: string,
  committedAccounts: ReadonlySet<string>,
  ops: readonly unknown[],
): readonly string[] => {
  const visible = new Set(committedAccounts);
  const created: string[] = [];
  for (const op of ops) {
    const accountId = accountIdOf(op);
    if (accountId === null) continue;
    if (Array.isArray(op) && op[0] === 2) {
      if (visible.has(accountId)) {
        halt('ACCOUNT_CREATE_ALREADY_COMMITTED', {
          owner: ownerEntityId,
          account: accountId,
        });
      }
      visible.add(accountId);
      created.push(accountId);
      continue;
    }
    if (visible.has(accountId)) continue;
    halt('ACCOUNT_OPENED_MID_FRAME', { owner: ownerEntityId, account: accountId });
  }
  return created;
};

/** Account id inside Admit, Apply or Create candidate operations. */
const accountIdOf = (op: unknown): string | null => {
  if (!Array.isArray(op)) return null;
  if (op[0] === 0) return hexOf(op[2]);
  if (op[0] === 1 && Array.isArray(op[1])) return hexOf(op[1][1]);
  if (op[0] === 2 && Array.isArray(op[2])) return hexOf(op[2][0]);
  return null;
};

const hexOf = (value: unknown): string | null =>
  value instanceof Uint8Array ? `0x${Buffer.from(value).toString('hex')}` : null;

const operationMatches = (
  left: Pick<AuthorityWaveOperation, 'operationIndex' | 'accountId' | 'resultKind'>,
  right: Pick<AuthorityWaveOperation, 'operationIndex' | 'accountId' | 'resultKind'>,
): boolean =>
  left.operationIndex === right.operationIndex
  && left.accountId === right.accountId
  && left.resultKind === right.resultKind;

type RustPeerVerdictParity = Readonly<{
  outcome: 'applied' | 'rejected' | 'failed';
  committedFrames: readonly Readonly<{
    frame: AccountFrame;
    committedViaNewFrame: boolean;
  }>[];
  responseAckHanko: string | null;
}>;

const projectRustPeerVerdict = (
  verdict: Wave['applied'][number]['verdict'],
): RustPeerVerdictParity => {
  switch (verdict.kind) {
    case 'frameCommitted':
      return {
        outcome: 'applied',
        committedFrames: [verdict.committedFrame],
        responseAckHanko: verdict.ackHanko,
      };
    case 'ackCommitted':
      return {
        outcome: 'applied',
        committedFrames: [verdict.committedFrame],
        responseAckHanko: null,
      };
    case 'frameDuplicate':
      return {
        outcome: 'applied',
        committedFrames: [],
        responseAckHanko: verdict.ackHanko,
      };
    case 'frameCollisionIgnored':
    case 'frameStale':
    case 'ackStale':
      return { outcome: 'applied', committedFrames: [], responseAckHanko: null };
    case 'frameRejected':
    case 'ackRejected':
    case 'frameAckRejected':
      return { outcome: 'rejected', committedFrames: [], responseAckHanko: null };
    case 'failed':
      return { outcome: 'failed', committedFrames: [], responseAckHanko: null };
    case 'frameAckApplied': {
      const ack = projectRustPeerVerdict(verdict.ackVerdict);
      const frame = projectRustPeerVerdict(verdict.frameVerdict);
      if (ack.outcome !== 'applied' || frame.outcome !== 'applied') {
        return halt('FRAME_ACK_CHILD_TERMINAL_INVALID', {
          ack: ack.outcome,
          frame: frame.outcome,
        });
      }
      return {
        outcome: 'applied',
        committedFrames: [...ack.committedFrames, ...frame.committedFrames],
        responseAckHanko: frame.responseAckHanko,
      };
    }
  }
};

const rustProposalFrame = (
  frame: Wave['proposals'][number]['frame'],
): AccountFrame | null => {
  if (frame === null) return null;
  const { hanko: _hanko, ...accountFrame } = frame;
  return accountFrame;
};

/** Bind exact proposal order, terminal shape, frame and dropped rows. */
export const assertAuthorityStageProposalParity = (
  ownerEntityId: string,
  stageKey: Uint8Array,
  expected: Extract<AuthorityWave, { kind: 'wave' }>['entities'][number]['expectedProposals'],
  actual: Pick<Wave, 'proposals'>,
): void => {
  const stageKeyHex = Buffer.from(stageKey).toString('hex');
  if (actual.proposals.length !== expected.length) {
    return halt('ENTITY_STAGE_PROPOSAL_COUNT_MISMATCH', {
      owner: ownerEntityId,
      stageKey: stageKeyHex,
      typescript: expected.length,
      rust: actual.proposals.length,
    });
  }
  for (const [attemptIndex, expectedRow] of expected.entries()) {
    const actualRow = actual.proposals[attemptIndex]
      ?? halt('ENTITY_STAGE_PROPOSAL_ROW_MISSING', {
        owner: ownerEntityId,
        stageKey: stageKeyHex,
        attemptIndex,
      });
    const actualFrame = rustProposalFrame(actualRow.frame);
    if (
      actualRow.accountId !== expectedRow.accountId
      || (actualFrame !== null) !== (expectedRow.outcome === 'proposed')
      || safeStringify(actualFrame) !== safeStringify(expectedRow.frame)
      || safeStringify(actualRow.dropped) !== safeStringify(expectedRow.dropped)
    ) {
      halt('ENTITY_STAGE_PROPOSAL_VERDICT_MISMATCH', {
        owner: ownerEntityId,
        stageKey: stageKeyHex,
        attemptIndex,
        account: expectedRow.accountId,
        typescript: expectedRow,
        rust: {
          accountId: actualRow.accountId,
          frame: actualFrame,
          dropped: actualRow.dropped,
        },
      });
    }
    if (actualFrame !== null && computeFrameHash(actualFrame) !== actualFrame.stateHash) {
      halt('ENTITY_STAGE_PROPOSAL_FRAME_HASH_INVALID', {
        owner: ownerEntityId,
        stageKey: stageKeyHex,
        attemptIndex,
        account: expectedRow.accountId,
      });
    }
  }
};

/**
 * Bind every Rust result row to the exact TypeScript Account transition that
 * produced the parent Entity candidate. Full committed frame evidence stays
 * ordered; FrameAck is one operation whose evidence is ACK then frame.
 */
export const assertAuthorityStageVerdictParity = (
  ownerEntityId: string,
  stageKey: Uint8Array,
  operations: readonly AuthorityWaveOperation[],
  result: Pick<Wave, 'admissions' | 'applied'>,
): void => {
  const admissions = new Map(result.admissions.map(row => [row.operationIndex, row]));
  const applied = new Map(result.applied.map(row => [row.operationIndex, row]));
  for (const operation of [...operations].sort((left, right) =>
    left.arrivalIndex - right.arrivalIndex)) {
    const detail = {
      owner: ownerEntityId,
      stageKey: Buffer.from(stageKey).toString('hex'),
      arrivalIndex: operation.arrivalIndex,
      operationIndex: operation.operationIndex,
      account: operation.accountId,
    };
    // Parity only: a cutover operation has no TypeScript verdict, because
    // TypeScript never executed it. Those stages are checked by the exact
    // materialization instead.
    if (operation.expectedVerdict === undefined) continue;
    if (operation.expectedVerdict.kind === 'create') continue;
    if (operation.expectedVerdict.kind === 'admission') {
      const actual = admissions.get(operation.operationIndex)?.verdict;
      if (
        actual?.kind !== 'admitted'
        || actual.count !== operation.expectedVerdict.admittedCount
      ) {
        halt('ENTITY_STAGE_ADMISSION_VERDICT_MISMATCH', {
          ...detail,
          typescript: operation.expectedVerdict,
          rust: actual ?? null,
        });
      }
      continue;
    }
    const actualRow = applied.get(operation.operationIndex)
      ?? halt('ENTITY_STAGE_PEER_VERDICT_MISSING', detail);
    const actual = projectRustPeerVerdict(actualRow.verdict);
    const expected = operation.expectedVerdict;
    if (expected.kind !== 'peer') {
      return halt('ENTITY_STAGE_PEER_VERDICT_KIND', { ...detail, kind: expected.kind });
    }
    // TypeScript's ACK Hanko is not produced by the Account transition: the
    // Entity signs the account frame hash in its own witness pass, after this
    // point. So a TypeScript `null` here means "not signed yet", never "no
    // ACK" — the engine holds its own key and signs immediately. Compare the
    // two only where TypeScript already has one to compare, which is the
    // duplicate/re-send path replaying a cached ACK.
    const ackHankoComparable = expected.responseAckHanko !== null;
    // The events the frame publishes are consensus material, so the engine's
    // own list is checked against TypeScript's here — this is the same
    // synthesis a cutover run publishes with no TypeScript list to check.
    const engineEvents = cutoverAccountInputEvents(actualRow.verdict, operation.accountId);
    if (safeStringify(engineEvents) !== safeStringify([...expected.events])) {
      halt('ENTITY_STAGE_PEER_EVENTS_MISMATCH', {
        ...detail,
        typescript: expected.events,
        rust: engineEvents,
      });
    }
    if (
      actual.outcome !== expected.outcome
      || (ackHankoComparable && actual.responseAckHanko !== expected.responseAckHanko)
      || safeStringify(actual.committedFrames) !== safeStringify(expected.committedFrames)
    ) {
      halt('ENTITY_STAGE_PEER_VERDICT_MISMATCH', {
        ...detail,
        typescript: expected,
        rust: actual,
        rustKind: actualRow.verdict.kind,
      });
    }
  }
};

/**
 * The collector ledger must itself be a bijection with what is put on the
 * process wire. Otherwise a missing Create is invisible (it returns no row),
 * and a missing Admit/Input can be misreported later as an engine omission.
 */
export const assertAuthorityWaveOperationLedger = (
  wave: Extract<AuthorityWave, { kind: 'wave' }>,
): void => {
  const operationIndices = new Set<string>();
  const arrivalIndices = new Set<number>();
  const appliedMetadata = new Map(wave.inputs.map(input => [
    `${input.ownerEntityId}/${input.operationIndex}`,
    input,
  ]));
  if (appliedMetadata.size !== wave.inputs.length) {
    halt('OPERATION_LEDGER_MISMATCH', { reason: 'duplicateInputMetadata' });
  }
  let appliedCount = 0;
  for (const entity of wave.entities) {
    if (entity.ops.length !== entity.operations.length) {
      halt('OPERATION_LEDGER_MISMATCH', {
        reason: 'length',
        owner: entity.ownerEntityId,
        encoded: entity.ops.length,
        ledger: entity.operations.length,
      });
    }
    for (const [position, encoded] of entity.ops.entries()) {
      const ledger = entity.operations[position];
      if (ledger === undefined) {
        return halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'missingLedgerRow',
          owner: entity.ownerEntityId,
          position,
        });
      }
      const described = (() => {
        try {
          return describeAuthorityWaveOperation(encoded);
        } catch (error) {
          return halt('OPERATION_LEDGER_MISMATCH', {
            reason: 'encodedShape',
            owner: entity.ownerEntityId,
            position,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
      if (!operationMatches(described, ledger)) {
        halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'encodedBinding',
          owner: entity.ownerEntityId,
          position,
          encoded: described,
          ledger,
        });
      }
      if (!Number.isSafeInteger(ledger.arrivalIndex) || ledger.arrivalIndex < 0) {
        halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'arrivalIndex',
          owner: entity.ownerEntityId,
          operationIndex: ledger.operationIndex,
          arrivalIndex: ledger.arrivalIndex,
        });
      }
      const operationKey = `${entity.ownerEntityId}/${ledger.operationIndex}`;
      if (operationIndices.has(operationKey)) {
        halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'duplicateOperationIndex',
          operationIndex: ledger.operationIndex,
        });
      }
      if (arrivalIndices.has(ledger.arrivalIndex)) {
        halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'duplicateArrivalIndex',
          arrivalIndex: ledger.arrivalIndex,
        });
      }
      operationIndices.add(operationKey);
      arrivalIndices.add(ledger.arrivalIndex);
      const metadata = appliedMetadata.get(operationKey);
      if (ledger.resultKind === 'applied') {
        appliedCount += 1;
        if (
          metadata === undefined
          || metadata.ownerEntityId !== entity.ownerEntityId
          || metadata.accountId !== ledger.accountId
          || metadata.arrivalIndex !== ledger.arrivalIndex
        ) {
          halt('OPERATION_LEDGER_MISMATCH', {
            reason: 'inputMetadataBinding',
            owner: entity.ownerEntityId,
            operation: ledger,
            metadata: metadata ?? null,
          });
        }
      } else if (metadata !== undefined) {
        halt('OPERATION_LEDGER_MISMATCH', {
          reason: 'unexpectedInputMetadata',
          owner: entity.ownerEntityId,
          operation: ledger,
        });
      }
    }
  }
  if (appliedCount !== wave.inputs.length) {
    halt('OPERATION_LEDGER_MISMATCH', {
      reason: 'inputMetadataCount',
      applied: appliedCount,
      metadata: wave.inputs.length,
    });
  }
  // Discarded parent stages intentionally leave gaps. Retained global arrival
  // values still preserve exact order and must never be renumbered.
};

/**
 * Require a one-to-one answer for every result-bearing submitted operation.
 * This deliberately checks only coverage and binding; whether an individual
 * verdict is semantically the same verdict TypeScript produced is a separate
 * parity gate.
 */
export const assertAuthorityOperationCoverage = (
  ownerEntityId: string,
  submitted: readonly AuthorityWaveOperation[],
  result: Pick<Wave, 'admissions' | 'applied'>,
): void => {
  const expected = new Map<number, AuthorityWaveOperation>();
  for (const operation of submitted) {
    if (expected.has(operation.operationIndex)) {
      halt('OPERATION_COVERAGE_MISMATCH', {
        reason: 'duplicateSubmitted',
        owner: ownerEntityId,
        operationIndex: operation.operationIndex,
      });
    }
    expected.set(operation.operationIndex, operation);
  }
  const actual = [
    ...result.admissions.map(row => ({
      operationIndex: row.operationIndex,
      accountId: row.accountId,
      resultKind: 'admission' as const,
    })),
    ...result.applied.map(row => ({
      operationIndex: row.operationIndex,
      accountId: row.accountId,
      resultKind: 'applied' as const,
    })),
  ];
  const answered = new Set<number>();
  for (const row of actual) {
    if (answered.has(row.operationIndex)) {
      halt('OPERATION_COVERAGE_MISMATCH', {
        reason: 'duplicateResult',
        owner: ownerEntityId,
        operationIndex: row.operationIndex,
      });
    }
    answered.add(row.operationIndex);
    const operation = expected.get(row.operationIndex);
    if (operation === undefined) {
      return halt('OPERATION_COVERAGE_MISMATCH', {
        reason: 'extraResult',
        owner: ownerEntityId,
        result: row,
      });
    }
    if (!operationMatches(operation, row)) {
      halt('OPERATION_COVERAGE_MISMATCH', {
        reason: 'resultBinding',
        owner: ownerEntityId,
        submitted: operation,
        result: row,
      });
    }
  }
  const missing = submitted.filter(operation =>
    operation.resultKind !== 'none' && !answered.has(operation.operationIndex));
  if (missing.length > 0) {
    halt('OPERATION_COVERAGE_MISMATCH', {
      reason: 'missingResult',
      owner: ownerEntityId,
      missing: missing.map(operation => ({
        operationIndex: operation.operationIndex,
        accountId: operation.accountId,
        resultKind: operation.resultKind,
      })),
    });
  }
};

/**
 * Parity, in safe mode: every leaf the engine says it moved must be the leaf
 * TypeScript's own replica commits, and every frame the engine signed must be
 * the frame TypeScript proposed. The first disagreement halts.
 */
/**
 * Which carried fields this frame moved since the engine was seeded. The
 * engine derives the consensus fields itself and carries the rest verbatim, so
 * a leaf that disagrees while the frame itself matches is a carried field the
 * authority changed and the engine could not know about.
 */
const movedCarriedFields = (
  session: Session | undefined,
  accountId: string,
  account: AccountReplica,
): string[] => {
  const seeded = session?.seededProjection.get(accountId);
  if (seeded === undefined) return [];
  const now = projectEntityAccountLeaf(account);
  const names = new Set([...Object.keys(seeded), ...Object.keys(now)]);
  return [...names]
    .filter(name => safeStringify(seeded[name]) !== safeStringify(now[name]))
    .sort();
};

/**
 * Which single field, reverted to what the engine was seeded with, would make
 * TypeScript's leaf equal the engine's. It names the rule the engine got
 * wrong; nothing matching means the engine computed a value neither side has
 * seen, and the field is one it derives itself.
 */
const fieldExplainingLeaf = (
  session: Session | undefined,
  accountId: string,
  account: AccountReplica,
  rustLeaf: string,
): string => {
  const seeded = session?.seededProjection.get(accountId);
  if (seeded === undefined) return 'unseeded';
  const now = projectEntityAccountLeaf(account);
  const digest = (projection: Record<string, unknown>): string =>
    computeEntityAccountLeafDigest(Object.entries(projection)
      .filter(([, value]) => value !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)))
      .toLowerCase();
  const target = rustLeaf.toLowerCase();
  if (digest({ ...now, ...seeded }) === target) return 'allSeeded';
  for (const field of movedCarriedFields(session, accountId, account)) {
    if (digest({ ...now, [field]: seeded[field] }) === target) return field;
  }
  return 'none';
};

/**
 * The engine's own leaf projection, field by field, as it holds it. Read only
 * when a leaf already disagrees: it turns "these two hashes differ" into the
 * name of the field and the two values.
 */
const engineLeafFields = async (
  session: Session,
  accountId: string,
): Promise<Record<string, unknown>> => {
  const reply = (await session.client.readAccountEnvelope(
    Uint8Array.from(Buffer.from(accountId.slice(2), 'hex')),
  )) as unknown[];
  const rows = (reply[1] ?? []) as unknown[];
  const fields: Record<string, unknown> = {};
  for (const row of rows) {
    const pair = row as unknown[];
    fields[String(pair[0])] = canonicalFromWire(pair[1]);
  }
  return fields;
};

/** The nine-variant canonical model, back from the wire. */
const canonicalFromWire = (value: unknown): unknown => {
  if (!Array.isArray(value)) return value;
  const [tag, payload] = value as [number, unknown];
  switch (tag) {
    case 0: return null;
    case 1: return payload === 1 || payload === true;
    case 2: return Number(payload);
    case 3: return BigInt(String(payload));
    case 4: return String(payload);
    case 5: return (payload as unknown[]).map(canonicalFromWire);
    case 6: return new Map((payload as unknown[]).map(entry => {
      const pair = entry as unknown[];
      return [canonicalFromWire(pair[0]), canonicalFromWire(pair[1])] as const;
    }));
    case 7: return new Set((payload as unknown[]).map(canonicalFromWire));
    case 8: return Object.fromEntries((payload as unknown[]).map(entry => {
      const pair = entry as unknown[];
      return [String(pair[0]), canonicalFromWire(pair[1])] as const;
    }));
    default: return value;
  }
};

/** Every field where the two projections disagree, with both values. */
const projectionDiff = (
  typescript: Record<string, unknown>,
  engine: Record<string, unknown>,
): Record<string, { typescript: string; rust: string }> => {
  const names = new Set([...Object.keys(typescript), ...Object.keys(engine)]);
  const diff: Record<string, { typescript: string; rust: string }> = {};
  for (const name of [...names].sort()) {
    // The engine derives these two from what it holds, so it never carries
    // them and their absence is not a disagreement.
    if (name === 'accountStateRoot' || name === 'mempoolRoot') continue;
    const left = safeStringify(typescript[name]);
    const right = safeStringify(engine[name]);
    if (left !== right) diff[name] = { typescript: left, rust: right };
  }
  return diff;
};

/**
 * The outputs the engine published for one wave, per account, in the order its
 * verdicts released them. A proposal publishes nothing: what its transactions
 * produced stays with the pending frame until the peer acks it, which is the
 * same rule TypeScript follows.
 */
const engineOutputsByAccount = (wave: Wave): Map<string, ShadowOutputRow[]> => {
  const byAccount = new Map<string, ShadowOutputRow[]>();
  for (const applied of wave.applied) {
    const verdicts = applied.verdict.kind === 'frameAckApplied'
      ? [applied.verdict.ackVerdict, applied.verdict.frameVerdict]
      : [applied.verdict];
    const rows = byAccount.get(applied.accountId) ?? [];
    for (const verdict of verdicts) {
      if (verdict.kind !== 'frameCommitted' && verdict.kind !== 'ackCommitted') continue;
      rows.push(...verdict.outputs.map(waveOutputRow));
    }
    if (rows.length > 0) byAccount.set(applied.accountId, rows);
  }
  return byAccount;
};

/**
 * Every output TypeScript published in this frame, and nothing else. Two
 * engines that agree on every root can still disagree here — a forward that
 * never leaves, a secret that settles nothing upstream, a resting offer the
 * book never sees — and that disagreement is invisible to a state comparison.
 */
const compareOutputs = (
  ownerEntityId: string,
  wave: Wave,
  expected: ReadonlyMap<string, readonly ShadowOutputRow[]>,
): void => {
  const engine = engineOutputsByAccount(wave);
  for (const accountId of new Set([...expected.keys(), ...engine.keys()])) {
    const typescript = expected.get(accountId) ?? [];
    const rust = engine.get(accountId) ?? [];
    const left = safeStringify(typescript);
    const right = safeStringify(rust);
    if (left === right) {
      report.outputsChecked += typescript.length;
      continue;
    }
    halt('OUTPUT_MISMATCH', {
      owner: ownerEntityId,
      account: accountId,
      typescriptCount: typescript.length,
      rustCount: rust.length,
      // The first row that differs, which is the one to read: a whole-list
      // dump of a busy hub frame buries it.
      firstDivergentIndex: [...Array(Math.max(typescript.length, rust.length)).keys()]
        .find(index => safeStringify(typescript[index]) !== safeStringify(rust[index])) ?? -1,
      typescript: left,
      rust: right,
    });
    return;
  }
};

/**
 * Verify a Rust-authored proposal independently before parity accepts it.
 *
 * Matching an engine-supplied `stateHash` to TypeScript is insufficient: a
 * malformed frame could carry that same copied hash, and a forged Hanko does
 * not change any state root. H1 authority is currently restricted to a lazy
 * one-of-one Entity, so retired-board grace is deliberately disabled here.
 */
export const assertAuthorityProposalParity = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  accountId: string,
  frame: AccountFrame & { hanko: string },
  typescriptCandidate: AccountFrame,
): Promise<void> => {
  const structuralError = getAccountFrameStructuralError(frame, env.state.timestamp);
  if (structuralError !== '') {
    halt('FRAME_STRUCTURE_INVALID', {
      owner: ownerEntityId,
      account: accountId,
      height: frame.height,
      error: structuralError,
    });
  }

  const recomputedHash = (() => {
    try {
      return computeFrameHash(frame).toLowerCase();
    } catch (error) {
      return halt('FRAME_HASH_COMPUTE_FAILED', {
        owner: ownerEntityId,
        account: accountId,
        height: frame.height,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  if (recomputedHash !== frame.stateHash.toLowerCase()) {
    halt('FRAME_SELF_HASH_MISMATCH', {
      owner: ownerEntityId,
      account: accountId,
      height: frame.height,
      recomputed: recomputedHash,
      rust: frame.stateHash,
    });
  }
  if (recomputedHash !== typescriptCandidate.stateHash.toLowerCase()) {
    halt('FRAME_HASH_MISMATCH', {
      owner: ownerEntityId,
      account: accountId,
      height: frame.height,
      typescript: typescriptCandidate.stateHash,
      rust: frame.stateHash,
      recomputed: recomputedHash,
    });
  }

  const verified = await (async () => {
    try {
      return await verifyHankoForHash(
        frame.hanko,
        recomputedHash,
        ownerEntityId,
        env,
        { allowPreviousBoard: false },
      );
    } catch (error) {
      return halt('FRAME_HANKO_VERIFICATION_FAILED', {
        owner: ownerEntityId,
        account: accountId,
        height: frame.height,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();
  if (!verified.valid || verified.entityId?.toLowerCase() !== ownerEntityId.toLowerCase()) {
    halt('FRAME_HANKO_INVALID', {
      owner: ownerEntityId,
      account: accountId,
      height: frame.height,
      signedEntity: verified.entityId,
    });
  }
};

const compareWithTypescript = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  wave: Wave,
  expectedOutputs: ReadonlyMap<string, readonly ShadowOutputRow[]> | null,
  session?: Session,
): Promise<void> => {
  if (expectedOutputs !== null) compareOutputs(ownerEntityId, wave, expectedOutputs);
  const accounts = accountsOf(env, ownerEntityId);
  const typescriptAccountsRoot = accountMapRoot(accounts, ownerEntityId);
  // A partial import is a forest the engine was never given in full, so the
  // two roots are different by construction and comparing them would report
  // the declared gap as a divergence. Each imported Account's own leaf is
  // still compared below, and touching a refused one halts as unseeded.
  const rootComparable = (session?.importRefused ?? 0) === 0;
  if (rootComparable && typescriptAccountsRoot !== wave.accountsRoot.toLowerCase()) {
    halt('ACCOUNTS_ROOT_MISMATCH', {
      owner: ownerEntityId,
      typescript: typescriptAccountsRoot,
      rust: wave.accountsRoot,
      accountCount: accounts.size,
    });
  }
  const proposed = new Map<string, NonNullable<Wave['proposals'][number]['frame']>>();
  for (const row of wave.proposals) {
    if (row.frame !== null) proposed.set(row.accountId, row.frame);
  }
  for (const leaf of wave.touched) {
    const account = accounts.get(leaf.accountId)
      ?? findAccountByCounterparty(accounts, ownerEntityId, leaf.accountId);
    if (!account) {
      halt('TOUCHED_ACCOUNT_MISSING', { account: leaf.accountId });
      return;
    }
    const expected = computeEntityAccountValueHash(account).toLowerCase();
    if (expected !== leaf.entityAccountLeaf.toLowerCase()) {
      const rustProposal = proposed.get(leaf.accountId);
      const fields = session === undefined
        ? {}
        : projectionDiff(projectEntityAccountLeaf(account), await engineLeafFields(session, leaf.accountId));
      halt('LEAF_MISMATCH', {
        fields,
        account: leaf.accountId,
        typescript: expected,
        rust: leaf.entityAccountLeaf,
        height: account.currentHeight,
        // The leaf covers state, mempool and both frame bindings at once, so
        // the bare hashes never say which of them moved. These do.
        typescriptStateRoot: computeAccountStateRoot(account.state, undefined, 'entityLeaf'),
        mempool: account.mempool.length,
        currentFrameHash: account.currentFrame?.stateHash ?? null,
        typescriptPending: account.pendingFrame === undefined ? null : {
          height: account.pendingFrame.height,
          stateHash: account.pendingFrame.stateHash,
          accountStateRoot: account.pendingFrame.accountStateRoot,
          txs: account.pendingFrame.accountTxs.length,
        },
        rustProposal: rustProposal === undefined ? null : {
          height: rustProposal.height,
          stateHash: rustProposal.stateHash,
          accountStateRoot: rustProposal.accountStateRoot,
          txs: rustProposal.accountTxs.length,
        },
        currentFrame: account.currentFrame?.height ?? null,
        movedSinceSeed: movedCarriedFields(session, leaf.accountId, account),
        staleField: fieldExplainingLeaf(session, leaf.accountId, account, leaf.entityAccountLeaf),
        pendingAccountInput: account.pendingAccountInput !== undefined,
        lastOutboundFrameAck: account.lastOutboundFrameAck?.height ?? null,
      });
      return;
    }
    report.leavesChecked += 1;
  }
  for (const proposal of wave.proposals) {
    const frame = proposal.frame;
    if (frame === null) continue;
    const account = accounts.get(proposal.accountId)
      ?? findAccountByCounterparty(accounts, ownerEntityId, proposal.accountId);
    if (!account) {
      halt('PROPOSED_ACCOUNT_MISSING', { account: proposal.accountId });
      return;
    }
    // TypeScript's own proposal for this height, still pending its ack. If it
    // committed within this same frame the pending is gone, and the committed
    // frame is the one to compare against.
    const candidate = account.pendingFrame?.height === frame.height
      ? account.pendingFrame
      : account.currentFrame?.height === frame.height ? account.currentFrame : null;
    if (!candidate) {
      halt('PROPOSAL_UNMATCHED', {
        account: proposal.accountId,
        height: frame.height,
        pending: account.pendingFrame?.height ?? null,
        current: account.currentFrame?.height ?? null,
      });
      return;
    }
    await assertAuthorityProposalParity(
      env,
      ownerEntityId,
      proposal.accountId,
      frame,
      candidate,
    );
  }
};

const assertCheckpointMatchesCandidate = (
  env: RuntimeReplica,
  candidate: PendingWave,
  checkpoint: RscoreCheckpointChanges,
): void => {
  const owner = candidate.session.ownerEntityId;
  const accounts = accountsOf(env, owner);
  const typescriptRoot = accountMapRoot(accounts, owner);
  const checkpointRoot = `0x${Buffer.from(checkpoint.restoreToken[2]).toString('hex')}`;
  try {
    assertRscoreCheckpointCandidate(checkpoint, {
      revision: candidate.result.revision,
      accountsRoot: candidate.result.accountsRoot,
      accountCount: accounts.size,
    });
  } catch {
    halt('CHECKPOINT_CANDIDATE_MISMATCH', {
      owner,
      candidateRevision: candidate.result.revision,
      checkpointRevision: String(checkpoint.restoreToken[1]),
      candidateRoot: candidate.result.accountsRoot,
      checkpointRoot,
      typescriptRoot,
      checkpointCount: checkpoint.restoreToken[4],
      typescriptCount: accounts.size,
    });
  }
  if (
    candidate.result.accountsRoot.toLowerCase() !== typescriptRoot
  ) {
    halt('CHECKPOINT_CANDIDATE_MISMATCH', {
      owner,
      candidateRevision: candidate.result.revision,
      checkpointRevision: String(checkpoint.restoreToken[1]),
      candidateRoot: candidate.result.accountsRoot,
      checkpointRoot,
      typescriptRoot,
      checkpointCount: checkpoint.restoreToken[4],
      typescriptCount: accounts.size,
    });
  }
};

/**
 * Export candidate-bound checkpoint changes before the authoritative WAL
 * append. A materialization frame covers every armed owner, including owners
 * whose Account machine was idle in this Runtime frame; those receive one
 * explicit empty candidate so the exported rows and token name this exact
 * Runtime boundary.
 */
export const prepareAuthorityCheckpoint = async (
  env: RuntimeReplica,
  checkpointRequested: boolean,
): Promise<readonly AuthorityCheckpointStorageInput[]> => {
  if (!authorityDriverEnabled(env) || !checkpointRequested) return [];
  const candidates = pending.get(env);
  if (candidates === undefined) return halt('CHECKPOINT_CANDIDATE_MISSING', {});
  const inputs: AuthorityCheckpointStorageInput[] = [];
  for (const candidate of [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId))) {
    if (candidate.checkpoint) {
      halt('CHECKPOINT_ALREADY_EXPORTED', { owner: candidate.session.ownerEntityId });
    }
    if (!candidate.sealed || candidate.openStage !== null) {
      return halt('CHECKPOINT_CANDIDATE_NOT_SEALED', {
        owner: candidate.session.ownerEntityId,
        sealed: candidate.sealed,
        open: candidate.openStage?.handle.stageKey.toString('hex') ?? null,
      });
    }
    const checkpoint = await candidate.session.client.getCheckpointChanges(candidate.token);
    assertCheckpointMatchesCandidate(env, candidate, checkpoint);
    candidate.checkpoint = checkpoint;
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

/**
 * Re-read the exact physical projection through the storage overlay and make
 * a disposable Rust authority restore it before WAL fsync. This binds the
 * incremental node changes—not just their token—to the candidate root.
 */
export const validateAuthorityCheckpointMaterialization = async (
  env: RuntimeReplica,
  checkpoints: readonly RscoreExactCheckpoint[],
): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const expected = new Map(
    (pending.get(env) ?? [])
      .filter(candidate => candidate.checkpoint !== undefined)
      .map(candidate => [candidate.session.ownerEntityId, candidate]),
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
    const candidate = expected.get(owner);
    if (
      seen.has(owner) ||
      candidate?.checkpoint === undefined ||
      checkpoint.protocolFingerprint.toLowerCase() !== protocolFingerprint ||
      !checkpointTokensEqual(
        checkpoint.restoreToken,
        candidate.checkpoint.restoreToken,
      )
    ) {
      halt('CHECKPOINT_MATERIALIZATION_IDENTITY_MISMATCH', {
        owner,
        duplicate: seen.has(owner),
        expectedOwner: candidate?.session.ownerEntityId ?? null,
        expectedRevision: candidate?.checkpoint === undefined
          ? null
          : String(candidate.checkpoint.restoreToken[1]),
        actualRevision: String(checkpoint.restoreToken[1]),
      });
    }
    seen.add(owner);
    const validator = await openAuthoritySession(env, owner);
    if (validator === 'disabled') {
      return halt('CHECKPOINT_MATERIALIZATION_VALIDATOR_DISABLED', { owner });
    }
    try {
      const restored = await validator.client.restoreExact(
        checkpoint.restoreToken,
        checkpoint.accounts,
      );
      if (!checkpointTokensEqual(restored, checkpoint.restoreToken)) {
        halt('CHECKPOINT_MATERIALIZATION_RESTORE_MISMATCH', {
          owner,
          expectedRevision: String(checkpoint.restoreToken[1]),
          actualRevision: String(restored[1]),
        });
      }
      report.checkpointValidations += 1;
    } finally {
      validator.client.kill();
    }
  }
};

const decodeCommitResponse = (
  ownerEntityId: string,
  value: unknown,
): Readonly<{ revision: number; root: Uint8Array }> => {
  if (!Array.isArray(value) || value.length !== 2) {
    return halt('COMMIT_RESPONSE_INVALID', { owner: ownerEntityId });
  }
  const revision = value[0];
  const root = value[1];
  if (
    typeof revision !== 'number' ||
    !Number.isSafeInteger(revision) ||
    revision < 0 ||
    !(root instanceof Uint8Array) ||
    root.byteLength !== 32
  ) {
    return halt('COMMIT_RESPONSE_INVALID', { owner: ownerEntityId });
  }
  return { revision, root };
};

/** The Runtime's own record is durable: every engine may keep its wave. */
export const commitAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const candidates = pending.get(env);
  if (candidates === undefined) return;
  const ordered = [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId));
  for (const candidate of ordered) {
    if (!candidate.sealed || candidate.openStage !== null) {
      return halt('COMMIT_CANDIDATE_NOT_SEALED', {
        owner: candidate.session.ownerEntityId,
        sealed: candidate.sealed,
        open: candidate.openStage?.handle.stageKey.toString('hex') ?? null,
      });
    }
    const committed = decodeCommitResponse(
      candidate.session.ownerEntityId,
      await candidate.session.client.commit(candidate.token),
    );
    const root = `0x${Buffer.from(committed.root).toString('hex')}`;
    if (
      committed.revision !== candidate.result.revision ||
      root.toLowerCase() !== candidate.result.accountsRoot.toLowerCase()
    ) {
      halt('COMMIT_ROOT_MISMATCH', {
        owner: candidate.session.ownerEntityId,
        preparedRevision: candidate.result.revision,
        committedRevision: committed.revision,
        prepared: candidate.result.accountsRoot,
        committed: root,
      });
    }
    report.commits += 1;
  }
  for (const candidate of ordered) {
    if (!candidate.checkpoint) continue;
    const committed = await candidate.session.client.commitCheckpoint(
      candidate.checkpoint.commitToken,
    );
    if (!checkpointTokensEqual(committed, candidate.checkpoint.restoreToken)) {
      halt('CHECKPOINT_COMMIT_TOKEN_MISMATCH', {
        owner: candidate.session.ownerEntityId,
        expectedRevision: String(candidate.checkpoint.restoreToken[1]),
        committedRevision: String(committed[1]),
      });
    }
    report.checkpointsCommitted += 1;
  }
  // Membership becomes observable only after the Runtime WAL and every Rust
  // candidate commit succeeded. Abort and pre-WAL failures therefore cannot
  // leave a TS-side cache claiming that an uncommitted Create exists.
  for (const candidate of ordered) {
    const accounts = accountsOf(env, candidate.session.ownerEntityId);
    for (const accountId of candidate.createdAccounts) {
      if (candidate.session.seeded.has(accountId)) {
        halt('ACCOUNT_CREATE_PROMOTION_DUPLICATE', {
          owner: candidate.session.ownerEntityId,
          account: accountId,
        });
      }
      const account = accounts.get(accountId)
        ?? findAccountByCounterparty(
          accounts,
          candidate.session.ownerEntityId,
          accountId,
        );
      if (account == null) {
        halt('ACCOUNT_CREATE_PROMOTION_MISSING', {
          owner: candidate.session.ownerEntityId,
          account: accountId,
        });
        continue;
      }
      candidate.session.seeded.add(accountId);
      candidate.session.seededProjection.set(accountId, projectEntityAccountLeaf(account));
      report.accountsSeeded += 1;
    }
  }
  pending.delete(env);
  arrivalCursors.delete(env);
};

/** The Runtime could not make its record durable: the engines take it back. */
export const abortAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const candidates = pending.get(env);
  if (candidates === undefined) return;
  for (const candidate of [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId))) {
    await candidate.session.client.abort(candidate.token);
    report.aborts += 1;
  }
  pending.delete(env);
  arrivalCursors.delete(env);
};

export const printAuthorityDriverReport = (): void => {
  if (!authorityDriverEnabled()) return;
  console.error(`RSCORE_AUTHORITY_DRIVER ${safeStringify(authorityDriverReport())}`);
};

export const discardAuthorityRuntime = async (env: RuntimeReplica): Promise<void> => {
  for (const session of sessionMap(env, false)?.values() ?? []) {
    if (session === 'disabled') continue;
    session.client.kill();
    allSessions.delete(session);
  }
  sessions.delete(env);
  captured.delete(env);
  pending.delete(env);
  arrivalCursors.delete(env);
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
