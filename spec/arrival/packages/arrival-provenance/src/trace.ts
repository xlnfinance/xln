/**
 * Thin facade over `@inhuman.tools/arrival`'s (core) mobx-free tracing spine.
 *
 * `EvalTrace`/`Invocation`/`NodeRecord`/`computeProvenance` live in
 * `@inhuman.tools/arrival/src/provenance/trace.ts` (core), which must not depend
 * on mobx. This file exists so every sibling analysis file here (and every
 * external consumer importing `@inhuman.tools/arrival-provenance`) keeps
 * importing "./trace.js" / `{ EvalTrace }` unchanged.
 *
 * The one thing this shim does NOT just pass through: `EvalTrace`. Studio
 * consumers (`TraceGraph`'s `reaction(() => trace.entries)`) and
 * `arrival-chain`'s tests depend on `EvalTrace` being mobx-reactive — that
 * reactivity lives HERE, not in core, as {@link ObservableEvalTrace},
 * exported below AS `EvalTrace`. This package keeps the `mobx` dependency;
 * core does not.
 */
import { action, observable } from "mobx";

import { EvalTrace as CoreEvalTrace, DEFAULT_TRACE_CAP } from "@inhuman.tools/arrival/provenance";

// The plain (mobx-free) core class, for a consumer that explicitly wants the
// non-reactive spine (e.g. a benchmark measuring the de-MobXed hot path).

/**
 * Mobx-reactive subclass of {@link CoreEvalTrace} with an `observable.box`
 * entries counter and an action-wrapped `enter`. Overrides the two seams core exposes for this
 * purpose (see the seam design documented in core's `trace.ts`):
 *   - `bumpEntries()` — writes the observable box instead of a plain field.
 *   - `entries` getter — reads the observable box.
 *   - `enter` — re-assigned in the constructor to a mobx `action`-wrapped
 *     call to the core (plain) `enter`, so the observed-observable write
 *     inside `bumpEntries` satisfies strict mode's "mutate only in an
 *     action" rule (`enforceActions: "observed"`, which the studio enables).
 *
 * Exported below AS `EvalTrace` — every existing `new EvalTrace()` call site
 * (the studio, `arrival-chain`'s tests) gets this reactive subclass.
 */
class ObservableEvalTrace extends CoreEvalTrace {
  readonly #entriesBox = observable.box(0);

  protected override bumpEntries(): void {
    this.#entriesBox.set(this.#entriesBox.get() + 1);
  }

  override get entries(): number {
    return this.#entriesBox.get();
  }

  constructor(maxEntries: number = DEFAULT_TRACE_CAP) {
    super(maxEntries);
    // Capture the core's plain `enter` (already an instance-field arrow
    // function bound to `this`), then replace `this.enter` with an
    // `action`-wrapped call to that same function (see the preamble bullet on
    // `enter` for why the wrap is required under strict mode).
    const coreEnter = this.enter;
    this.enter = action((...args: Parameters<typeof coreEnter>) => coreEnter(...args));
  }
}

export { ObservableEvalTrace as EvalTrace };

export {
  Invocation,
  type InvocationState,
  EvalTrace as CoreEvalTrace,
  NodeRecord,
  DEFAULT_TRACE_CAP,
} from "@inhuman.tools/arrival/provenance";
