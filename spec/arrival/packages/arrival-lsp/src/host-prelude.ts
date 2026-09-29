// host-prelude — assemble a lens `host` option from a host's rosetta type registry.
//
// THE SINGLE-SOURCE SEAM. A host (sift) registers each evidence tool with a TS
// signature string and lands it on the env's rosetta-type registry
// (`rosettaTypesOf(env)` — via `symbol.rosetta` / internal bind). This function
// turns that registry into the two coupled artifacts the type-lens needs — both
// derived from the ONE registration, so type knowledge lives WITH the rosetta
// and cannot drift into a parallel hand-maintained `.d.ts`:
//
//   • `prelude` — ambient `.d.ts` text: the host's entity-type `preamble` followed
//     by one `declare function <encodeSchemeIdent(name)>…` per tool. Same global
//     ambient scope as the builtin leaves, so `typeof <encoded>` resolves (the
//     CANDIDATE side of the mask narrows).
//   • `members` — the tool names (scheme spelling). The emitter lowers a head in
//     this set via bare `encodeSchemeIdent(name)(…)` like a builtin, so
//     `Parameters<typeof head>` resolves (the SLOT side narrows).
//
// The result plugs straight into `createSchemeLanguageService({ host })`.
//
// CONTRACT: each `type` is either
//   • a function TAIL `"(ip: SchemeIP): boolean"` → `declare function encoded(…): R`
//   • an arrow `"(list: List<string>) => string"` or overload object `{ <T>(…): R; }`
//     → `declare const encoded: <sig>` (authored `type:` / `signatureOf` harvest)
// The name is encoded (`"ip/x?"` → `ip$slash$x$qmark$`). Base types (`List`,
// scalars, `Tuple`) are in scope from the lens prelude (`types.d.ts`); host
// entity types MUST be declared in `preamble` (ambient, no import/export).

import { decodeSchemeIdent, encodeSchemeIdent } from "@inhuman.tools/arrival-types-bridge";

export interface HostPrelude {
  /** Ambient `.d.ts` text — the entity preamble + host `declare function`s. */
  prelude: string;
  /** The host member names (scheme spelling) — the emitter's head roster. */
  members: string[];
  /**
   * Heads whose Contract `inputRest` is a **plain record** (kwargs channel).
   * Threaded into `emitTypes({ kwargsMembers })` so trailing `:k v` collapse
   * only for true kwargs callees — not for positional HOFs like `map`/`where`.
   * Path-suffix kwargs (`(require "x.prompt")`) are a separate host option
   * (`kwargsRequireSuffixes` on the language service).
   */
  kwargsMembers: string[];
}

export interface AssembleHostPreludeOptions {
  /**
   * Ambient TS declaring the host's entity + row types referenced by the tool
   * signatures (`interface Connection { … }`, `interface SchemeIP { … }`, …). No
   * `import`/`export` — it is concatenated into the shared global ambient scope.
   */
  preamble?: string;
  /**
   * Subset of entry names with record-shaped `inputRest`. When omitted, empty
   * (path-suffix kwargs are `kwargsRequireSuffixes` on the language service).
   */
  kwargsMembers?: readonly string[];
}

/**
 * True when `sig` is a function TAIL (`(args): R`) rather than an arrow or
 * overload object. Callback params may contain inner `=>`; the top-level return
 * is still `: R` after the last `):`.
 */
export function isFunctionTailSignature(sig: string): boolean {
  const s = sig.trim();
  if (s.startsWith("{")) return false;
  const lastArrow = s.lastIndexOf("=>");
  const lastColonParen = s.lastIndexOf("):");
  if (lastArrow === -1) return true;
  if (lastColonParen === -1) return false;
  return lastColonParen > lastArrow;
}

function hostDeclare(name: string, type: string): string {
  const enc = encodeSchemeIdent(name);
  const sig = type.trim();
  if (isFunctionTailSignature(sig)) return `declare function ${enc}${sig};`;
  return `declare const ${enc}: ${sig};`;
}

/** Scheme names of ambient `declare function` leaves in prelude file texts. */
export function leafNamesFromPreludeFiles(files: Iterable<string>): Set<string> {
  const names = new Set<string>();
  const re = /\bdeclare\s+function\s+([A-Za-z_$][\w$]*)/g;
  for (const text of files) {
    for (const m of text.matchAll(re)) {
      const enc = m[1]!;
      if (enc === "sexpr" || enc.startsWith("__")) continue;
      try {
        names.add(decodeSchemeIdent(enc));
      } catch {
        names.add(enc);
      }
    }
  }
  return names;
}

/**
 * Build the `{ prelude, members, kwargsMembers }` host option from `[name, type]`
 * rosetta entries (e.g. `[...rosettaTypesOf(env)]`). Order-independent; duplicate
 * names keep the last entry (a re-registration overrides).
 */
export function assembleHostPrelude(
  entries: Iterable<readonly [name: string, type: string]>,
  opts?: AssembleHostPreludeOptions,
): HostPrelude {
  const byName = new Map<string, string>(entries);
  const members = [...byName.keys()];
  const kwargsSet = new Set(opts?.kwargsMembers);
  // Only keep kwargs names that are also host members (no orphans).
  const kwargsMembers = members.filter((m) => kwargsSet.has(m));

  return {
    prelude: [
      "// Host-injected ambient prelude (assembled from the rosetta type registry).",
      opts?.preamble ?? "",
      ...members.map((name) => hostDeclare(name, byName.get(name)!)),
      "",
    ].join("\n"),
    members,
    kwargsMembers,
  };
}
