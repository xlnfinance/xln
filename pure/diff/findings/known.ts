// Findings the walks reach that are real and not fixed here, each registered so the gate can say exactly what it expects and nothing else.
// A walk's diff lines are judged against this table (judge.ts): a line no site expects is red as before, a site whose expected line does not
// appear is red too (the finding stopped reproducing, so its entry has to go), and baseline.json lets the table only shrink (check.ts).
// An entry names where it reproduces (walk area and seed), the property and failure text it expects, the rule the fix belongs to, and its owner.
import type { Area } from "../draws/areas.ts";

/** The rule a fix would satisfy, or og's own bug that nobody fixes (the goal is not og's bytes). */
export type Basis =
  | Readonly<{ _tag: "rule"; id: string }>
  | Readonly<{ _tag: "og-bug"; why: string }>;

/** One line a walk prints for the finding: the property that raised it and the failure text, matched on the line (seed and numbers are free). */
export type Expected = Readonly<{ property: string; signature: RegExp }>;

/** Where a finding reproduces: a walk over one area (`model` is the walk over every area) on one seed. */
export type Site = Readonly<{ area: Area | "model"; seed: number; expects: readonly Expected[] }>;

export type KnownFinding = Readonly<{
  id: string;
  basis: Basis;
  owner: string;
  summary: string;
  sites: readonly Site[];
}>;

/** An Account whose settlement was co-signed leaves its proposer owing past the credit, or its walk ends on the breach. */
const SETTLEMENT_BREACH: Expected = { property: "P2", signature: /P2 \S+→\S+ token \d+ after its signed settlement/ };
const DISPUTE_OWED: Expected = { property: "walk", signature: /the walk ended with disputes:deadline still owed/ };
const DISPUTE_UNFINALIZED: Expected = { property: "walk", signature: /no dispute finalized on both sides/ };
const DISPUTE_NEVER_AT_MOVED_EPOCH: Expected = { property: "C1", signature: /C1: no dispute started on an Account whose epoch had moved/ };

export const KNOWN_FINDINGS: readonly KnownFinding[] = [
  {
    id: "SETTLEMENT-IGNORES-CREDIT",
    basis: { _tag: "rule", id: "R-SETTLE-CREDIT" },
    owner: "the Account cut (the cut PR that wires the new Account ledger into the walk deletes this entry; the ledger module merging alone does not)",
    summary: "A settlement is co-signed in which one side withdraws collateral beyond its own claim, so after it lands that side owes past the credit the other extended",
    sites: [
      { area: "disputes", seed: 0x30de2, expects: [SETTLEMENT_BREACH, DISPUTE_OWED, DISPUTE_UNFINALIZED, DISPUTE_NEVER_AT_MOVED_EPOCH] },
      { area: "settlement", seed: 0x30de5, expects: [SETTLEMENT_BREACH] },
      { area: "model", seed: 0x30de3, expects: [SETTLEMENT_BREACH] },
    ],
  },
  {
    id: "CREDIT-REVOKED-BELOW-USE",
    basis: { _tag: "rule", id: "R-CREDIT-REVOKE-FLOOR" },
    owner: "v2 lending area",
    summary: "A lending credit grant is revoked while part of it is in use, so the Account's Δ exceeds collateral plus the credit left",
    sites: [
      { area: "model", seed: 0x30de2, expects: [{ property: "P2", signature: /P2 \S+→\S+ token \d+: room left/ }] },
    ],
  },
  {
    id: "OG-J-PREFIX-RANGE-COUNT",
    basis: { _tag: "og-bug", why: "og halts J_PREFIX_RANGE_COUNT_INVALID:0 after a dispute finalize and a fund; the rewrite refuses the same frame differently" },
    owner: "the rig thread, until the oracle switches from og to spec properties",
    summary: "og's J-prefix consensus halts where the rewrite refuses with RUNTIME_CROSS_J_LOCAL_EVENT_NOT_COMMITTED",
    sites: [
      {
        area: "disputes",
        seed: 0x30de6,
        expects: [
          { property: "lane", signature: /og halted \(J_PREFIX_RANGE_COUNT_INVALID:0\) but the rewrite refused/ },
          { property: "walk", signature: /og halted on a drawn input, not a known og halt: J_PREFIX_RANGE_COUNT_INVALID:0/ },
        ],
      },
    ],
  },
];
