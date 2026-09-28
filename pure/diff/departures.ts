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

export const HALT_DEPARTURES: readonly HaltDeparture[] = [unsignableApproval];
export const haltDeparture = (ogHalt: string): HaltDeparture | undefined => HALT_DEPARTURES.find((d) => d.halts(ogHalt));
