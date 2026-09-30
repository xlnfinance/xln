import { describe, expect, test } from "bun:test";
import { frozenTouches } from "./frozen.ts";
import { quotedSet, widthsOf } from "./folder-width.ts";

describe("frozen gate", () => {
  test("a path under core/ or jurisdictions/ is a touch; pure/, contracts/ and spec/ are not", () => {
    const paths = ["core/runtime.ts", "jurisdictions/contracts/Depository.sol", "pure/xln.ts", "contracts/contracts/Account.sol", "spec/README.md", "core-notes/x.md"];
    expect(frozenTouches(paths)).toEqual(["core/runtime.ts", "jurisdictions/contracts/Depository.sol"]);
  });
});

describe("folder width on tracked files", () => {
  test("counts direct source files per directory and ignores other extensions", () => {
    const tracked = ["a/x.ts", "a/y.ts", "a/notes.md", "a/b/z.sol"];
    expect(widthsOf(tracked)).toEqual([{ path: "a", files: 2 }, { path: "a/b", files: 1 }]);
  });

  test("a tracked file under og's generated or excluded folders is not counted", () => {
    const tracked = ["spec/arrival/p/x.ts", "contracts/typechain-types/x.ts", "pkg/node_modules/m/x.ts", "kept/x.ts"];
    expect(widthsOf(tracked)).toEqual([{ path: "kept", files: 1 }]);
  });

  test("a folder that is on disk but not tracked cannot widen anything: only the list given is counted", () => {
    const tracked = Array.from({ length: 3 }, (_, index) => `contracts/contracts/C${index}.sol`);
    const widths = widthsOf(tracked);
    expect(widths).toEqual([{ path: "contracts/contracts", files: 3 }]);
  });

  test("reads the quoted members of a Set literal", () => {
    const source = "const X: ReadonlySet<string> = new Set([\n  'a',\n  'b/c',\n]);\nconst Y = new Set(['z']);";
    expect([...quotedSet(source, "X")]).toEqual(["a", "b/c"]);
  });
});
