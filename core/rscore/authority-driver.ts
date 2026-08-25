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
import { computeEntityAccountValueHash, projectEntityAccountLeaf } from '../entity/consensus/state-root';
import { computeAccountStateRoot } from '../account/commitment/state-root';
import { getEntityReplicaById } from '../entity/replica/replica-lookup';
import { findAccountByCounterparty } from '../account/state/account-lookup';
import { buildAuthorityWave, type AuthorityWave } from './authority-wave';
import {
  accountConsensusWire,
  accountEnvelopeWire,
  accountSeedWire,
  swapMarketPolicyWire,
} from './shadow-wire';
import { decodeWave, type Wave } from './wave-decode';
import type { RscoreProcessClient } from './client';
import type { AccountReplica } from '../types/account';
import type { RuntimeReplica } from '../runtime/types';

const authorityLog = createStructuredLogger('rscore.authority');

export const authorityDriverEnabled = (): boolean =>
  process.env['XLN_RSCORE_AUTHORITY'] === '1';

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
};

/**
 * One session per Entity that holds accounts, keyed `runtimeId|entityId`: the
 * engine signs as one board, and a Runtime hosts more than one Entity — a hub
 * and its book live side by side in the H1 Runtime.
 */
const sessions = new Map<string, Session | 'disabled'>();
const captured = new Map<string, AuthorityWave>();
/** Candidates open in each Entity's engine, by Runtime. */
const pending = new Map<string, PendingWave[]>();

const report = {
  waves: 0,
  framesProposed: 0,
  inputsApplied: 0,
  leavesChecked: 0,
  accountsSeeded: 0,
  emptyFrames: 0,
  commits: 0,
  aborts: 0,
};

export const authorityDriverReport = (): typeof report => ({ ...report });

/** A halt, not a warning: in safe mode the two engines must agree exactly. */
const halt = (code: string, detail: Record<string, unknown>): never => {
  authorityLog.error('authority.halt', { code, ...detail });
  console.error(`RSCORE_AUTHORITY_HALT ${code} ${JSON.stringify(detail)}`);
  throw new Error(`RSCORE_AUTHORITY_HALT:${code}`);
};

/**
 * Take the frame the collector holds before the reducer closes it. Called on
 * the Runtime frame boundary; the wave is prepared later, outside the mutation
 * the collector was watching.
 */
export const captureAuthorityWave = (runtimeId: string): void => {
  if (!authorityDriverEnabled()) return;
  // The collector is keyed by the id exactly as the reducer saw it; the driver
  // is keyed by its normalised form, because it is reached from a different
  // env object. Normalising only on one side loses every frame silently.
  captured.set(normalisedKey(runtimeId), buildAuthorityWave(runtimeId));
};

const normalisedKey = (runtimeId: unknown): string => String(runtimeId ?? '').trim().toLowerCase();

const runtimeKey = (env: RuntimeReplica): string => normalisedKey(env.runtimeId);

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

const armSession = async (env: RuntimeReplica, ownerEntityId: string): Promise<Session | 'disabled'> => {
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
  const hello = (await client.hello(workers, swapMarketPolicyWire(), { privateKey, signerId })) as unknown[];
  const derived = `0x${Buffer.from(hello[5] as Uint8Array).toString('hex')}`.toLowerCase();
  if (derived !== ownerEntityId) {
    client.kill();
    return disable(ownerEntityId, `ENGINE_ENTITY_MISMATCH:${derived}`);
  }
  const accounts = accountsOf(env, ownerEntityId);
  const seeds = [...accounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([counterpartyId, account]) => accountSeedWire(
      ownerEntityId,
      counterpartyId,
      account.state,
      accountEnvelopeWire(account),
      accountConsensusWire(account),
    ));
  await client.restore(0, seeds);
  report.accountsSeeded += seeds.length;
  authorityLog.error('authority.armed', { owner: ownerEntityId, accounts: seeds.length, workers });
  return {
    client,
    ownerEntityId,
    seeded: new Set(accounts.keys()),
    seededProjection: new Map([...accounts.entries()]
      .map(([counterpartyId, account]) => [counterpartyId, projectEntityAccountLeaf(account)])),
  };
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
  if (!authorityDriverEnabled()) return;
  const key = runtimeKey(env);
  // Entities holding no accounts have nothing for this engine to own; an
  // Entity that opens its first account is armed at the frame after it did.
  for (const replica of env.state.eReplicas.values()) {
    if (replica.state.accounts.size === 0) continue;
    const ownerEntityId = replica.entityId.trim().toLowerCase();
    const sessionKey = `${key}|${ownerEntityId}`;
    const existing = sessions.get(sessionKey);
    if (existing === 'disabled') continue;
    if (existing === undefined) {
      sessions.set(sessionKey, await armSession(env, ownerEntityId));
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
    )));
    for (const [counterpartyId, account] of fresh) {
      existing.seeded.add(counterpartyId);
      existing.seededProjection.set(counterpartyId, projectEntityAccountLeaf(account));
    }
    report.accountsSeeded += fresh.length;
  }
};

/**
 * Hand the collected frame to the engine and hold its answer against
 * TypeScript's. Returns with a candidate pending in the engine, which the
 * caller must either commit (after its own record is durable) or abort.
 */
export const prepareAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled()) return;
  const key = runtimeKey(env);
  const wave = captured.get(key);
  captured.delete(key);
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
  pending.set(key, candidates);
  for (const entity of wave.entities) {
    const ownerEntityId = entity.ownerEntityId;
    const session = sessions.get(`${key}|${ownerEntityId}`);
    if (session === 'disabled') continue;
    if (session === undefined) {
      // The frame opened with this Entity holding no accounts and closed with
      // a wave for it: the accounts it touches were opened inside the frame,
      // so there is no pre-frame state to seed from.
      halt('UNARMED_WAVE', { owner: ownerEntityId });
      return;
    }
    assertWaveAccountsSeeded(session, entity.ops);
    const { result, token } = await session.client.prepareAccountWave({
      entities: [{
        ...entity,
        ownerEntityId: Uint8Array.from(Buffer.from(ownerEntityId.slice(2), 'hex')),
      }],
    });
    const decoded = decodeWave(result);
    report.waves += 1;
    report.framesProposed += decoded.proposals.filter(row => row.frame !== null).length;
    report.inputsApplied += decoded.applied.length;
    compareWithTypescript(env, ownerEntityId, decoded, session);
    candidates.push({ session, token, result: decoded });
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

const safeStringify = (value: unknown): string => {
  try {
    return JSON.stringify(value, (_key, entry) =>
      typeof entry === 'bigint' ? entry.toString() : entry) ?? 'undefined';
  } catch {
    return String(value);
  }
};

const compareWithTypescript = (
  env: RuntimeReplica,
  ownerEntityId: string,
  wave: Wave,
  session?: Session,
): void => {
  const accounts = accountsOf(env, ownerEntityId);
  const proposed = new Map(wave.proposals
    .filter(row => row.frame !== null)
    .map(row => [row.accountId, row.frame!]));
  for (const leaf of wave.touched) {
    const account = accounts.get(leaf.accountId)
      ?? findAccountByCounterparty(accounts, ownerEntityId, leaf.accountId);
    if (!account) {
      halt('TOUCHED_ACCOUNT_MISSING', { account: leaf.accountId });
      return;
    }
    const expected = computeEntityAccountValueHash(account).toLowerCase();
    if (expected !== leaf.entityAccountLeaf.toLowerCase()) {
      halt('LEAF_MISMATCH', {
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
        rustProposal: proposed.get(leaf.accountId) === undefined ? null : {
          height: proposed.get(leaf.accountId)!.height,
          stateHash: proposed.get(leaf.accountId)!.stateHash,
          accountStateRoot: proposed.get(leaf.accountId)!.accountStateRoot,
          txs: proposed.get(leaf.accountId)!.accountTxs.length,
        },
        currentFrame: account.currentFrame?.height ?? null,
        movedSinceSeed: movedCarriedFields(session, leaf.accountId, account),
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

/** The Runtime's own record is durable: every engine may keep its wave. */
export const commitAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled()) return;
  const key = runtimeKey(env);
  const candidates = pending.get(key);
  if (candidates === undefined) return;
  pending.delete(key);
  for (const candidate of candidates) {
    const committed = (await candidate.session.client.commit(candidate.token)) as unknown[];
    const root = `0x${Buffer.from(committed[1] as Uint8Array).toString('hex')}`;
    if (root.toLowerCase() !== candidate.result.accountsRoot.toLowerCase()) {
      halt('COMMIT_ROOT_MISMATCH', {
        owner: candidate.session.ownerEntityId,
        prepared: candidate.result.accountsRoot,
        committed: root,
      });
    }
    report.commits += 1;
  }
};

/** The Runtime could not make its record durable: the engines take it back. */
export const abortAuthorityWave = async (env: RuntimeReplica): Promise<void> => {
  if (!authorityDriverEnabled()) return;
  const key = runtimeKey(env);
  const candidates = pending.get(key);
  if (candidates === undefined) return;
  pending.delete(key);
  for (const candidate of candidates) {
    await candidate.session.client.abort(candidate.token);
    report.aborts += 1;
  }
};

export const printAuthorityDriverReport = (): void => {
  if (!authorityDriverEnabled()) return;
  console.error(`RSCORE_AUTHORITY_DRIVER ${JSON.stringify(authorityDriverReport())}`);
};

export const shutdownAuthorityDriver = async (): Promise<void> => {
  for (const session of sessions.values()) {
    if (session === 'disabled') continue;
    try { await session.client.shutdown(); } catch { session.client.kill(); }
  }
  sessions.clear();
  captured.clear();
  pending.clear();
};
