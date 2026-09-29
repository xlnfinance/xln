// Require doors — each names a distinct way `(require …)` refuses.
// Extend ArrivalError so host `formatRunError` / `instanceof ArrivalError` still classify them.

import { ArrivalError, type ErrorClass } from "@inhuman.tools/arrival";

/** A require verb ran outside evaluator dispatch, so `this.resolver` is missing. */
export class RunResolverUnreachableError extends ArrivalError {
  public readonly name = "RunResolverUnreachableError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(public readonly verb: string) {
    super(
      `${verb}: no run resolver on this CallCtx — the verb was called outside evaluator ` +
        `dispatch (direct JS calls must go through exec/execExpr so makeCallCtx receives the composed resolver).`,
    );
  }
}

/** A `require`d path fails the traversal jail: a NUL byte, or a `..` that would escape the root. */
export class RequirePathError extends ArrivalError {
  public readonly name = "RequirePathError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly kind: "nul-byte" | "escapes-root",
    public readonly path: string,
  ) {
    super(
      kind === "nul-byte"
        ? `require: invalid path (NUL byte): ${JSON.stringify(path)}`
        : `require: path escapes the project root: ${path}`,
    );
  }
}

/** `require` detected its own module still evaluating higher up the same chain. */
export class RequireCycleError extends ArrivalError {
  public readonly name = "RequireCycleError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(public readonly chain: readonly string[]) {
    super(`require: cyclic dependency: ${chain.join(" → ")}`);
  }
}

/** No handler for a path, or no armed extension for a requested `:name`. */
export class RequireResolverError extends ArrivalError {
  public readonly name = "RequireResolverError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly kind: "no-resolver" | "no-extension",
    /** The unresolved path (`"no-resolver"`) or extension name (`"no-extension"`). */
    public readonly path: string,
    /** Currently-armed extension names — set only for `"no-extension"`. */
    public readonly armedExtensions?: readonly string[],
  ) {
    super(
      kind === "no-resolver"
        ? `require: no resolver for ${path}`
        : `require/extension: no extension :${path}. Armed extensions: ${
            armedExtensions && armedExtensions.length > 0
              ? armedExtensions.map((k) => `:${k}`).join(", ")
              : "(none — the host registered no extension packs for this env)"
          }`,
    );
  }
}

/** Two capabilities registered different resolver verbs for the same file suffix. */
export class ExtensionSuffixConflictError extends ArrivalError {
  public readonly name = "ExtensionSuffixConflictError";
  readonly "arrival/error-category": ErrorClass = "other";

  constructor(
    public readonly suffix: string,
    public readonly existing: string,
    public readonly attempted: string,
  ) {
    super(
      `require/register-extension: "${suffix}" is already handled by "${existing}", cannot reassign to ` +
        `"${attempted}". A file suffix maps to exactly one resolver; two capabilities are claiming it.`,
    );
  }
}
