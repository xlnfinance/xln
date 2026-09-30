// Watchtower and dispute draws. Owner: the "watchtower and disputes" area thread.
import { arises, drawn, type Moves, type Step, type WorldMoves } from "./areas.ts";
import { activePairs, batchRoom, one, pairs, pick, queued, quiet, sealed, tx } from "./world-view.ts";
import type { World } from "../rig/world.ts";

// ---- one dispute per run (og entity/tx/handlers/dispute) ----

type DisputeReplica = {
  status?: string;
  counterpartyDisputeProofHanko?: string;
  activeDispute?: { observedOnChain?: boolean; disputeTimeout?: bigint | number };
};
const account = (w: World, x: number, y: number): DisputeReplica | undefined => w.ogAccount(x, y) as never;
/** An Account a dispute has frozen, in any phase: preparing, started, or finalized (frozen for the rest of the run). */
const frozen = (w: World): boolean => pairs(w).some(([x, y]) => (account(w, x, y)?.status ?? "active") !== "active");
/** A dispute the walk began that has not finalized: preparing, or started with its deadline still to come. */
const open = (w: World): boolean =>
  pairs(w).some(([x, y]) => {
    const a = account(w, x, y);
    return a?.status === "dispute_preparing" || a?.activeDispute !== undefined;
  });
/** Accounts a dispute finalized on both sides: frozen, and no dispute left active (scenario.test.ts's closed check). */
export const finalizedDisputes = (w: World): number =>
  pairs(w).filter(([x, y]) => {
    const closed = (a: DisputeReplica | undefined) => a?.status === "disputed" && a.activeDispute === undefined;
    return x < y && closed(account(w, x, y)) && closed(account(w, y, x));
  }).length;
/** Entities x whose Account with y og lets a spoke or hub freeze: the counterparty's dispute proof is held. */
const ready = (w: World): readonly (readonly [number, number])[] =>
  activePairs(w).filter(([x, y]) =>
    account(w, x, y)?.counterpartyDisputeProofHanko !== undefined
    // og start.ts: a start whose ProofBody holds Pulls needs an empty draft batch (a halt otherwise), so start from one
    && !queued(w, x) && !sealed(w, x) && batchRoom(w, x) && quiet(w, x, y));
/** The seconds the earliest observed dispute deadline still has to run, if any. */
const deadlines = (w: World): readonly number[] =>
  pairs(w).flatMap(([x, y]) => {
    const a = account(w, x, y)?.activeDispute;
    return a?.observedOnChain === true && a.disputeTimeout !== undefined ? [Number(a.disputeTimeout)] : [];
  });
const now = (w: World): number => w.lane.env.state.timestamp;
const later = (w: World): readonly number[] => deadlines(w).filter((t) => t * 1000 > now(w));

export const DISPUTES: Moves<"disputes"> = {
  // one dispute per run: a frozen Account stays frozen, so a second would only starve the other areas' draws
  prepareDispute: drawn(
    (w) => !frozen(w) && ready(w).length > 0,
    (w): Step => {
      const [x, y] = pick(w, ready(w));
      return one(w, x, [tx("prepareDispute", { counterpartyEntityId: w.ids[y], description: `walk ${w.ri(100)}` })]);
    },
  ),
  disputeStart: arises("prepareDispute: og drafts it once the evidence cooldown ends, and its own j_broadcast sends it"),
  disputeFinalize: arises("the dispute deadline hook, once the clock passes the challenge window"),
  crossJurisdictionForceSiblingDispute: arises("cross-j dispute salvage"),
  crossJurisdictionSalvage: arises("cross-j dispute salvage"),
};

/**
 * The challenge window is real time on chain (og's live submit stamps blocks with the Runtime clock), so the walk jumps
 * both clocks to its end (og advanceScenarioPastDisputeTimeout); the deadline hook then finalizes on chain. The move is
 * owed while any dispute is open, so a walk that started one finishes it.
 */
export const DISPUTES_WORLD: WorldMoves = {
  deadline: {
    enabled: (w) => later(w).length > 0,
    draw: (w): Step => {
      w.lane.jumpClock(Math.max(...later(w)) * 1000);
      return { runtimeTxs: [], users: [] };
    },
    owed: open,
  },
};

