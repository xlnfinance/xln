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

/** Whether the rewrite still holds a cross-j pull leg in its retained outbox: the leg og refused to send alone. */
const holdsCrossPullLeg = (after: Runtime): boolean =>
  (after.pendingNetworkOutputs ?? []).some((output) =>
    (Array.isArray(output["entityTxs"]) ? (output["entityTxs"] as readonly WireTx[]) : []).some(
      (tx) => tx.data?.proposal?.frame?.accountTxs?.some((a) => a.type === "cross_pull_lock") === true,
    ),
  );
type WireTx = { readonly data?: { readonly proposal?: { readonly frame?: { readonly accountTxs?: readonly { readonly type: string }[] } } } };

/**
 * og's dispatch halts when one leg of a cross-jurisdiction admission is ready to leave its Runtime without its partner
 * (core/runtime/delivery/dispatch.ts failIncompleteCrossJCohort): the two legs ride one atomic envelope. Found in
 * scenario-cross-j seed 0xc106 once each user deposits collateral: the target user's Account holds a collateral-claim
 * frame in flight, the target leg waits behind it, and the source leg is ready alone. The rewrite has no dispatch: it
 * commits the frame and keeps the lone leg in its retained outbox. Atomic cross-jurisdiction swaps are v2, so the
 * atomic dispatch gate is not built here (review/walk-finding-cross-j-r2c.md).
 */
const loneCrossJLeg: HaltDeparture = {
  name: "a lone cross-jurisdiction leg is retained, not halted on",
  halts: (ogHalt) => /^CROSS_J_INCOMPLETE_COHORT_DROPPED:0x/.test(ogHalt),
  instead: (after) => (holdsCrossPullLeg(after) ? null : "no cross-jurisdiction leg is left in the retained outbox"),
};

export const HALT_DEPARTURES: readonly HaltDeparture[] = [unsignableApproval, staleTransition, loneCrossJLeg];
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
  {
    // core/runtime/frame/cross-j/evidence.ts:33: the ack outputs matching a pair's two legs are not exactly one each and
    // distinct. Two shapes seen: a pure-cancel close (scenario-cross-j seeds 0xc106, 0xc10d) and an open pair (0xc10f).
    // Cross-jurisdiction atomic swaps are v2; not root-caused (og issue 9 candidate).
    name: "a cross-jurisdiction atomic pair's ack outputs are not one per leg",
    issue: "review/og-issues-halts-2026-09-28.md, issue 9 (candidate)",
    halts: (ogHalt) => /RUNTIME_CROSS_J_ATOMIC_ACK_OUTPUTS_INVALID:proposal/.test(ogHalt),
  },
];
export const knownHalt = (ogHalt: string): KnownHalt | undefined => KNOWN_OG_HALTS.find((k) => k.halts(ogHalt));
