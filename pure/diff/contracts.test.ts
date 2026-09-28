// Contract holes the 2026-09-28 Codex review of pure/xln.ts found (docs/reviews/pure-xln-2026-09-28 on its branch),
// each pinned by the negative case it reproduced.
import { describe, expect, test } from "bun:test";
import { createEntity, foldResult, ogSections, ok, err, tag, withOgSections, type EntityCommitted } from "../xln.ts";
import { ALICE, TERMS, UNREGISTERED_J, aliceAddr, unwrap } from "../xln_run.ts";

const entity = () =>
  unwrap(createEntity({
    id: ALICE, jurisdiction: TERMS.domain, threshold: 1n, members: new Map([[aliceAddr, { shares: 1n }]]),
    jurisdictionConfig: UNREGISTERED_J,
  })).state;

describe("contracts: tag", () => {
  test("the payload is required and cannot replace the tag", () => {
    const signed = tag("signed");
    // @ts-expect-error a payload whose type needs fields must be passed
    const missing = (): unknown => signed<{ readonly signature: string }>();
    // @ts-expect-error the payload cannot carry its own _tag
    const forged = (): unknown => tag("expected")({ _tag: "unexpected" });
    void missing;
    void forged;
    expect(signed({ signature: "0x01" }) as unknown).toEqual({ _tag: "signed", signature: "0x01" });
    expect(Object.keys(signed({ signature: "0x01" }))).toEqual(["_tag", "signature"]);
  });
});

describe("contracts: foldResult", () => {
  test("snapshots the iterable, and the callback sees nothing after the first refusal", () => {
    const read: number[] = [];
    const called: number[] = [];
    const source = function* (): Generator<number> {
      read.push(1); yield 1;
      read.push(2); yield 2;
      read.push(3); yield 3;
    };
    const out = foldResult(source(), 0, (sum, x) => {
      called.push(x);
      return x === 1 ? err("stop") : ok(sum + x);
    });
    expect(out).toEqual({ ok: false, error: "stop" });
    expect(read).toEqual([1, 2, 3]);
    expect(called).toEqual([1]);
  });
});

describe("contracts: og section import", () => {
  const patched = (patch: Record<string, unknown>) =>
    withOgSections(entity(), { ...ogSections(entity()), ...patch } as EntityCommitted);
  test("a proposals map og cannot produce is refused, not trusted", () => {
    const out = patched({ proposals: new Map([["id", "oops"]]) });
    expect(out).toEqual({ ok: false, error: { _tag: "entity_invariant", reason: "PROPOSALS_STATE_UNREACHABLE: a malformed proposal id" } });
  });
  test("a nonce og cannot produce is refused", () => {
    const out = patched({ nonces: new Map([[aliceAddr, -1]]) });
    expect(out.ok).toBe(false);
  });
  test("an og-shaped proposal imports", () => {
    const proposal = {
      id: "p1", proposer: aliceAddr, boardHash: `0x${"11".repeat(32)}`, boardEpoch: 0,
      action: { type: "collective_message", data: { message: "m" } }, actionHash: `0x${"22".repeat(32)}`,
      votes: new Map<string, unknown>([[aliceAddr, "yes"], ["0x02", { choice: "no", comment: "c" }]]), created: 1,
    };
    const out = unwrap(patched({ proposals: new Map([["p1", proposal]]) }));
    expect(out.proposals.get("p1")).toEqual(proposal as never);
  });
});
