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
import { generateLazyEntityId } from '../entity/factory';
import { projectEntityAccountLeaf } from '../entity/consensus/state-root';
import { getEntityReplicaById } from '../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../account/state/account-lookup';
import {
  authorityPeerInputRow,
  buildAuthorityWave,
  type AuthorityWave,
} from './authority-wave';
import {
  accountConsensusWire,
  accountTxWire,
  accountEnvelopeWire,
  accountSeedWire,
  hexToWireBytes,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from './shadow-wire';
import { requireAccountDeltaTransformerAddress } from '../account/consensus/helpers';
import type { Wave } from './wave-decode';
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
import type { AccountPeerInput, AccountReplica, AccountTx } from '../types/account';
import type { RoutedEntityInput, RuntimeReplica } from '../runtime/types';
import { buffersEqual, safeStringify } from '../protocol/serialization';
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

type OpenFrame = {
  session: Session;
  /** The Entity input currently able to be undone, if one has moved anything. */
  entityInput: AuthorityEntityStageHandle | null;
  /** Accounts opened by this frame, promoted to membership only on commit. */
  createdAccounts: string[];
  /** Where the accounts stood after the last thing this frame did to them. */
  latest: Readonly<{ revision: number; accountsRoot: string }> | null;
  /** Rows exported for this frame's durable checkpoint, once taken. */
  checkpoint?: RscoreCheckpointChanges;
};

/** Names the Entity input whose account work can still be undone. */
export type AuthorityEntityStageHandle = Readonly<{ ownerEntityId: string }>;

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
const pending = new Map<RuntimeReplica, OpenFrame[]>();
/** Original Account-operation arrival cursor for the active Runtime frame. */
const arrivalCursors = new Map<RuntimeReplica, number>();

const report = {
  waves: 0,
  inboundRounds: 0,
  outboundRounds: 0,
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
  /** Microseconds spent inside the engine, as the engine itself measured. */
  engineMicros: 0,
  /** Microseconds the caller waited for the engine, transport included. */
  waveMicros: 0,
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
  const candidates: OpenFrame[] = [];
  pending.set(env, candidates);
  arrivalCursors.set(env, 0);
  try {
    for (const session of sessionEntriesForRuntime(env)) {
      await session.client.pushSavepoint();
      candidates.push({ session, entityInput: null, createdAccounts: [], latest: null });
    }
  } catch (error) {
    const abortErrors: unknown[] = [];
    for (const candidate of candidates) {
      try {
        await candidate.session.client.undoSavepoint();
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

const candidateForOwner = (
  env: RuntimeReplica,
  ownerEntityId: string,
): OpenFrame | undefined => (pending.get(env) ?? [])
  .find(frame => frame.session.ownerEntityId === ownerEntityId);

/** The Entity input whose account work this frame can still undo. */
export const authorityCutoverStageHandle = (
  env: RuntimeReplica,
  ownerEntityId: string,
): AuthorityEntityStageHandle | null =>
  candidateForOwner(env, ownerEntityId.trim().toLowerCase())?.entityInput ?? null;

/**
 * Hand this Entity input's arrivals to the engine in one call.
 *
 * The frame knows every account input it carries before it dispatches any of
 * them, so they cross together. The savepoint this Entity input opens is the
 * same one a single operation would open.
 */
export const handAccountInbound = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  clock: Readonly<{ entityTimestamp: number; finalizedJHeight: number }>,
  rows: readonly RscoreWireValue[],
): Promise<Wave | null> => {
  if (!authorityDriverEnabled(env)) return null;
  const owner = ownerEntityId.trim().toLowerCase();
  const frame = candidateForOwner(env, owner);
  if (frame === undefined) return null;
  if (frame.entityInput === null) {
    await frame.session.client.pushSavepoint();
    frame.entityInput = { ownerEntityId: owner };
  }
  const startedMs = performance.now();
  const wave = await frame.session.client.accountInbound({
    ownerEntityId: hexToWireBytes(owner, 32, 'AUTHORITY_OWNER'),
    entityTimestamp: clock.entityTimestamp,
    finalizedJHeight: clock.finalizedJHeight,
    rows,
    postAccounts: true,
  });
  report.waves += 1;
  report.inboundRounds += 1;
  report.engineMicros += wave.engineMicros;
  report.waveMicros += Math.round((performance.now() - startedMs) * 1_000);
  report.inputsApplied += wave.applied.length;
  frame.latest = { revision: wave.revision, accountsRoot: wave.accountsRoot };
  return wave;
};

/** One IPC visit for every peer arrival carried by one Entity frame. */
export const runAuthorityCutoverInboundBatch = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  clock: Readonly<{ entityTimestamp: number; finalizedJHeight: number }>,
  inputs: readonly Readonly<{
    accountId: string;
    input: Extract<AccountPeerInput, { kind: 'frame' | 'ack' | 'frame_ack' }>;
  }>[],
): Promise<Wave | null> => {
  const rows = inputs.map((entry, index) => authorityPeerInputRow(
    index,
    entry.accountId,
    { kind: entry.input.kind, input: entry.input } as Parameters<typeof authorityPeerInputRow>[2],
  ));
  return handAccountInbound(env, ownerEntityId, clock, rows);
};

/** One IPC visit for every admission and proposal of one Entity frame. */
export const runAuthorityCutoverOutboundBatch = async (
  env: RuntimeReplica,
  request: Readonly<{
    ownerEntityId: string;
    admits: readonly Readonly<{ accountId: string; txs: readonly AccountTx[] }>[];
    propose: readonly string[];
    timestamp: number;
    jHeight: number;
  }>,
): Promise<Wave | null> => {
  if (!authorityDriverEnabled(env)) return null;
  const owner = request.ownerEntityId.trim().toLowerCase();
  const frame = candidateForOwner(env, owner);
  if (frame === undefined) return null;
  if (frame.entityInput === null) {
    await frame.session.client.pushSavepoint();
    frame.entityInput = { ownerEntityId: owner };
  }
  const startedMs = performance.now();
  const wave = await frame.session.client.accountOutbound({
    ownerEntityId: hexToWireBytes(owner, 32, 'AUTHORITY_OWNER'),
    timestamp: request.timestamp,
    jHeight: request.jHeight,
    creates: [],
    admits: request.admits.map(row => [
      hexToWireBytes(row.accountId, 32, 'AUTHORITY_ACCOUNT'),
      row.txs.map(accountTxRow),
    ]),
    propose: request.propose.map(id => hexToWireBytes(id, 32, 'AUTHORITY_ACCOUNT')),
    postAccounts: true,
  });
  report.waves += 1;
  report.outboundRounds += 1;
  report.engineMicros += wave.engineMicros;
  report.waveMicros += Math.round((performance.now() - startedMs) * 1_000);
  report.framesProposed += wave.proposals.filter(row => row.frame !== null).length;
  frame.latest = { revision: wave.revision, accountsRoot: wave.accountsRoot };
  return wave;
};

/** Keep everything this Entity input's accounts did. */
export const acceptAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const frame = requireOpenEntityInput(env, handle);
  await frame.session.client.keepSavepoint();
  frame.entityInput = null;
};

/** Put every account back where this Entity input found it. */
export const discardAuthorityEntityStage = async (
  env: RuntimeReplica,
  handle: AuthorityEntityStageHandle | null,
): Promise<void> => {
  if (handle === null) return;
  const frame = requireOpenEntityInput(env, handle);
  const undone = await frame.session.client.undoSavepoint();
  frame.latest = savepointPosition(undone);
  frame.entityInput = null;
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

/** One queued transaction as the engine reads it. */
const accountTxRow = (tx: AccountTx): RscoreWireValue =>
  accountTxWire(tx) ?? halt('ACCOUNT_TX_OUTSIDE_PROFILE', { kind: tx.type });

/** `[revision, accountsRoot]`, as every savepoint operation answers. */
const savepointPosition = (
  value: unknown,
): Readonly<{ revision: number; accountsRoot: string }> => {
  if (!Array.isArray(value) || value.length !== 2) {
    return halt('SAVEPOINT_RESPONSE_ARITY', { arity: Array.isArray(value) ? value.length : null });
  }
  const [revision, root] = value;
  if (!(root instanceof Uint8Array) || root.byteLength !== 32) {
    return halt('SAVEPOINT_RESPONSE_ROOT', {});
  }
  return {
    revision: Number(revision),
    accountsRoot: `0x${Buffer.from(root).toString('hex')}`,
  };
};

/** Nothing to seal: the accounts already moved, under an undoable savepoint. */
export const prepareAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
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
  position: Readonly<{ revision: number; accountsRoot: string }>,
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
    if (candidate.entityInput !== null) {
      return halt('CHECKPOINT_ENTITY_INPUT_OPEN', { owner: candidate.session.ownerEntityId });
    }
    const position = candidate.latest ?? savepointPosition(
      await candidate.session.client.pushSavepoint(),
    );
    if (candidate.latest === null) await candidate.session.client.keepSavepoint();
    const checkpoint = await candidate.session.client.checkpointChanges();
    assertCheckpointMatchesCandidate(env, candidate, position, checkpoint);
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

/** The Runtime's own record is durable: every engine may keep its wave. */
export const commitAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const candidates = pending.get(env);
  if (candidates === undefined) return;
  const ordered = [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId));
  for (const candidate of ordered) {
    if (candidate.entityInput !== null) {
      return halt('COMMIT_ENTITY_INPUT_OPEN', { owner: candidate.session.ownerEntityId });
    }
    const kept = savepointPosition(await candidate.session.client.keepSavepoint());
    const expected = candidate.latest;
    if (
      expected !== null
      && (kept.revision !== expected.revision
        || kept.accountsRoot.toLowerCase() !== expected.accountsRoot.toLowerCase())
    ) {
      halt('COMMIT_ROOT_MISMATCH', {
        owner: candidate.session.ownerEntityId,
        preparedRevision: expected.revision,
        committedRevision: kept.revision,
        prepared: expected.accountsRoot,
        committed: kept.accountsRoot,
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
    if (candidate.entityInput !== null) {
      await candidate.session.client.undoSavepoint();
      candidate.entityInput = null;
    }
    await candidate.session.client.undoSavepoint();
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
