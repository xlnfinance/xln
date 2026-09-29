// loader-extensions — file-type resolver registry behind `(require/register-extension)`.
//
// A file-type "extension" is a resolver, not a verb-pack: `(contents, filepath) → value`.
// Registration mutates a table: file-suffix → NAME of the resolver verb.
//
// Design:
//   • BY-NAME, late-bound per env. Table stores the verb NAME, not its value. `require`
//     looks the name up in the CURRENT env and calls it — a resource-armed resolver
//     (`.prompt` → `prompt/compile`) picks up the calling env's resource; an env that
//     never rooted the owning capability has no binding and errors. Global vocabulary,
//     per-scope capability.
//   • PRELUDE-ONLY. `require/register-extension` is preludeOnly MACRO (loader-capability.ts)
//     so the resolver name is UNEVALUATED. Never bound into the runtime env — a running
//     program cannot teach the loader a new file type mid-run.
//
// ONE registry per run: THIS run's `LoaderRunResources.extensionResolvers` (fresh empty
// Map per RunContext, populated only from a prelude). `registerExtensionTransformer`
// closes over `resolveRegistry(ctx.runCtx)` to pick the bag.
// Shared primitives (`registerExtensionIn` / `lookupExtensionResolverIn`) keep the
// conflict door and longest-suffix match in one place.

import type { RunContext, SchemeValue } from "@inhuman.tools/arrival";
import { ANil, APair, AString, ASymbol, nil } from "@inhuman.tools/arrival/reflect-internals";
import invariant from "tiny-invariant";

import { ExtensionSuffixConflictError } from "./errors.js";

/** The args bag a `require/register-extension` transformer receives. `runCtx`
 *  rides MacroInvokeContext (evaluator threads it). */
interface TransformerArgs {
  runCtx: RunContext;
}

/** ext-suffix (e.g. `".prompt"`) → NAME of the resolver verb. */
export type ExtensionResolverRegistry = Map<string, string>;

/** Coerce a name argument (string, AString, ASymbol, or (quote SYMBOL)) to the bound verb name. */
function resolverNameOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof AString) return String(raw.valueOf());
  if (raw instanceof ASymbol) return raw.literal();
  // (quote name)
  if (raw instanceof APair) {
    const head = raw.car;
    if (head instanceof ASymbol && head.literal() === "quote" && raw.cdr instanceof APair) {
      const body = raw.cdr.car;
      if (body instanceof ASymbol) return body.literal();
      if (body instanceof AString) return String(body.valueOf());
    }
  }
  return String(raw);
}

function suffixOf(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof AString) return String(raw.valueOf());
  if (raw instanceof ASymbol) return raw.literal();
  return String(raw);
}

function normalizeSuffix(ext: string): string {
  return ext.startsWith(".") ? ext : `.${ext}`;
}

/** Register suffix → resolver-verb-name into `registry`. Idempotent for identical mapping;
 *  conflicting name for an already-registered suffix throws (never silent last-write-wins). */
export function registerExtensionIn(registry: ExtensionResolverRegistry, ext: unknown, resolverName: unknown): void {
  const suffix = normalizeSuffix(suffixOf(ext));
  const name = resolverNameOf(resolverName);
  const existing = registry.get(suffix);
  ExtensionSuffixConflictError.invariant(existing === undefined || existing === name, suffix, existing ?? name, name);
  registry.set(suffix, name);
}

/** Resolver verb name for a path by LONGEST matching suffix (`.spec.json` beats `.json`).
 *  `undefined` when no match — caller decides error vs fall-through to builtin. */
export function lookupExtensionResolverIn(registry: ExtensionResolverRegistry, path: string): string | undefined {
  let best: string | undefined;
  let bestLen = -1;
  for (const [suffix, name] of registry) {
    if (path.endsWith(suffix) && suffix.length > bestLen) {
      best = name;
      bestLen = suffix.length;
    }
  }
  return best;
}

/**
 * Transformer for `require/register-extension`. Args are UNEVALUATED forms:
 *   (require/register-extension ".prompt" ext/prompt/resolve)
 * Side-effects `resolveRegistry(ctx.runCtx)`; expands to nil.
 * `ctx.runCtx` rides MacroInvokeContext (evaluator threads it) — never through makeCallCtx.
 * Bound via `symbol.macro` (and reused as the mid-run seed) in loader-capability.ts.
 */
export function registerExtensionTransformer(
  resolveRegistry: (runCtx: RunContext) => ExtensionResolverRegistry,
): (rest: SchemeValue, ctx: TransformerArgs) => SchemeValue {
  return function (rest: SchemeValue, ctx: TransformerArgs): SchemeValue {
    invariant(rest instanceof APair, "require/register-extension: expected (suffix resolver-name)");
    const suffixForm = rest.car;
    invariant(rest.cdr instanceof APair, "require/register-extension: missing resolver-name");
    const nameForm = rest.cdr.car;
    invariant(
      rest.cdr.cdr instanceof ANil || rest.cdr.cdr == null,
      "require/register-extension: expected exactly 2 args",
    );
    registerExtensionIn(resolveRegistry(ctx.runCtx), suffixForm, nameForm);
    return nil;
  };
}
