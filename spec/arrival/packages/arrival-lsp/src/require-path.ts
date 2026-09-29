/**
 * Project-files require path lookup.
 *
 * Specifiers are looked up against a flat `{ path → source }` table whose keys
 * are POSIX-relative to the project root (studio `snapshotText` / folder seed).
 * The host often opens a multi-package tree (`examples/`), so bare `"config.scm"`
 * is not an exact key — resolve relative to the open buffer, then by unique
 * basename / suffix.
 */

export interface RequirePathLookupOptions {
  /** Open buffer path (project-relative), for `./` and bare relative resolution. */
  fromFile?: string | null;
  /** Log misses / ambiguities (studio console). Default false. */
  log?: boolean;
  /** Label for log lines. */
  logLabel?: string;
}

/** Dedup miss logs so lint-on-keystroke does not flood the console. */
const loggedMisses = new Set<string>();
const MAX_LOGGED = 40;
function logOnce(key: string, fn: () => void): void {
  if (loggedMisses.has(key)) return;
  if (loggedMisses.size >= MAX_LOGGED) loggedMisses.clear();
  loggedMisses.add(key);
  fn();
}

function stripDotSlash(spec: string): string {
  return spec.replace(/^\.\//, "");
}

/** dirname of a POSIX project path; "" for a root-level file. */
export function projectDirname(filePath: string): string {
  const i = filePath.lastIndexOf("/");
  return i === -1 ? "" : filePath.slice(0, i);
}

/** Join project-relative dir + relative segment (no `..` walk-out). */
export function projectJoin(dir: string, rel: string): string {
  const clean = stripDotSlash(rel);
  if (!dir) return clean;
  if (!clean) return dir;
  // Drop `./` segments; refuse `..` (stay inside the project table).
  const parts = [...dir.split("/").filter(Boolean), ...clean.split("/").filter((p) => p && p !== ".")];
  const out: string[] = [];
  for (const p of parts) {
    if (p === "..") {
      if (out.length === 0) return clean; // would escape root — fall back to bare
      out.pop();
    } else out.push(p);
  }
  return out.join("/");
}

/**
 * Resolve a require specifier to a project table key, or null.
 *
 * Order:
 * 1. exact key (after stripping leading `./`)
 * 2. relative to `fromFile`'s directory
 * 3. unique key ending with `/spec` or equal to basename when unique
 */
export function resolveRequireProjectKey(
  files: Readonly<Record<string, string>> | null | undefined,
  specifier: string,
  opts?: RequirePathLookupOptions,
): string | null {
  if (!files) return null;
  const keys = Object.keys(files);
  if (keys.length === 0) {
    if (opts?.log) {
      logOnce(`empty:${specifier}`, () =>
        console.warn(
          `[${opts.logLabel ?? "scheme-require"}] miss ${JSON.stringify(specifier)} — project files table empty`,
        ),
      );
    }
    return null;
  }

  const bare = stripDotSlash(specifier);

  if (Object.prototype.hasOwnProperty.call(files, bare)) return bare;
  if (Object.prototype.hasOwnProperty.call(files, specifier)) return specifier;

  if (opts?.fromFile) {
    const joined = projectJoin(projectDirname(opts.fromFile), bare);
    if (joined !== bare && Object.prototype.hasOwnProperty.call(files, joined)) return joined;
  }

  // Unique suffix: `inhuman-custdev/config.scm` when asking for `config.scm`
  // or `./config.scm`, and only one key ends with that basename path.
  const suffix = bare.includes("/") ? `/${bare}` : `/${bare}`;
  const suffixHits = keys.filter((k) => k === bare || k.endsWith(suffix));
  if (suffixHits.length === 1) return suffixHits[0]!;
  if (suffixHits.length > 1) {
    if (opts?.log) {
      logOnce(`ambig:${specifier}:${opts.fromFile ?? ""}`, () =>
        console.warn(
          `[${opts.logLabel ?? "scheme-require"}] ambiguous ${JSON.stringify(specifier)} — ` +
            `${suffixHits.length} keys: ${suffixHits
              .slice(0, 8)
              .map((k) => JSON.stringify(k))
              .join(", ")}${
              suffixHits.length > 8 ? "…" : ""
            }${opts.fromFile ? ` (from ${JSON.stringify(opts.fromFile)})` : ""}`,
        ),
      );
    }
    return null;
  }

  if (opts?.log) {
    const sample = keys
      .slice(0, 12)
      .map((k) => JSON.stringify(k))
      .join(", ");
    logOnce(`miss:${specifier}:${opts.fromFile ?? ""}`, () =>
      console.warn(
        `[${opts.logLabel ?? "scheme-require"}] miss ${JSON.stringify(specifier)}${
          opts.fromFile ? ` from ${JSON.stringify(opts.fromFile)}` : ""
        } — ${keys.length} files, sample: ${sample}${keys.length > 12 ? "…" : ""}`,
      ),
    );
  }
  return null;
}

/** Resolve specifier → file text (or null). */
export function lookupProjectFile(
  files: Readonly<Record<string, string>> | null | undefined,
  specifier: string,
  opts?: RequirePathLookupOptions,
): string | null {
  const key = resolveRequireProjectKey(files, specifier, opts);
  if (key === null || !files) return null;
  return files[key] ?? null;
}

/** Resolve specifier → precomputed require type string (or null). */
export function lookupProjectRequireType(
  types: Readonly<Record<string, string>> | null | undefined,
  specifier: string,
  opts?: RequirePathLookupOptions,
): string | null {
  // Types share the same key space as files.
  const key = resolveRequireProjectKey(types as Record<string, string> | null, specifier, {
    ...opts,
    // Don't double-log type misses when files already logged — only log when asked.
    log: opts?.log,
    logLabel: opts?.logLabel ?? "scheme-require-type",
  });
  if (key === null || !types) return null;
  return types[key] ?? null;
}
