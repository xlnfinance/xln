// The edge: walk the tree, read files, hand the texts to the pure name readers.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arrivalNames, hasTestShape, quintNames, testFileNames } from "./names/names.ts";
import type { Layer, Name } from "./model.ts";

type LayerScan = Readonly<{
  layer: Layer;
  root: string; // relative to the repository root unless overridden
  accepts: (file: string) => boolean;
  read: (file: string, text: string) => readonly Name[];
}>;

const vendored = (file: string): boolean => /(?:^|\/)(?:node_modules|arrival|quint|\.git)\//.test(file);

const testsIn = (layer: Layer, root: string, accepts: (file: string) => boolean): LayerScan => ({
  layer,
  root,
  accepts,
  read: (file, text) => testFileNames(layer, file, text),
});

// Only the contract tests a gate runs: the vm files in an area folder and the gate files (one per process, the same
// globs as the contracts part of `bun rules/check.ts` (run by the gate-static job in .github/workflows/build-and-test.yml), which runs `*.test.ts` only) and the Foundry suite. Any other contract
// test is in no gate, and rules/checks/contract-tests.ts turns that red unless the file is listed there as run by
// Hardhat only; a rule held only in such a file is owed until its test moves into a folder a gate runs.
export const isGateTest = (file: string): boolean =>
  /^vm\/[^/]+\/[^/]+\.test\.ts$/.test(file) ||
  /^gate\/[^/]+\.test\.ts$/.test(file) ||
  /^foundry\/.*\.t\.sol$/.test(file);

// Layers and where their checks live. The rig and ts columns scan what exists; rows claim them later.
export const scans: readonly LayerScan[] = [
  testsIn("contract", "contracts/test", isGateTest),
  testsIn("rig", "pure/diff", hasTestShape),
  testsIn("ts", "pure", (file) => hasTestShape(file) && !/^diff\//.test(file)),
  {
    layer: "arrival",
    root: "spec",
    accepts: (file) => file.endsWith(".scm") && !vendored(file) && !file.startsWith("lib/"),
    read: arrivalNames,
  },
  {
    layer: "quint",
    root: "spec/quint",
    accepts: (file) => file.endsWith(".qnt") || file.endsWith(".sh") || /^mutants\/.*\.json$/.test(file),
    read: quintNames,
  },
];

// Files under `root`, relative to it, skipping dependency folders.
const filesUnder = (root: string): readonly string[] =>
  !existsSync(root)
    ? []
    : readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
        .filter((file) => !/(?:^|\/)node_modules\//.test(file));

// Overrides lets the matrix be projected onto another checkout of one layer (for example a spec branch).
export const scanNames = (repoRoot: string, overrides: Readonly<Partial<Record<Layer, string>>> = {}): readonly Name[] =>
  scans.flatMap((scan) => {
    const root = overrides[scan.layer] ?? join(repoRoot, scan.root);
    return filesUnder(root)
      .filter(scan.accepts)
      .flatMap((file) => scan.read(`${scan.root}/${file}`, readFileSync(join(root, file), "utf8")));
  });
