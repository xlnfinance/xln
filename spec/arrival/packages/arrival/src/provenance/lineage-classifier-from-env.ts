/**
 * Builds a `Classifier` for `classify()` from a live `AmbientRuntime` by reading the
 * declared `provenance` role on each bound callable (`.provenanceRole` from
 * `Contract.provenance` at bake — common/capability.ts / symbols/_bake.ts). No name
 * list, purity probe, or duck-read.
 *
 * `env.get(op)` walks `__parent__`; parent roles are visible without re-walking here.
 * Unbound / undeclared names (user lambdas, anything without `.provenanceRole`) resolve
 * to `undefined` — classify default = pure/pipe, same as a shadowing local or unmodeled head.
 */
import { AmbientRuntime } from "../env/AmbientRuntime.js";
import type { Classifier, DeclaredRole } from "./lineage.js";

export function classifierFromEnv(env: AmbientRuntime): Classifier {
  return {
    roleOf: (op) =>
      (env.get(op, { throwError: false }) as { provenanceRole?: DeclaredRole } | undefined)?.provenanceRole,
  };
}
