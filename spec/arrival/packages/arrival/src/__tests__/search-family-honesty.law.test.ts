// THE SEARCH FAMILY MAY NOT LIE — memq / memv / member / assq / assv / assoc.
//
//   EVERY "NOTHING HERE" MUST NAME WHICH NOTHING IT IS.
//   (benchmark-defect-register.md — the governing diagnosis of the 89×2 run)
//
// These six verbs answer `#f` for "not found". They ALSO used to answer `#f` for:
//
//   • "you didn't give me a list at all"   — the walk `while (x instanceof APair)` simply never
//     executed its body, and fell straight through to `return schemeFalse`.
//   • "your alist came from a tool, so its entries are JSON 2-element ARRAYS, and I couldn't read
//     a single one of them"  — `if (pair instanceof APair && …)` failed on every entry, each was
//     skipped in silence, and the walk fell off the end.
//
// Three different facts, one indistinguishable reply. And `#f` is the WORST possible reply,
// because it is a perfectly plausible answer: the model has no way to detect that it was lied to.
// It does not retry. It reports the wrong thing, confidently, to the user.
//
// `(member x results)` answering "not found" about a list that CONTAINS x is the single most
// expensive failure shape this medium can produce — it is the register's governing diagnosis in
// its purest form: THE RETURN CHANNEL LIES, AND WE SELECT AGAINST THE MODELS THAT TRUST IT.
//
// So the law has three clauses, and the third is the one that makes the first two safe:
//   1. A NON-LIST argument is a DOOR, never `#f`.
//   2. A tool-returned alist (array of 2-element arrays) IS readable.
//   3. THE HONEST `#f` STILL WORKS — a real miss is still a real miss.
//
// Clause 3 is not a formality. It would be trivial to "fix" clauses 1 and 2 by making the verbs
// throw more eagerly, and thereby destroy the only answer they exist to give.
import { describe, expect, it } from "vitest";

import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { inferenceEnv } from "../env/inference-env.js";
import { toJS, jsToScheme } from "../membrane/rosetta.js";
import { CONSTANT_CTX } from "../run/RunContext.js";

/** Bindings cross through `jsToScheme`, so `xs` arrives as a borrowed array — exactly what an MCP
 *  tool returning JSON hands the model. That receiver is the whole point. */
const run = async (code: string, bindings: Record<string, unknown> = {}): Promise<string> => {
  try {
    const { values } = await execState(code, {
      env: inferenceEnv.child(
        "search-honesty",
        Object.fromEntries(Object.entries(bindings).map(([k, v]) => [k, jsToScheme(CONSTANT_CTX, v)])),
      ),
    });
    return `OK ${JSON.stringify(toJS(values[0], {}))}`;
  } catch (e) {
    return `DOOR ${e instanceof Error ? e.message : String(e)}`;
  }
};

const SEARCH_VERBS = ["memq", "memv", "member", "assq", "assv", "assoc"] as const;

describe("LAW 1 — a NON-LIST argument is a door, never a silent #f", () => {
  it.each(SEARCH_VERBS.map((verb) => ({ verb })))(
    `$verb refuses a non-list instead of answering "not found"`,
    async ({ verb }) => {
      const r = await run(`(${verb} 1 42)`);
      // The precise failure this pins: the verb must NOT have answered #f.
      expect(r).not.toBe("OK false");
      expect(r.startsWith("DOOR")).toBe(true);
      // And the door must name the fault, not merely refuse.
      expect(r).toContain("expected a list");
      expect(r).toContain("42");
    },
  );

  it("the door explains WHY a silent #f would have been a lie", async () => {
    const r = await run("(member 2 42)");
    expect(r).toContain('returns #f for "not found"');
  });
});

describe("LAW 2 — a TOOL-RETURNED alist is readable (entries are JSON 2-element arrays)", () => {
  // The shape every MCP tool produces for an alist. Entries are AJSArray (the vector chart),
  // not APair — which is exactly what used to be skipped in silence.
  const ALIST = {
    pairs: [
      ["a", 1],
      ["b", 2],
    ],
  };

  it("assoc finds an entry in a tool alist", async () => {
    expect(await run(`(assoc "a" pairs)`, ALIST)).toBe('OK ["a",1]');
  });

  it("assoc still MISSES honestly in a tool alist", async () => {
    expect(await run(`(assoc "zz" pairs)`, ALIST)).toBe("OK false");
  });

  it("member searches a tool array", async () => {
    expect(await run("(member 2 xs)", { xs: [1, 2, 3] })).toBe("OK [2,3]");
  });
});

describe("LAW 3 — the HONEST #f survives (a real miss is still a miss)", () => {
  it("member: absent element → #f", async () => {
    expect(await run("(member 9 '(1 2 3))")).toBe("OK false");
  });

  it("member: present element → the sublist", async () => {
    expect(await run("(member 2 '(1 2 3))")).toBe("OK [2,3]");
  });

  it("member: the EMPTY list is a legitimate list, and legitimately misses", async () => {
    expect(await run("(member 9 '())")).toBe("OK false");
  });

  it("member: an empty TOOL array likewise misses honestly (it adopts to nil, not to a door)", async () => {
    expect(await run("(member 9 xs)", { xs: [] })).toBe("OK false");
  });

  it("assoc: a genuine cons-cell alist is untouched by entry adoption", async () => {
    expect(await run("(assoc 'b '((a . 1) (b . 2)))")).toBe('OK ["b",2]');
  });
});
