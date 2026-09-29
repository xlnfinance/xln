// Where the rewrite departs from og on purpose. A departure may only replace an og Runtime halt: og refuses the whole
// frame and commits nothing, so no value og commits changes. Each departure names the halt by og's own text, and says
// what the rewrite does instead, checked on the frame the rewrite committed.
import { unsignableWorkspace } from "../xln.ts";
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
 * A difference between og and the rewrite in a frame's content, not its state, that the project decided to carry rather
 * than fix. `causedBy` reads og's own frame events (the rewrite's are bound into its frame hash and not kept), and only
 * the paths `follows` names are masked, from the frame that shows the cause on: the frame hash and what commits to it.
 * Every other path, the state roots included, is still compared in every frame.
 */
export type KnownDivergence = {
  readonly name: string;
  readonly reason: string;
  readonly probe: string;
  /** One frame event of og's, as its certified head holds it. */
  readonly causedBy: (ogEvent: { readonly message?: unknown }) => boolean;
  /** A diff path (`head[H].frameHash`, `postStateHash.`, ...) that follows from the cause. */
  readonly follows: (path: string) => boolean;
};
/** The frame hash, its Hanko, the hashes to sign and the parent link: what commits to a frame's events. */
const FRAME_HASH_PATH =
  /^(meta\[\d+\]\.(certifiedFrameHeadDigest|entityHead\.(frameHash|parentFrameHash|hankos\.\d+|hashesToSign\.\d+\.hash|collectedSigs\..*))|head\[[^\]]+\]\.(frameHash|parentFrameHash|hankos\.\d+|hashesToSign\.\d+\.hash|collectedSigs\..*)|postStateHash\.)$/;
export const KNOWN_DIVERGENCES: readonly KnownDivergence[] = [
  {
    name: "LEFT-WINS warning counts only the Account mempool",
    reason:
      "og restoreCollisionQueueEvent adds the txs staged earlier in the Entity frame to the `LEFT has N pending txs` frame "
      + "event; the rewrite counts its mempool alone. A diagnostic string bound into the frame hash, no money, deadline or "
      + "consensus state; the spec decides whether diagnostics belong in a frame hash at all (review/walk-finding-left-wins-warning.md).",
    probe: "adding 1 to the rewrite's count moves the first diff on WALK_SEED=0x30de1 from frame 16 to frame 24",
    causedBy: (event) => /^⚠️ LEFT has \d+ pending txs while waiting for RIGHT's ACK$/.test(String(event.message ?? "")),
    follows: (path) => FRAME_HASH_PATH.test(path),
  },
];
