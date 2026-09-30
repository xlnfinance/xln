// The edge: walk the tree, read files, hand the texts to the pure name readers.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { arrivalNames, hasTestShape, quintNames, testFileNames } from "./names.ts";
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

const isSource = (file: string): boolean => /\.(?:ts|mjs|sol)$/.test(file);

// Layers and where their checks live. The rig and ts columns scan what exists; rows claim them later.
export const scans: readonly LayerScan[] = [
  testsIn("contract", "contracts/test", isSource),
  testsIn("rig", "pure/diff", hasTestShape),
  testsIn("ts", "pure", (file) => hasTestShape(file) && !/^(?:diff|rules)\//.test(file)),
  {
    layer: "arrival",
    root: "spec",
    accepts: (file) => file.endsWith(".scm") && !vendored(file) && !file.startsWith("lib/"),
    read: arrivalNames,
  },
  {
    layer: "quint",
    root: "spec/quint",
    accepts: (file) => file.endsWith(".qnt") || /^mutants\/.*\.json$/.test(file),
    read: quintNames,
  },
];

// Files under `root`, relative to it, skipping dependency folders.
const filesUnder = (root: string): readonly string[] => {
  try {
    return readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(root.length + 1))
      .filter((file) => !/(?:^|\/)node_modules\//.test(file));
  } catch {
    return [];
  }
};

// Overrides lets the matrix be projected onto another checkout of one layer (for example a spec branch).
export const scanNames = (repoRoot: string, overrides: Readonly<Partial<Record<Layer, string>>> = {}): readonly Name[] =>
  scans.flatMap((scan) => {
    const root = overrides[scan.layer] ?? join(repoRoot, scan.root);
    return filesUnder(root)
      .filter(scan.accepts)
      .flatMap((file) => scan.read(`${scan.root}/${file}`, readFileSync(join(root, file), "utf8")));
  });
