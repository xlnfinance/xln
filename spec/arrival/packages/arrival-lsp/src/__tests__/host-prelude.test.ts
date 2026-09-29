// host-prelude — the single-source seam. Proves assembleHostPrelude turns a rosetta
// type registry into a `{ prelude, members }` that (a) ambient-declares encoded
// functions so injected tools narrow as candidates, and (b) routes their heads via
// the member roster so they narrow as call slots.
import { describe, expect, it } from "vitest";

import { encodeSchemeIdent } from "@inhuman.tools/arrival-types-bridge";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

const REGISTRY: [string, string][] = [
  ["memory/netscan", "(): List<Connection>"],
  ["ip/external-c2-candidate?", "(ip: SchemeIP): SBool"],
  ["ip/of-connection", "(c: Connection): SchemeIP"],
  ["ip/version", "(ip: SchemeIP): SNum"],
];
const ENTITIES = `
interface Connection { src: SStr; dst: SStr; pid: SNum; }
interface SchemeIP { readonly __ip: unique symbol; }
`;

describe("assembleHostPrelude — registry → { prelude, members }", () => {
  it("members are the registered names; prelude declares encoded ambient functions", () => {
    const { prelude, members } = assembleHostPrelude(REGISTRY, { preamble: ENTITIES });
    expect(new Set(members)).toEqual(new Set(REGISTRY.map(([n]) => n)));
    expect(prelude).not.toMatch(/ArrShape|__arr/);
    expect(prelude).toContain(
      `declare function ${encodeSchemeIdent("ip/external-c2-candidate?")}(ip: SchemeIP): SBool;`,
    );
    expect(prelude).toContain(ENTITIES.trim().split("\n")[1]); // the preamble is included
  });

  it("arrows and overload objects become declare const, tails stay declare function", () => {
    const { prelude, members } = assembleHostPrelude([
      ["string-split", "(str: string, delimiter: string) => List<string>"],
      ["member", "{ <T>(obj: T, list: List<T>): List<T> | false; }"],
      ["ip/version", "(ip: SchemeIP): SNum"],
      ["map-tail", "(f: (x: T) => B, xs: List<T>): List<B>"],
    ]);
    expect(members).toContain("string-split");
    expect(prelude).toContain(
      `declare const ${encodeSchemeIdent("string-split")}: (str: string, delimiter: string) => List<string>;`,
    );
    expect(prelude).toContain(
      `declare const ${encodeSchemeIdent("member")}: { <T>(obj: T, list: List<T>): List<T> | false; };`,
    );
    expect(prelude).toContain(`declare function ${encodeSchemeIdent("ip/version")}(ip: SchemeIP): SNum;`);
    expect(prelude).toContain(
      `declare function ${encodeSchemeIdent("map-tail")}(f: (x: T) => B, xs: List<T>): List<B>;`,
    );
  });

  it("a later duplicate name overrides the earlier type", () => {
    const { members } = assembleHostPrelude([
      ["t", "(): SNum"],
      ["t", "(): SStr"],
    ]);
    expect(members).toEqual(["t"]); // deduped, last wins
  });

  it("drives both candidate- and slot-side narrowing through the lens", () => {
    const host = assembleHostPrelude(REGISTRY, { preamble: ENTITIES });
    const ls = createSchemeLanguageService({ host });
    const at = (scheme: string, cands: string[]) =>
      new Set(ls.getTypeValidCandidates(scheme, scheme.indexOf(")"), cands));

    // SLOT side: a host tool as the HEAD — masks to SchemeIP-producers.
    const slot = at("(ip/external-c2-candidate? )", ["ip/of-connection", "memory/netscan", "ip/version"]);
    expect(slot).toEqual(new Set(["ip/of-connection"]));

    // CANDIDATE side: through a builtin head wanting a List — the injected list tool survives.
    const cand = at("(car )", ["memory/netscan", "ip/of-connection", "ip/version"]);
    expect(cand.has("memory/netscan")).toBe(true); // : List<Connection>
    expect(cand.has("ip/of-connection")).toBe(false); // : SchemeIP
    expect(cand.has("ip/version")).toBe(false); // : SNum
  });

  it("without a host option, nothing is injected (default behavior unchanged)", () => {
    const ls = createSchemeLanguageService();
    // `netscan` is unknown → unresolved → kept (conservative), never narrowed away.
    const v = new Set(ls.getTypeValidCandidates("(car )", "(car ".length - 1, ["netscan"]));
    expect(v.has("netscan")).toBe(true);
  });
});
