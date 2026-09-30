// check:folder-width, ours: at most 10 direct source files per folder, with a recorded debt for the wide ones.
// It asks git which files exist (tracked plus untracked-but-not-ignored), so the answer is the same on a clean
// clone and on a used checkout: a dev machine's gitignored folders (contracts/.typechain-hardhat,
// contracts/lib/forge-std) are not counted, and a new file is counted before it is staged. og's version walks
// the disk and lives at core/scripts/checks/architecture/check-folder-width.ts, frozen at 566c850; this file
// stands alone and does not read it.   bun pure/rules/checks/folder-width.ts   (npm run check:folder-width)
import { existsSync } from "node:fs";
import { dirname, extname } from "node:path";

export const MAX_DIRECT_SOURCE_FILES = 10;

export type FolderWidth = Readonly<{ path: string; files: number }>;

export const SOURCE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  ".cjs", ".css", ".cts", ".go", ".java", ".js", ".jsx", ".kt", ".kts", ".mjs", ".mts", ".py", ".rs", ".scss",
  ".sh", ".sol", ".svelte", ".swift", ".ts", ".tsx",
]);

export const GENERATED_DIRECTORY_NAMES: ReadonlySet<string> = new Set(["build", "coverage", "dist", "node_modules"]);

// Generated output and vendored code: og's list at 566c850, plus contracts' generated folders and the vendored
// spec/arrival (a verbatim copy of here-build/arrival).
export const EXCLUDED_REPOSITORY_PATHS: ReadonlySet<string> = new Set([
  ".agents", ".archive", ".claude", ".codex", ".crush", ".e2e-mesh-db", ".logs", ".obsidian", ".playwright-mcp",
  ".tmp", ".vscode", ".xln-db", "brainvault",
  "contracts/artifacts", "contracts/cache", "contracts/typechain-types",
  "data/tmp", "db",
  "frontend/.svelte-kit", "frontend/.svelte-kit-dev-http", "frontend/.svelte-kit-dev-https",
  "frontend/android/app/src/main/assets/public", "frontend/ios/App/App/public",
  "jurisdictions/artifacts", "jurisdictions/build-tron", "jurisdictions/cache", "jurisdictions/db-tmp",
  "jurisdictions/forge-cache", "jurisdictions/forge-out", "jurisdictions/lib", "jurisdictions/.typechain-hardhat",
  "jurisdictions/typechain-types",
  "packages/npm/xlnfinance/app", "packages/npm/xlnfinance/dist",
  "reports", "spec/arrival", "ui",
]);

// Folders allowed to be wider than the maximum, at exactly this width. A change in either direction is red, so
// debt is paid down on purpose and never grows by accident.
export const FOLDER_WIDTH_DEBT: Readonly<Record<string, number>> = {
  "contracts/contracts": 16,
  "core/__tests__/runtime/ingress": 11,
  "core/__tests__/runtime/observability": 11,
  "core/entity/tx/handlers/account": 11,
  "core/orchestrator/process": 12,
  "core/rscore/ts-worker": 13,
  "core/scripts/e2e/harness": 11,
  "core/scripts/operations/hlt": 12,
  "frontend/src/lib/stores": 11,
  "jurisdictions/contracts": 16,
  "rscore/crates/entity-kernel/src": 12,
  "rscore/crates/entity-kernel/src/consensus": 11,
  "rscore/crates/entity-kernel/tests": 11,
  "scripts/dev": 12,
  "tools": 11,
};

const isCounted = (directory: string): boolean =>
  !directory.split("/").some((segment) => GENERATED_DIRECTORY_NAMES.has(segment)) &&
  ![...EXCLUDED_REPOSITORY_PATHS].some((excluded) => directory === excluded || directory.startsWith(`${excluded}/`));

// Direct source files per directory, from a list of paths that exist.
export const widthsOf = (files: readonly string[]): readonly FolderWidth[] => {
  const directories = files.filter((file) => SOURCE_FILE_EXTENSIONS.has(extname(file))).map((file) => dirname(file)).filter(isCounted);
  return [...Map.groupBy(directories, (directory) => directory)]
    .map(([path, members]) => ({ path, files: members.length }))
    .sort((left, right) => left.path.localeCompare(right.path));
};

export const evaluateFolderWidths = (
  widths: readonly FolderWidth[],
  debt: Readonly<Record<string, number>> = FOLDER_WIDTH_DEBT,
  maximum: number = MAX_DIRECT_SOURCE_FILES,
): readonly string[] => {
  const byPath = new Map(widths.map((entry) => [entry.path, entry.files]));
  const tooWide = widths
    .filter(({ files }) => files > maximum)
    .flatMap(({ path, files }) => {
      const allowance = debt[path];
      if (allowance === undefined) return [`FOLDER_TOO_WIDE ${path}:${files} > ${maximum}`];
      return files === allowance ? [] : [`FOLDER_WIDTH_DEBT_CHANGED ${path}:${files} != ${allowance}`];
    });
  const stale = Object.entries(debt).flatMap(([path, allowance]) => {
    const files = byPath.get(path);
    if (files === undefined) return [`STALE_FOLDER_WIDTH_DEBT ${path}:missing allowance=${allowance}`];
    return files <= maximum ? [`STALE_FOLDER_WIDTH_DEBT ${path}:${files} <= ${maximum}`] : [];
  });
  return [...tooWide, ...stale].sort();
};

const existingFiles = (repo: string): readonly string[] => {
  const listing = Bun.spawnSync(["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard"], { cwd: repo });
  if (listing.exitCode !== 0) return [];
  // A file deleted in the working tree but still tracked does not exist, so it is not counted.
  return [...new Set(listing.stdout.toString().split("\0").filter((file) => file !== ""))].filter((file) => existsSync(`${repo}/${file}`));
};

const run = (): number => {
  const repo = `${import.meta.dir}/../../..`;
  const files = existingFiles(repo);
  if (files.length === 0) {
    console.error("FAIL git listed no files (is this a git checkout?)");
    return 1;
  }
  const widths = widthsOf(files);
  const errors = evaluateFolderWidths(widths);
  errors.forEach((error) => console.error(`- ${error}`));
  const total = widths.reduce((sum, entry) => sum + entry.files, 0);
  console.log(errors.length === 0 ? `FOLDER_WIDTH_OK dirs=${widths.length} sourceFiles=${total} max=${MAX_DIRECT_SOURCE_FILES}` : "FOLDER_WIDTH_INVARIANT_FAILED");
  return errors.length === 0 ? 0 : 1;
};

if (import.meta.main) process.exit(run());
