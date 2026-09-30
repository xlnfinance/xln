// check:folder-width on tracked files only. og's core/scripts/checks/architecture/check-folder-width.ts walks the
// disk, so a dev machine's gitignored folders (contracts/.typechain-hardhat, contracts/lib/forge-std) count and
// the check passes only with them moved aside. This one asks git, so the answer is the same on a clean clone
// and on a used checkout. It reuses og's limits, debt table and report, and reads og's exclusion lists from og's
// source text, so the two cannot drift.   bun pure/rules/folder-width.ts   (from the repository root)
import { readFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import {
  FOLDER_WIDTH_DEBT,
  MAX_DIRECT_SOURCE_FILES,
  SOURCE_FILE_EXTENSIONS,
  evaluateFolderWidths,
  type FolderWidth,
} from "../../../core/scripts/checks/architecture/check-folder-width.ts";

const repoRoot = `${import.meta.dir}/../../..`;
const ogSource = readFileSync(`${repoRoot}/core/scripts/checks/architecture/check-folder-width.ts`, "utf8");

// The quoted strings of `const <name>: ... = new Set([ ... ]);` in og's file.
export const quotedSet = (source: string, name: string): ReadonlySet<string> => {
  const body = new RegExp(`const ${name}\\b[^=]*=\\s*new Set\\(\\[([\\s\\S]*?)\\]\\)`).exec(source)?.[1] ?? "";
  return new Set([...body.matchAll(/'([^']*)'/g)].map((found) => found[1] ?? ""));
};

const excludedPaths = quotedSet(ogSource, "EXCLUDED_REPOSITORY_PATHS");
const generatedNames = quotedSet(ogSource, "GENERATED_DIRECTORY_NAMES");

const isCounted = (directory: string): boolean =>
  !directory.split("/").some((segment) => generatedNames.has(segment)) &&
  ![...excludedPaths].some((excluded) => directory === excluded || directory.startsWith(`${excluded}/`));

// Direct source files per directory, from a list of tracked paths.
export const widthsOf = (trackedFiles: readonly string[]): readonly FolderWidth[] => {
  const counts = trackedFiles
    .filter((file) => SOURCE_FILE_EXTENSIONS.has(extname(file)))
    .map((file) => dirname(file))
    .filter(isCounted)
    .reduce<ReadonlyMap<string, number>>((byDirectory, directory) => new Map([...byDirectory, [directory, (byDirectory.get(directory) ?? 0) + 1]]), new Map());
  return [...counts].map(([path, files]) => ({ path, files })).sort((left, right) => left.path.localeCompare(right.path));
};

const run = (): number => {
  const listing = Bun.spawnSync(["git", "ls-files", "-z"], { cwd: repoRoot, stdout: "pipe" });
  const tracked = listing.stdout.toString().split("\0").filter((file) => file !== "");
  const widths = widthsOf(tracked);
  const errors = evaluateFolderWidths(widths, FOLDER_WIDTH_DEBT, MAX_DIRECT_SOURCE_FILES);
  errors.forEach((error) => console.error(`- ${error}`));
  console.log(errors.length === 0 ? `FOLDER_WIDTH_OK tracked dirs=${widths.length} sourceFiles=${widths.reduce((sum, entry) => sum + entry.files, 0)} max=${MAX_DIRECT_SOURCE_FILES}` : "FOLDER_WIDTH_INVARIANT_FAILED");
  return errors.length === 0 ? 0 : 1;
};

if (import.meta.main) process.exit(run());
