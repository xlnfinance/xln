/**
 * scopeId — structural scope identity (`head@line:col`, now `head@source:line:col`
 * when the form's location carries a source file).
 *
 * WHY source belongs in the id: scope identity keyed on line:col ALONE collides
 * across files — two forms at the same position in different required `.scm`
 * modules (or two different `.prompt`-generated resolver lambdas, which all parse
 * the same generated text at 1:13) fold onto ONE scope, merging distinct call
 * sites in every scope-keyed consumer (chain labels, region folding, ports).
 * Identity is file+line+col; the unlocated / sourceless forms keep the old
 * `head@line:col` shape byte-for-byte, so main-body scopes (and every golden
 * fixture over them) are unchanged.
 */
import { describe, expect, it } from "vitest";

import { parse } from "../../eval/generator-exec.js";
import { scopeId } from "../scope-id.js";

describe("scopeId", () => {
  it("sourceless located form → head@line:col (unchanged)", async () => {
    const [form] = await parse("(foo 1)");
    expect(scopeId(form)).toBe("foo@1:0");
  });

  it("source-carrying located form → head@source:line:col (files don't collide)", async () => {
    const [inA] = await parse("(foo 1)", "a.scm");
    const [inB] = await parse("(foo 1)", "b.scm");
    expect(scopeId(inA)).toBe("foo@a.scm:1:0");
    expect(scopeId(inB)).toBe("foo@b.scm:1:0");
    expect(scopeId(inA)).not.toBe(scopeId(inB));
  });

  it("same source, same position → same scope (folding within one file is preserved)", async () => {
    const [x] = await parse("(foo 1)", "a.scm");
    const [y] = await parse("(foo 1)", "a.scm");
    expect(scopeId(x)).toBe(scopeId(y));
  });
});
