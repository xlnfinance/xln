/**
 * LAW — resource-path algebra (CQS Phase 1 / suite S0).
 *
 * Zone identity is segment-wise path prefix, not string-join, not the whole run.
 * Door fuel is any-pair overlap of prior effect paths × this query paths.
 *
 * Pure functions only — no RunContext, no rosetta. See
 * docs/working-proposals/cqs-reactivity/test-suite-design/SUITE.md (S0).
 */
import { describe, it, expect } from "vitest";
import {
  pathsOverlap,
  anyPathOverlap,
  findOverlappingPair,
  serializeResourcePath,
  type ResourcePath,
} from "../path-algebra.js";

const p = (...segs: string[]): ResourcePath => segs;

describe("resource-path algebra (S0)", () => {
  it("A-EQ — path overlaps itself", () => {
    expect(pathsOverlap(p("db", "projects", "1"), p("db", "projects", "1"))).toBe(true);
  });

  it("A-PARENT-CHILD / A-CHILD-PARENT — prefix either direction", () => {
    const parent = p("db", "projects");
    const child = p("db", "projects", "1");
    expect(pathsOverlap(parent, child)).toBe(true);
    expect(pathsOverlap(child, parent)).toBe(true);
  });

  it("A-SIB — siblings do not overlap", () => {
    expect(pathsOverlap(p("db", "projects", "1"), p("db", "projects", "2"))).toBe(false);
  });

  it("A-DISJ-ROOT — different roots do not overlap", () => {
    expect(pathsOverlap(p("db", "projects"), p("fs", "projects"))).toBe(false);
  });

  it("A-DISJ-MID — diverge mid-path do not overlap", () => {
    expect(pathsOverlap(p("db", "a", "x"), p("db", "b", "x"))).toBe(false);
  });

  it("A-STRING — segment-wise only: project vs projects is NOT prefix", () => {
    expect(pathsOverlap(p("db", "project"), p("db", "projects"))).toBe(false);
    expect(pathsOverlap(p("db", "project", "1"), p("db", "projects"))).toBe(false);
  });

  it("A-MULTI-∃ — multi-set overlap is any-pair (exists)", () => {
    const prior = [p("a"), p("db", "x")];
    const query = [p("z"), p("db", "x", "1")];
    expect(anyPathOverlap(prior, query)).toBe(true);
    expect(findOverlappingPair(prior, query)).toEqual({
      priorEffect: p("db", "x"),
      thisQuery: p("db", "x", "1"),
    });
  });

  it("A-EMPTY-LIST — empty prior E or empty Q ⇒ no door fuel", () => {
    expect(anyPathOverlap([], [p("db")])).toBe(false);
    expect(anyPathOverlap([p("db")], [])).toBe(false);
    expect(anyPathOverlap([], [])).toBe(false);
    expect(findOverlappingPair([p("db")], [])).toBeUndefined();
  });

  it("A-EMPTY-PATH — empty path tuple never overlaps (either side)", () => {
    expect(pathsOverlap([], p("db"))).toBe(false);
    expect(pathsOverlap(p("db"), [])).toBe(false);
    expect(pathsOverlap([], [])).toBe(false);
  });

  it("F1 — symmetry of pairwise overlap; sibling diverge", () => {
    const a = p("x", "y");
    const b = p("x", "y", "z");
    const c = p("x", "w");
    expect(pathsOverlap(a, b)).toBe(pathsOverlap(b, a));
    expect(pathsOverlap(a, a)).toBe(true);
    expect(pathsOverlap(a, c)).toBe(false);
  });

  // Phase 4 — host footprint key encoding (writeSetOf / confirm / atoms)
  it("serializeResourcePath — equality-stable key; escapes slash segments", () => {
    expect(serializeResourcePath(p("db", "projects", "1"))).toBe('"db"/"projects"/"1"');
    expect(serializeResourcePath(p("a/b", "c"))).toBe('"a/b"/"c"');
    expect(serializeResourcePath([])).toBe("[]");
    // project vs projects stay distinct as keys (segment-wise identity, not string-prefix)
    expect(serializeResourcePath(p("db", "project"))).not.toBe(serializeResourcePath(p("db", "projects")));
  });
});
