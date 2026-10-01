// Findings the walks reach that are real and not fixed here, each registered so the gate can say exactly what it expects and nothing else.
// A walk's diff lines are judged against this table (judge.ts): a line no site expects is red as before, a site whose expected line does not
// appear is red too (the finding stopped reproducing, so its entry has to go), and baseline.json lets the table only shrink (check.ts).
// An entry names where it reproduces (walk area and seed), the property and failure text it expects, the rule the fix belongs to, and its owner.
import type { Area } from "../draws/areas.ts";

/** The rule a fix would satisfy, or og's own bug that nobody fixes (the goal is not og's bytes). */
export type Basis =
  | Readonly<{ _tag: "rule"; id: string }>
  | Readonly<{ _tag: "og-bug"; why: string }>;

/**
 * One line a walk prints for the finding: the property that raised it and the whole line, character for character (frame, Accounts, numbers).
 * A walk is deterministic in its seed, so the line is too; a changed line is a different breach, and re-registering it is a reviewed edit.
 * The line is expected exactly once.
 */
export type Expected = Readonly<{ property: string; line: string }>;

/** Where a finding reproduces: a walk over one area (`model` is the walk over every area) on one seed. */
export type Site = Readonly<{ area: Area | "model"; seed: number; expects: readonly Expected[] }>;

export type KnownFinding = Readonly<{
  id: string;
  basis: Basis;
  owner: string;
  summary: string;
  sites: readonly Site[];
}>;

/** The lines the disputes walk on seed 0x30de2 prints once its Account breaks credit after a co-signed settlement (the walk stops there). */
const SETTLEMENT_BREACH_DISPUTES: Expected = { property: "P2", line: "WALK_SEED=0x30de2 frame 108 chat: P2 0xc6f3ba2933a0612b74bc5cfd0e4b9ac18aafdd10980ad409ab79a20342cd5c62→0x5725acabfd27431850d15572a8e24dc9ed3b5a34f67d6c71a22b2df582ff8d47 token 1 after its signed settlement (collateral -297000002, ondelta -297000002, workspace ready_to_submit, from collateral 450000002 Δ 289999971): room left -6981939 right 160013629 (collateral 153000000 Δ -7000031 credit 18092/13821 clauses 0/223)" };
const DISPUTE_OWED: Expected = { property: "walk", line: "WALK_SEED=0x30de2 the walk ended with disputes:deadline still owed: its lifecycle never closed" };
const DISPUTE_UNFINALIZED: Expected = { property: "walk", line: "WALK_SEED=0x30de2 no dispute finalized on both sides" };
const DISPUTE_NEVER_AT_MOVED_EPOCH: Expected = { property: "C1", line: "WALK_SEED=0x30de2 C1: no dispute started on an Account whose epoch had moved, so the start's epoch was never checked" };

export const KNOWN_FINDINGS: readonly KnownFinding[] = [
  {
    id: "SETTLEMENT-IGNORES-CREDIT",
    basis: { _tag: "rule", id: "R-SETTLE-CREDIT" },
    owner: "the Account cut (the cut PR that wires the new Account ledger into the walk deletes this entry; the ledger module merging alone does not)",
    summary: "A settlement is co-signed in which one side withdraws collateral beyond its own claim, so after it lands that side owes past the credit the other extended",
    sites: [
      { area: "disputes", seed: 0x30de2, expects: [SETTLEMENT_BREACH_DISPUTES, DISPUTE_OWED, DISPUTE_UNFINALIZED, DISPUTE_NEVER_AT_MOVED_EPOCH] },
      { area: "settlement", seed: 0x30de5, expects: [{ property: "P2", line: "WALK_SEED=0x30de5 frame 57 profile-update: P2 0xf581ad558808d0e4bfbd37522f06833a053b200cee088773d192789e29eb476b→0x5725acabfd27431850d15572a8e24dc9ed3b5a34f67d6c71a22b2df582ff8d47 token 1 after its signed settlement (collateral -204700001, ondelta -204700001, workspace ready_to_submit, from collateral 230000001 Δ -124): room left -204692198 right 230000125 (collateral 25300000 Δ -204700125 credit 7927/0 clauses 0/0)" }] },
      { area: "model", seed: 0x30de3, expects: [{ property: "P2", line: "WALK_SEED=0x30de3 frame 170 r2e: P2 0xc6f3ba2933a0612b74bc5cfd0e4b9ac18aafdd10980ad409ab79a20342cd5c62→0x499d0dc46b549fcf353811291de337ef5aa6fa651b77ccd36dc0efbd64fef2bd token 1 after its signed settlement (collateral -310639071, ondelta -310639071, workspace ready_to_submit, from collateral 349032663 Δ 220095651): room left -90526166 right 128937012 (collateral 38393592 Δ -90543420 credit 17254/0 clauses 0/0)" }] },
    ],
  },
  {
    id: "CREDIT-REVOKED-BELOW-USE",
    basis: { _tag: "rule", id: "R-CREDIT-REVOKE-FLOOR" },
    owner: "v2 lending area",
    summary: "A lending credit grant is revoked while part of it is in use, so the Account's Δ exceeds collateral plus the credit left",
    sites: [
      { area: "model", seed: 0x30de2, expects: [{ property: "P2", line: "WALK_SEED=0x30de2 frame 109 htlcPayment: P2 0xf581ad558808d0e4bfbd37522f06833a053b200cee088773d192789e29eb476b→0x5725acabfd27431850d15572a8e24dc9ed3b5a34f67d6c71a22b2df582ff8d47 token 1: room left 374598202 right -3595003 (collateral 370000002 Δ 374594605 credit 3597/1000000 clauses 0/400)" }] },
    ],
  },
  {
    id: "SETTLE-EXECUTE-RACE-EVICTED",
    basis: { _tag: "rule", id: "R-SAME-FRAME-SETTLE-PENDING" },
    owner: "the Entity-frame cut",
    summary: "A signed settle_execute that follows the hub scheduler's execute in one frame: og skips it as already submitted and commits the command's nonce; the rewrite refuses it as already pending and evicts the command (nonce unchanged)",
    sites: [
      {
        area: "settlement",
        seed: 0x30de1,
        expects: [
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 entityHashes.3.hash: og=\"0x4d86c56efb6b6985b8fb6752c6091a1ef3baffd7ab6761c80fff866acee6c831\" rw=\"0x65708626cd9296a542326fe4c7c1ff30244611b6301f2b058a672f9775ee120e\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 meta[1].certifiedFrameHeadDigest: og=\"0xe6f5ebb3fafec818f3a072b8b006a81fcaeef3d1a9ea5cc1deb1e61593675e4b\" rw=\"0x632cffa6ef603c497f96074c7cc707f10836917cb6b2c063142bff7812739452\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 meta[1].entityHead.frameHash: og=\"0x066a2380b7e11aefa06bbb7584b96d4f85adb05306fcc616d97c5b8ff7fa12c3\" rw=\"0x6a2759051829905eeeea2d2e2f2d6276b7b15cac07469381e0d64b2ba03010d5\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 head[H].frameHash: og=\"0x066a2380b7e11aefa06bbb7584b96d4f85adb05306fcc616d97c5b8ff7fa12c3\" rw=\"0x6a2759051829905eeeea2d2e2f2d6276b7b15cac07469381e0d64b2ba03010d5\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 head[H].hankos.0: og=\"0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000 rw=\"0x0000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000000000000000008000000000000000000000000000000" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 head[H].hashesToSign.0.hash: og=\"0x066a2380b7e11aefa06bbb7584b96d4f85adb05306fcc616d97c5b8ff7fa12c3\" rw=\"0x6a2759051829905eeeea2d2e2f2d6276b7b15cac07469381e0d64b2ba03010d5\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 head[H].stateRoot: og=\"0x4d86c56efb6b6985b8fb6752c6091a1ef3baffd7ab6761c80fff866acee6c831\" rw=\"0x65708626cd9296a542326fe4c7c1ff30244611b6301f2b058a672f9775ee120e\"" },
          { property: "lane", line: "WALK_SEED=0x30de1 frame=177 postStateHash.: og=true rw=false" }
        ],
      },
    ],
  },
  {
    id: "J-PREFIX-CERTIFICATE-WITHOUT-RANGE",
    basis: { _tag: "rule", id: "R-OWN-FRAME" },
    owner: "the J1 cut",
    summary: "The proposer's own J-prefix frame is one its own validation rejects: self-proposed at entity height 51 with a certificate over base 40 that scanned 41 and carries no range tx. og and the rewrite build the byte-identical frame (a faithful port of og's proposer); og then halts the Runtime with J_PREFIX_RANGE_COUNT_INVALID:0, the rewrite refuses it with RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED (J_PREFIX_INVALID)",
    sites: [
      {
        area: "disputes",
        seed: 0x30de6,
        expects: [
          { property: "lane", line: "WALK_SEED=0x30de6 frame=91 og halted (J_PREFIX_RANGE_COUNT_INVALID:0) but the rewrite refused {\"_tag\":\"runtime_frame\",\"code\":\"RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED:entity=0x499d0dc46b549fcf353811291de337ef5aa6fa651b77ccd36dc0efbd64fef2bd:round=1:outcome=rejected:detail=J_PREFIX_INVALID\"}" },
          { property: "walk", line: "WALK_SEED=0x30de6 og halted on a drawn input, not a known og halt: J_PREFIX_RANGE_COUNT_INVALID:0" },
        ],
      },
    ],
  },
];
