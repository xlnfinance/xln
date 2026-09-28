// Multi-signer boards and Entity provider action draws. Owner: the "boards and provider actions" area thread.
// The boards area of the model walk (diff/walk.ts): board governance
// (propose, vote), a board rotation (boardHandover), a reserve withdrawal to an external address (r2e) and the five
// EntityProvider actions. Each draw reads og's committed state and offers only inputs whose og guards hold; a plain
// Error in an og handler halts og's Runtime, so a refused input here would be a hostile move, which is not this area's.
//
// The guards, mined with ast-grep (`if ($C) throw $E`) over og 566c850:
//
//   propose  entity/tx/handlers/system/basic.ts:92
//     the proposer holds a board share                        ENTITY_PROPOSAL_PROPOSER_UNKNOWN
//     the action is a collective_message or an exact          ENTITY_PROPOSAL_ACTION_* (auth/authorization.ts:159)
//       entity_transaction over collective txs                ENTITY_COLLECTIVE_ACTION_TX_FORBIDDEN
//     fewer than 100 open proposals, none by this proposer    ENTITY_PROPOSAL_PENDING_LIMIT_EXCEEDED,
//                                                             ENTITY_PROPOSAL_PROPOSER_PENDING_LIMIT
//                                                             (tx/processing/proposals.ts:47)
//     proposer is the command's signer                        ENTITY_COMMAND_AUTHOR_FIELD_MISMATCH
//                                                             (command/command-codec.ts:101)
//     A proposer whose share meets the threshold executes at once, so on a 1-of-1 board nothing stays open.
//
//   vote  entity/tx/handlers/system/basic.ts:159
//     the proposal is open                                    ENTITY_PROPOSAL_VOTE_TARGET_MISSING
//     the voter holds a board share and is the command signer ENTITY_PROPOSAL_VOTER_UNKNOWN,
//                                                             ENTITY_COMMAND_AUTHOR_FIELD_MISMATCH
//     the proposal was made under the current board and epoch ENTITY_PROPOSAL_BOARD_MISMATCH, _EPOCH_MISMATCH
//     the voter has not voted on it                           ENTITY_PROPOSAL_DUPLICATE_VOTE
//
//   r2e  entity/tx/handlers/j-batch/r2e.ts
//     the draft batch plus this op stays within the reserve   "Insufficient spendable reserve" (og's own
//       after debts                                           getReserveCandidateIssue decides it here)
//     the draft batch holds fewer than 50 ops                 J_BATCH_LIMIT_EXCEEDED (batch/index.ts:204, :224)
//     A sealed batch does not block it: og queues into the draft and only warns.
//
//   entityProviderTransfer, entityProviderReleaseControlShares  entity/tx/handlers/entity-provider-action.ts:152
//     no provider action is pending                           ENTITY_PROVIDER_ACTION_PENDING
//     the Entity has a certified board record                 ENTITY_PROVIDER_ACTION_BOARD_AUTHORITY_MISSING
//     a non-zero recipient address                            ENTITY_PROVIDER_ACTION_RECIPIENT_INVALID
//     transfer: amount > 0, tokenId a bigint >= 0             ENTITY_PROVIDER_ACTION_AMOUNT_INVALID, _TOKEN_ID_INVALID
//     release: not both amounts zero, purpose <= 1024 bytes   _RELEASE_AMOUNT_EMPTY, _PURPOSE_OVERSIZED
//
//   entityProviderCancelAction  entity-provider-action.ts:240
//     a pending action that is not itself a cancel            _CANCEL_PENDING_MISSING, _CANCEL_ALREADY_PENDING
//     its hash, nonce and board epoch are the current ones    _CANCEL_TARGET_MISMATCH, _PENDING_NONCE_CORRUPT,
//                                                             assertEntityProviderActionIntent
//
//   entityProviderProposeControlBoard  entity/tx/handlers/control-board-proposal.ts:76
//     target and shareholder both have certified records      CONTROL_BOARD_PROPOSAL_TARGET_AUTHORITY_MISSING,
//                                                             _SHAREHOLDER_AUTHORITY_MISSING
//     newBoardHash is a bytes32, actionNonce in 1..2^256-1    PROTOCOL_BOARD_HASH_INVALID, _NONCE_INVALID
//     every supporter is certified and signs the exact hash   _SUPPORTER_* (the walk offers no supporters)
//
//   entityProviderActivateBoard  control-board-proposal.ts:161
//     the target has a certified record                       CONTROL_BOARD_ACTIVATION_TARGET_MISSING
//
// Every EntityProvider kind needs a certified board record, which only an on-chain EntityRegistered (a numbered
// Entity) gives, and vote needs a board of several signers and a lane that submits as any of them. The base world has
// neither, so those rows stay pending, and their draws wait in WAITING until the world gives their preconditions: the
// area walk fails on a drawn kind it never commits.
import { getReserveCandidateIssue } from "../../../core/entity/tx/handlers/j-batch/j-batch-reserve-admission.ts";
import {
  batchOpCount,
  createEmptyBatch,
  J_BATCH_CONTRACT_LIMITS,
  type JBatch,
} from "../../../core/jurisdiction/machine/batch/index.ts";
import {
  getCertifiedBoardNodeStore,
  resolveObserverCertifiedBoardRecord,
} from "../../../core/jurisdiction/machine/board-registry/index.ts";
import { LIMITS } from "../../../core/config/constants.ts";
import { unwrap } from "../../xln_run.ts";
import { entityTransactionAction, type EntityTx, type ProposalAction } from "../../xln.ts";
import { SIGNERS } from "../lane.ts";
import { TOKEN, type World } from "../world.ts";
import { arises, drawn, pending, type Move, type Moves, type WorldMoves } from "./areas.ts";
import { amount, one, PARTIES, pick } from "./world-view.ts";

// ---- the domain: an Entity's board, its open proposals, its provider action ----

type Choice = "yes" | "no";
/** og Proposal (entity/types.ts), as far as a draw reads it. */
type OgProposal = { readonly id: string; readonly proposer: string; readonly votes: ReadonlyMap<string, unknown> };
/** og EntityProviderActionIntent (types/entity-provider-actions.ts), as far as a draw reads it. */
type OgIntent = {
  readonly actionHash: string;
  readonly actionNonce: bigint;
  readonly boardEpoch: bigint;
  readonly payload: { readonly kind: string };
};
type OgActionState = { readonly confirmedNonce: bigint; readonly pending?: OgIntent };
/** og CertifiedBoardRecord (jurisdiction/machine/board-registry), as far as a draw reads it. */
type OgBoardRecord = { readonly boardEpoch: number | bigint; readonly boardHash: string };
/** og's committed Entity, through the fields this area reads. */
type OgBoardEntity = {
  readonly entityId: string;
  readonly config: { readonly validators: readonly string[]; readonly threshold: bigint };
  readonly proposals: ReadonlyMap<string, OgProposal>;
  readonly entityProviderActionState?: OgActionState;
};

/** External accounts: the signers' own addresses, which are EOAs and never Entity ids. */
const EXTERNAL = SIGNERS.map((s) => s.toLowerCase());
/** An address as the bytes32 og's reserveToExternalToken takes (Depository.sol:685: the high 96 bits zero). */
const asBytes32 = (address: string): string => `0x${address.slice(2).padStart(64, "0")}`;

const entity = (w: World, x: number): OgBoardEntity | undefined => w.ogState(x) as OgBoardEntity | undefined;
const signerOf = (x: number): string => SIGNERS[x]!.toLowerCase();
const where = <T>(xs: readonly T[], keep: (x: T) => boolean): readonly T[] => xs.filter(keep);

/** og resolveObserverCertifiedBoardRecord, as `observer` sees `subject`'s board. */
const certified = (w: World, observer: number, subject: string): OgBoardRecord | undefined => {
  const state = w.ogState(observer);
  const store = getCertifiedBoardNodeStore(w.lane.env as never);
  return state === undefined
    ? undefined
    : (resolveObserverCertifiedBoardRecord(state as never, store, subject) as OgBoardRecord | null) ?? undefined;
};
const selfCertified = (w: World, x: number): OgBoardRecord | undefined => certified(w, x, w.ids[x]!);
const actionOf = (w: World, x: number): OgActionState =>
  entity(w, x)?.entityProviderActionState ?? { confirmedNonce: 0n };

// ---- propose ----

/** og assertEntityProposalCapacity: room on the board, and no open proposal by this proposer. */
const canPropose = (w: World, x: number): boolean => {
  const proposals = [...(entity(w, x)?.proposals.values() ?? [])];
  return entity(w, x) !== undefined
    && proposals.length < LIMITS.MAX_PENDING_PROPOSALS_PER_ENTITY
    && proposals.every((p) => p.proposer.toLowerCase() !== signerOf(x));
};
/** A collective action the board may approve: a message, or a profile edit the Entity then applies. */
const proposalAction = (w: World, x: number): ProposalAction => {
  const profileEdit: EntityTx = {
    type: "profile-update",
    data: { profile: { entityId: w.ids[x]!, name: `B${w.ri(100)}`, bio: "board" } },
  } as EntityTx;
  const actions: readonly ProposalAction[] = [
    { type: "collective_message", data: { message: `resolution ${w.ri(1_000)}` } },
    unwrap(entityTransactionAction([profileEdit])),
  ];
  return pick(w, actions);
};

// ---- vote ----

type Ballot = { readonly entity: number; readonly proposal: OgProposal; readonly voter: number };
/**
 * Every (Entity, open proposal, member) where the member has not voted. The lane submits as the Entity's own signer,
 * so a member is a signer this world hosts under that index.
 */
const ballots = (w: World): readonly Ballot[] =>
  PARTIES.flatMap((x) => {
    const members = entity(w, x)?.config.validators.map((v) => v.toLowerCase()) ?? [];
    const open = [...(entity(w, x)?.proposals.values() ?? [])];
    return open.flatMap((proposal) =>
      where([x], (v) => members.includes(signerOf(v)) && !proposal.votes.has(signerOf(v)))
        .map((voter) => ({ entity: x, proposal, voter })));
  });

// ---- r2e ----

/** og getReserveCandidateIssue over og's committed draft batch: the handler's own admission check. */
const admits = (w: World, x: number, withdrawal: bigint): boolean => {
  const state = w.ogState(x);
  const candidate = {
    type: "reserveToExternalToken" as const,
    receivingEntity: asBytes32(EXTERNAL[0]!),
    tokenId: 1,
    amount: withdrawal,
  };
  return state !== undefined && getReserveCandidateIssue(state as never, candidate) === null;
};
/** og's committed draft batch: the ops queued for the next broadcast. */
const draftOf = (w: World, x: number): JBatch => (w.batchOf(x)?.batch as JBatch | undefined) ?? createEmptyBatch();
/** og requireBatchRoom: one more op keeps the draft batch within the contract's op limit. */
const batchRoom = (w: World, x: number): boolean => batchOpCount(draftOf(w, x)) < J_BATCH_CONTRACT_LIMITS.maxTotalOps;
const withdrawers = (w: World): readonly number[] =>
  where(PARTIES, (x) => w.reserveOf(x) > 0n && batchRoom(w, x) && admits(w, x, 1n));
/** A share of the reserve when the draft batch leaves room for it, else the smallest withdrawal. */
const withdrawal = (w: World, x: number): bigint => {
  const share = 1n + (w.reserveOf(x) * BigInt(w.ri(20))) / 100n;
  return admits(w, x, share) ? share : 1n;
};

// ---- EntityProvider actions ----

/** og handleAction's preconditions: a certified board and no pending provider action. */
const actionReady = (w: World): readonly number[] =>
  where(PARTIES, (x) => selfCertified(w, x) !== undefined && actionOf(w, x).pending === undefined);
/** og handleEntityProviderCancelAction's preconditions: the exact current pending action, not itself a cancel. */
const cancellable = (w: World): readonly number[] =>
  where(PARTIES, (x) => {
    const { pending, confirmedNonce } = actionOf(w, x);
    const record = selfCertified(w, x);
    return pending !== undefined
      && record !== undefined
      && pending.payload.kind !== "cancelPendingAction"
      && pending.actionNonce === confirmedNonce + 1n
      && pending.boardEpoch === BigInt(record.boardEpoch);
  });
type Control = { readonly shareholder: number; readonly target: string };
/** Shareholder and target both certified, as the shareholder observes them. */
const controls = (w: World): readonly Control[] =>
  PARTIES.flatMap((shareholder) =>
    selfCertified(w, shareholder) === undefined
      ? []
      : where(w.ids, (target) => certified(w, shareholder, target) !== undefined).map((target) => ({ shareholder, target })));
/** A fresh bytes32 board hash: a board the walk proposes, never the zero word. */
const boardHash = (w: World): string =>
  `0x${Array.from({ length: 8 }, () => (1 + w.ri(2 ** 31)).toString(16).padStart(8, "0")).join("")}`;

// ---- the moves ----

type Waiting =
  | "vote"
  | "entityProviderTransfer"
  | "entityProviderReleaseControlShares"
  | "entityProviderCancelAction"
  | "entityProviderProposeControlBoard"
  | "entityProviderActivateBoard";
/** Draws whose preconditions the base world does not give yet; each row moves into BOARDS when the world does. */
export const WAITING: { readonly [K in Waiting]: Move } = {
  vote: drawn(
    (w) => ballots(w).length > 0,
    (w) => {
      const ballot = pick(w, ballots(w));
      const choice: Choice = pick(w, ["yes", "no"] as const);
      return one(w, ballot.voter, [{
        type: "vote",
        data: { proposalId: ballot.proposal.id, voter: signerOf(ballot.voter), choice },
      }]);
    },
  ),
  entityProviderTransfer: drawn(
    (w) => actionReady(w).length > 0,
    (w) => {
      const x = pick(w, actionReady(w));
      return one(w, x, [{
        type: "entityProviderTransfer",
        data: { to: pick(w, EXTERNAL), tokenId: BigInt(TOKEN), amount: amount(w, 1_000) },
      }]);
    },
  ),
  entityProviderReleaseControlShares: drawn(
    (w) => actionReady(w).length > 0,
    (w) => {
      const x = pick(w, actionReady(w));
      const [controlAmount, dividendAmount] = pick(w, [
        [amount(w, 100), 0n],
        [0n, amount(w, 100)],
        [amount(w, 100), amount(w, 100)],
      ] as const);
      const purpose = `grant ${w.ri(1_000)}`;
      return one(w, x, [{
        type: "entityProviderReleaseControlShares",
        data: { recipientAddress: pick(w, EXTERNAL), controlAmount, dividendAmount, purpose },
      }]);
    },
  ),
  entityProviderCancelAction: drawn(
    (w) => cancellable(w).length > 0,
    (w) => {
      const x = pick(w, cancellable(w));
      return one(w, x, [{ type: "entityProviderCancelAction", data: { actionHash: actionOf(w, x).pending!.actionHash } }]);
    },
  ),
  entityProviderProposeControlBoard: drawn(
    (w) => controls(w).length > 0,
    (w) => {
      const { shareholder, target } = pick(w, controls(w));
      return one(w, shareholder, [{
        type: "entityProviderProposeControlBoard",
        data: { targetEntityId: target, newBoardHash: boardHash(w), actionNonce: amount(w, 1_000_000) },
      }]);
    },
  ),
  entityProviderActivateBoard: drawn(
    (w) => controls(w).length > 0,
    (w) => {
      const { shareholder, target } = pick(w, controls(w));
      return one(w, shareholder, [{ type: "entityProviderActivateBoard", data: { targetEntityId: target } }]);
    },
  ),
};

const NUMBERED = "a numbered Entity with a certified board record (the Boards world)";
export const BOARDS: Moves<"boards"> = {
  propose: drawn(
    (w) => PARTIES.some((x) => canPropose(w, x)),
    (w) => {
      const x = pick(w, where(PARTIES, (p) => canPropose(w, p)));
      return one(w, x, [{ type: "propose", data: { proposer: signerOf(x), action: proposalAction(w, x) } }]);
    },
  ),
  vote: pending("a board of several signers, and a lane that submits as any member"),
  boardHandover: arises("an on-chain BoardActivated in a j_event"),
  r2e: drawn(
    (w) => withdrawers(w).length > 0,
    (w) => {
      const x = pick(w, withdrawers(w));
      return one(w, x, [{
        type: "r2e",
        data: { receivingEntity: asBytes32(pick(w, EXTERNAL)), tokenId: Number(TOKEN), amount: withdrawal(w, x) },
      }]);
    },
  ),
  entityProviderTransfer: pending(NUMBERED),
  entityProviderReleaseControlShares: pending(NUMBERED),
  entityProviderCancelAction: pending(NUMBERED),
  entityProviderProposeControlBoard: pending(NUMBERED),
  entityProviderActivateBoard: pending(NUMBERED),
};

/** World moves: none yet. */
export const BOARDS_WORLD: WorldMoves = {};
