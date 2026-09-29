// Where the rewrite departs from og on purpose. Three kinds, each named and each checked on the frame it applies to.
// A halt departure replaces an og Runtime halt: og refuses the whole frame and commits nothing, so no value og commits
// changes; it names the halt by og's own text and says what the rewrite does instead. A stricter departure is the
// reverse: og commits a tx the rewrite refuses for a reason the spec adds; the two states differ from that frame on
// (the walk ends there), so only the comparisons that digest the refused tx are excused and the rewrite must show it
// refused exactly that tx. A lenient departure is a refusal of og's the rewrite does not make (a walk cannot reach it).
import { MAX_LOCK_HORIZON_BLOCKS, MAX_LOCK_HORIZON_MS, unsignableWorkspace } from "../xln.ts";
import type { EntityId, Runtime } from "../xln.ts";

export type HaltDeparture = {
  readonly name: string;
  /** og's halt text (the cause the lane reads off processRuntime) is this departure's halt. */
  readonly halts: (ogHalt: string) => boolean;
  /** What the rewrite must have done instead, on the frame it committed; null when it did, else what is wrong. */
  readonly instead: (after: Runtime) => string | null;
};

type Account = NonNullable<ReturnType<Runtime["entities"]["get"]>>["accountReplicas"] extends ReadonlyMap<EntityId, infer A>
  ? A
  : never;
const accounts = (r: Runtime): readonly Account[] =>
  [...r.entities.values()].flatMap((e) => [...e.accountReplicas.values()]);
const queuedTxs = (a: Account): readonly { readonly type: string; readonly kind?: string; readonly revision?: number }[] =>
  [...a.mempool, ...(a._tag === "proposed" ? a.candidate.frame.txs : [])] as never;

/**
 * og halts signing a settlement approval whose workspace its own projection refuses (review/og-issues-halts-2026-09-28.md,
 * issue 1): settled rows out of the collateral or ondelta range, or past the Account's row cap. A peer reaches it with
 * one settle_update that takes more collateral than the Account holds, which the receiver auto-approves. The rewrite
 * expires the approval instead, so no Entity is left holding one for a workspace nobody can sign.
 */
const unsignableApproval: HaltDeparture = {
  name: "unsignable settlement approval expires",
  halts: (ogHalt) =>
    /SETTLEMENT_PROJECTED_(COLLATERAL|ONDELTA)_RANGE:token=\d+/.test(ogHalt) ||
    ogHalt.includes("ACCOUNT_DELTA_ROW_LIMIT_EXCEEDED:insert:"),
  instead: (after) => {
    const unsignable = (a: Account | undefined): boolean =>
      a?.state.settlement !== undefined && unsignableWorkspace(a.state, a.state.settlement) !== null;
    const held = [...after.entities.values()].some((e) => {
      const approvals = e.state.deferredApprovals;
      const peers = approvals._tag === "kept" ? [...approvals.entries.keys()] : [];
      return peers.some((peer) => unsignable(e.accountReplicas.get(peer as EntityId)));
    });
    return held ? "an Entity still holds an approval og could not sign" : null;
  },
};

/**
 * og halts proposing a settlement transition whose workspace is gone (review/og-issues-halts-2026-09-28.md, issue 3):
 * it settled on chain, or was cleared, while the transition waited in the mempool. The rewrite drops the transition, so
 * no Account on a workspace-less state still queues or proposes one that needs a workspace.
 */
const staleTransition: HaltDeparture = {
  name: "stale settlement transition dropped",
  halts: (ogHalt) => /SETTLEMENT_TRANSITION_PROPOSAL_FAILED:[a-z]+:SETTLEMENT_WORKSPACE_(PREVIOUS_)?MISSING(\\n|"|$)/.test(ogHalt),
  instead: (after) => {
    const needsWorkspace = (tx: { type: string; kind?: string; revision?: number }): boolean =>
      tx.type === "settle_transition" && !(tx.kind === "upsert" && tx.revision === 1);
    const stale = accounts(after).filter((a) => a.state.settlement === undefined && queuedTxs(a).some(needsWorkspace));
    return stale.length === 0 ? null : "an Account without a workspace still carries a settlement transition";
  },
};

export const HALT_DEPARTURES: readonly HaltDeparture[] = [unsignableApproval, staleTransition];
export const haltDeparture = (ogHalt: string): HaltDeparture | undefined => HALT_DEPARTURES.find((d) => d.halts(ogHalt));

/**
 * og halts the rewrite still halts on too: og liveness bugs reported upstream, with no departure yet. A walk may end on
 * one of these; any other og halt a drawn move reaches is a draw whose guard is weaker than og's, and fails the walk.
 */
export type KnownHalt = { readonly name: string; readonly issue: string; readonly halts: (ogHalt: string) => boolean };
export const KNOWN_OG_HALTS: readonly KnownHalt[] = [
  {
    name: "a payment staged beside a deferred settlement approval outdates its hanko",
    issue: "review/og-issues-halts-2026-09-28.md, issue 2",
    halts: (ogHalt) => /SETTLEMENT_TRANSITION_PROPOSAL_FAILED:hanko:POST_SETTLEMENT_PROOF_BODY_HASH_MISMATCH:0x/.test(ogHalt),
  },
];
export const knownHalt = (ogHalt: string): KnownHalt | undefined => KNOWN_OG_HALTS.find((k) => k.halts(ogHalt));

/**
 * Where the rewrite is stricter than og: og accepts and commits what the rewrite refuses, for a reason the spec adds on
 * purpose. Unlike a halt departure nothing of og's is replaced, so the two states differ from the refusal on and a walk
 * ends there. One reason only, named by its refusal code.
 */
export type OgAccountTx = {
  readonly type: string;
  readonly data?: { readonly lockId?: string; readonly timelock?: bigint | number; readonly revealBeforeHeight?: number };
};
/** The frame an og Account tx rides in: its timestamp and J height. */
export type OgFrameClock = { readonly timestamp: number; readonly jHeight: number };
export type StricterDeparture = {
  readonly name: string;
  /** The rewrite's refusal code. */
  readonly reason: string;
  /** og carried this tx in a frame at `at`, and the rewrite refuses it. */
  readonly refuses: (tx: OgAccountTx, at: OgFrameClock) => boolean;
};
/** N2: a lock ending beyond the lock horizon of its frame, in time or in J height (spec: refuse beyond tolerance). */
const lockHorizon: StricterDeparture = {
  name: "a lock beyond the lock horizon is refused",
  reason: "deadline_too_far",
  refuses: (tx, at) =>
    tx.type === "htlc_lock" &&
    (BigInt(tx.data?.timelock ?? 0) > BigInt(at.timestamp) + BigInt(MAX_LOCK_HORIZON_MS) ||
      (tx.data?.revealBeforeHeight ?? 0) > at.jHeight + MAX_LOCK_HORIZON_BLOCKS),
};
export const STRICTER_DEPARTURES: readonly StricterDeparture[] = [lockHorizon];
export const stricterDeparture = (tx: OgAccountTx, at: OgFrameClock): StricterDeparture | undefined =>
  STRICTER_DEPARTURES.find((d) => d.refuses(tx, at));

/** One difference the frame comparison found: which comparison (`head[Bob]`, `components`, ...) and its text. */
export type FrameDiff = { readonly what: string; readonly text: string };
/** The tx og committed that a stricter departure names, and the Entity whose Account frame carried it. */
export type FarLock = { readonly departure: StricterDeparture; readonly lockId: string; readonly proposerName: string };
/**
 * The comparisons a refused lock reaches: the Entity head of the Entity that proposed it, and every digest or shipped
 * row that includes that Entity's Account frame. Height, timestamp, whether a frame advanced, the deferred and queued
 * inputs, and the head of every other Entity are not reached: they must still agree with og.
 */
const DIGESTS: ReadonlySet<string> = new Set(["entityHashes", "components", "postStateHash", "metaRows", "routed", "remote", "remoteFrame"]);
const reachedByLock = (what: string, proposerName: string): boolean =>
  what === `head[${proposerName}]` || DIGESTS.has(what) || what.startsWith("meta[");
/**
 * Whether the rewrite still carries the lock it refused: in an Account's mempool, its candidate frame, its locks, or a
 * retained outbox row. A departure that excuses the difference must find none.
 */
export const rewriteCarriesLock = (after: Runtime, lockId: string): boolean => {
  const inAccount = (a: Account): boolean =>
    a.state.locks.has(lockId) || queuedTxs(a).some((t) => (t as { lockId?: string }).lockId === lockId);
  const inRow = (output: Record<string, unknown>): boolean =>
    (Array.isArray(output["entityTxs"]) ? (output["entityTxs"] as readonly WireAccountInput[]) : []).some((tx) =>
      (tx.data?.proposal?.frame?.accountTxs ?? []).some((a) => a.data?.lockId === lockId));
  return accounts(after).some(inAccount) || (after.pendingNetworkOutputs ?? []).some(inRow);
};
type WireAccountInput = {
  readonly data?: { readonly proposal?: { readonly frame?: { readonly accountTxs?: readonly OgAccountTx[] } } };
};
/**
 * What the walk reports for a frame in which og committed a lock the rewrite refuses: the rewrite must not carry that
 * lock, and every difference outside the comparisons the lock reaches stays a difference.
 */
export const afterStricter = (found: readonly FrameDiff[], far: FarLock, after: Runtime): readonly string[] => [
  ...(rewriteCarriesLock(after, far.lockId) ? [`${far.departure.name}: the rewrite still carries lock ${far.lockId}`] : []),
  ...found.filter((d) => !reachedByLock(d.what, far.proposerName)).map((d) => d.text),
];
