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

import { createStructuredLogger } from '../support/logger';
import { getSignerPrivateKeyIfAvailable } from '../account/crypto';
import { generateLazyEntityId } from '../entity/factory';
import {
  computeEntityAccountLeafDigest,
  computeEntityAccountValueHash,
  projectEntityAccountLeaf,
} from '../entity/consensus/state-root';
import { computeAccountStateRoot } from '../account/commitment/state-root';
import { getEntityReplicaById } from '../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../account/state/account-lookup';
import { buildAuthorityWave, type AuthorityWave } from './authority-wave';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  swapMarketPolicyDigest,
  swapMarketPolicyWire,
} from './shadow-wire';
import { requireAccountDeltaTransformerAddress } from '../account/consensus/helpers';
import { decodeWave, waveOutputRow, type Wave } from './wave-decode';
import type { ShadowOutputRow } from './shadow-wire';
import {
  RSCORE_PROCESS_ABI_VERSION,
  RSCORE_PROCESS_PROFILE,
  RSCORE_PROTOCOL_FINGERPRINT,
  type RscoreCheckpointChanges,
  type RscoreCheckpointToken,
  type RscoreExactCheckpoint,
  type RscoreProcessClient,
} from './client';
import { assertRscoreCheckpointCandidate } from './checkpoint-wire';
import type { AccountReplica } from '../types/account';
import type { RuntimeReplica } from '../runtime/types';
import { buffersEqual, safeStringify } from '../protocol/serialization';

const authorityLog = createStructuredLogger('rscore.authority');

export const authorityDriverEnabled = (env?: RuntimeReplica): boolean =>
  process.env['XLN_RSCORE_AUTHORITY'] === '1' &&
  (env === undefined || env.accountAuthoritySuppressed !== true);

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
  /** Accounts the engine has been seeded with, so a new one is seeded once. */
  seeded: Set<string>;
  /**
   * The leaf projection each account was seeded with. The engine carries the
   * fields it does not own itself, so when a leaf disagrees the first question
   * is which carried field this frame moved underneath it.
   */
  seededProjection: Map<string, Record<string, unknown>>;
};

type PendingWave = {
  session: Session;
  token: Buffer;
  result: Wave;
  checkpoint?: RscoreCheckpointChanges;
};

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

const openAuthoritySession = async (
  env: RuntimeReplica,
  ownerEntityId: string,
): Promise<Session | 'disabled'> => {
  const signerId = signerIdFor(env, ownerEntityId);
  if (!signerId) return disable(ownerEntityId, 'SIGNER_UNKNOWN');
  // The engine signs as one member of a one-of-one board, so the Entity it
  // will sign for is fixed by that member's address. A registered or numbered
  // board hashes to something else and is refused here, rather than being
  // discovered at the first frame hash.
  const expected = generateLazyEntityId([signerId], 1n).toLowerCase();
  if (expected !== ownerEntityId) return disable(ownerEntityId, `ENTITY_NOT_LAZY_1_OF_1:${expected}`);
  // The key this Runtime signs that Entity's frames with. Derived from a label
  // only this Runtime knows, so the engine cannot rebuild it from the address
  // and is handed the key itself.
  const privateKey = getSignerPrivateKeyIfAvailable(env, signerId);
  if (!privateKey) return disable(ownerEntityId, 'SIGNER_KEY_UNAVAILABLE');

  const { RscoreProcessClient } = await import('./client');
  const binaryPath = process.env['XLN_RSCORE_BINARY']
    ?? new URL('../../rscore/target/release/xln-rscore', import.meta.url).pathname;
  const client = new RscoreProcessClient(binaryPath, {
    engineGeneration: Buffer.alloc(8, 0x5d),
    runtimeId: Buffer.alloc(20, 0x5d),
    sessionId: Buffer.alloc(16, 0x5d),
  });
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
  const accounts = accountsOf(env, ownerEntityId);
  return {
    client,
    ownerEntityId,
    seeded: new Set(accounts.keys()),
    seededProjection: new Map([...accounts.entries()]
      .map(([counterpartyId, account]) => [counterpartyId, projectEntityAccountLeaf(account)])),
  };
};

const armSession = async (env: RuntimeReplica, ownerEntityId: string): Promise<Session | 'disabled'> => {
  const session = await openAuthoritySession(env, ownerEntityId);
  if (session === 'disabled') return session;
  const accounts = accountsOf(env, ownerEntityId);
  const seeds = [...accounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([counterpartyId, account]) => accountSeedWire(
      ownerEntityId,
      counterpartyId,
      account.state,
      accountEnvelopeWire(account),
      accountConsensusWire(account),
      requireAccountDeltaTransformerAddress(env.state, account.state),
    ));
  await session.client.bootstrapAccounts(0, seeds);
  report.accountsSeeded += seeds.length;
  authorityLog.error('authority.armed', {
    owner: ownerEntityId,
    accounts: seeds.length,
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
 * Arm the engine, and seed it, on the state as it stands *before* this frame.
 *
 * This is the whole reason the hook exists at the frame's opening rather than
 * at its close: a session armed after TypeScript applied would be seeded with
 * the frame's own result and would then apply that frame a second time. Its
 * first leaf would disagree, and the disagreement would look like an execution
 * bug rather than a seeding one.
 */
export const armAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const runtimeSessions = sessionMap(env, true);
  // Entities holding no accounts have nothing for this engine to own; an
  // Entity that opens its first account is armed at the frame after it did.
  for (const replica of env.state.eReplicas.values()) {
    if (replica.state.accounts.size === 0) continue;
    const ownerEntityId = replica.entityId.trim().toLowerCase();
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
    // Accounts opened by earlier frames: seeded here, before this frame moves
    // them, so the engine starts each frame where TypeScript starts it.
    const fresh = [...replica.state.accounts.entries()]
      .filter(([counterpartyId]) => !existing.seeded.has(counterpartyId))
      .sort(([left], [right]) => left.localeCompare(right));
    if (fresh.length === 0) continue;
    await existing.client.upsertAccounts(fresh.map(([counterpartyId, account]) => accountSeedWire(
      ownerEntityId,
      counterpartyId,
      account.state,
      accountEnvelopeWire(account),
      accountConsensusWire(account),
      requireAccountDeltaTransformerAddress(env.state, account.state),
    )));
    for (const [counterpartyId, account] of fresh) {
      existing.seeded.add(counterpartyId);
      existing.seededProjection.set(counterpartyId, projectEntityAccountLeaf(account));
    }
    report.accountsSeeded += fresh.length;
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
};

const prepareTrackedCandidate = async (
  session: Session,
  request: Parameters<RscoreProcessClient['prepareAccountWave']>[0],
  validate: (result: Wave) => Promise<void>,
): Promise<PendingWave> => {
  let prepared: Awaited<ReturnType<RscoreProcessClient['prepareAccountWave']>>;
  try {
    prepared = await session.client.prepareAccountWave(request);
  } catch (error) {
    // A malformed/truncated reply can hide a live candidate token. Kill the
    // process; only exact durable recovery may decide its next state.
    session.client.kill();
    throw error;
  }
  try {
    const result = decodeWave(prepared.result);
    await validate(result);
    return { session, token: prepared.token, result };
  } catch (error) {
    try {
      await session.client.abort(prepared.token);
      report.aborts += 1;
    } catch (abortError) {
      session.client.kill();
      throw new AggregateError(
        [error, abortError],
        `RSCORE_AUTHORITY_PREPARE_VALIDATION_ABORT_FAILED:${session.ownerEntityId}`,
      );
    }
    throw error;
  }
};

/**
 * Hand the collected frame to the engine and hold its answer against
 * TypeScript's. Returns with a candidate pending in the engine, which the
 * caller must either commit (after its own record is durable) or abort.
 */
export const prepareAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled(env)) return;
  const wave = captured.get(env);
  captured.delete(env);
  if (wave === undefined || wave.kind === 'empty') {
    if (wave?.kind === 'empty') report.emptyFrames += 1;
    return;
  }
  if (wave.kind === 'ineligible') {
    // No quiet repair: an engine that missed part of a frame is behind, and
    // every frame after it would be compared against the wrong state.
    halt('WAVE_INELIGIBLE', { reason: wave.reason });
    return;
  }
  const candidates: PendingWave[] = [];
  pending.set(env, candidates);
  const runtimeSessions = sessionMap(env, false);
  for (const entity of wave.entities) {
    const ownerEntityId = entity.ownerEntityId;
    const session = runtimeSessions?.get(ownerEntityId);
    if (session === 'disabled') {
      return halt('OWNER_AUTHORITY_INELIGIBLE', { owner: ownerEntityId });
    }
    if (session === undefined) {
      // The frame opened with this Entity holding no accounts and closed with
      // a wave for it: the accounts it touches were opened inside the frame,
      // so there is no pre-frame state to seed from.
      halt('UNARMED_WAVE', { owner: ownerEntityId });
      return;
    }
    assertWaveAccountsSeeded(session, entity.ops);
    const candidate = await prepareTrackedCandidate(session, {
      entities: [{
        ...entity,
        ownerEntityId: Uint8Array.from(Buffer.from(ownerEntityId.slice(2), 'hex')),
      }],
    }, decoded => compareWithTypescript(
      env,
      ownerEntityId,
      decoded,
      entity.expectedOutputs,
      session,
    ));
    report.waves += 1;
    report.framesProposed += candidate.result.proposals.filter(row => row.frame !== null).length;
    report.inputsApplied += candidate.result.applied.length;
    candidates.push(candidate);
  }
};

/**
 * Every account the wave touches must already be in the engine, seeded from
 * the state it had before this frame. An account opened during this very frame
 * has no such state: TypeScript created it while applying, and seeding it now
 * would seed the answer. That case halts rather than being papered over.
 */
const assertWaveAccountsSeeded = (session: Session, ops: readonly unknown[]): void => {
  for (const op of ops) {
    const accountId = accountIdOf(op);
    if (accountId === null || session.seeded.has(accountId)) continue;
    halt('ACCOUNT_OPENED_MID_FRAME', { owner: session.ownerEntityId, account: accountId });
    return;
  }
};

/** The account id inside an encoded operation: `[0, accountId, txs]` or `[1, row]`. */
const accountIdOf = (op: unknown): string | null => {
  if (!Array.isArray(op)) return null;
  if (op[0] === 0) return hexOf(op[1]);
  if (op[0] === 1 && Array.isArray(op[1])) return hexOf(op[1][1]);
  return null;
};

const hexOf = (value: unknown): string | null =>
  value instanceof Uint8Array ? `0x${Buffer.from(value).toString('hex')}` : null;

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
    const verdict = applied.verdict;
    if (verdict.kind !== 'frameCommitted' && verdict.kind !== 'ackCommitted') continue;
    if (verdict.outputs.length === 0) continue;
    const rows = byAccount.get(applied.accountId) ?? [];
    rows.push(...verdict.outputs.map(waveOutputRow));
    byAccount.set(applied.accountId, rows);
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

const compareWithTypescript = async (
  env: RuntimeReplica,
  ownerEntityId: string,
  wave: Wave,
  expectedOutputs: ReadonlyMap<string, readonly ShadowOutputRow[]>,
  session?: Session,
): Promise<void> => {
  compareOutputs(ownerEntityId, wave, expectedOutputs);
  const accounts = accountsOf(env, ownerEntityId);
  const typescriptAccountsRoot = accountMapRoot(accounts, ownerEntityId);
  if (typescriptAccountsRoot !== wave.accountsRoot.toLowerCase()) {
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
    if ((candidate.stateHash ?? '').toLowerCase() !== frame.stateHash.toLowerCase()) {
      halt('FRAME_HASH_MISMATCH', {
        account: proposal.accountId,
        height: frame.height,
        typescript: candidate.stateHash ?? null,
        rust: frame.stateHash,
      });
    }
  }
};

const openEmptyCandidate = async (
  env: RuntimeReplica,
  session: Session,
): Promise<PendingWave> => {
  const candidate = await prepareTrackedCandidate(
    session,
    { entities: [] },
    result => compareWithTypescript(env, session.ownerEntityId, result, new Map(), session),
  );
  report.waves += 1;
  return candidate;
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
  const candidates = pending.get(env) ?? [];
  if (!pending.has(env)) pending.set(env, candidates);
  const byOwner = new Map(candidates.map(candidate => [candidate.session.ownerEntityId, candidate]));
  for (const session of sessionEntriesForRuntime(env)) {
    if (byOwner.has(session.ownerEntityId)) continue;
    const candidate = await openEmptyCandidate(env, session);
    candidates.push(candidate);
    byOwner.set(session.ownerEntityId, candidate);
  }
  const inputs: AuthorityCheckpointStorageInput[] = [];
  for (const candidate of [...candidates]
    .sort((left, right) => left.session.ownerEntityId.localeCompare(right.session.ownerEntityId))) {
    if (candidate.checkpoint) {
      halt('CHECKPOINT_ALREADY_EXPORTED', { owner: candidate.session.ownerEntityId });
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
  pending.delete(env);
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
};
