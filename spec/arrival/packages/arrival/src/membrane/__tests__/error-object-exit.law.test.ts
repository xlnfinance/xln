/**
 * Error-object membrane law.
 *
 * Two crossing rules, one for each direction:
 *
 *   EXIT — an R7RS error object produced AS A VALUE (guard's `else` returning it,
 *   `raise-continuable` resuming with it, `make-error-object` as a final form) exits
 *   as a same-class host `Error`: message preserved, irritants crossed elementwise,
 *   original stack carried over. R7RSError is deliberately a host Error subclass, not
 *   an AValue box, so it passes neither the strict-exit invariant nor the protocol
 *   dispatch — `errorToHost` (rosetta.ts) is its arm, shared by `toJS` so the
 *   value-exit cannot drift from element recursion. A RAISED error never touches the arm:
 *   it reaches the host through the throw path (rejection), and these tests pin that
 *   the arm did not change that.
 *
 *   ENTER — a host Error crosses borrowed (AJSObject over the source). Its `stack`
 *   is a host-internals confession (file paths, call sites) the sandbox has no use
 *   for: the read collapses to absent (nil / not-has / unlisted), the same shape as
 *   a boundary violation. `message` / `name` stay readable — they are the data face.
 */

import { describe, expect, it } from "vitest";
import { exec, execState } from "../../eval/generator-exec.js";
import { toJS, errorToHost, jsToScheme } from "../rosetta.js";
import { R7RSError, R7RSReadError } from "../../errors.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { EMPTY_PROVENANCE } from "../../values/primitives/AValue.js";
import { nil } from "../../values/primitives/ANil.js";
import { AString } from "../../values/primitives/AString.js";
import { AJSObject } from "../AJSObject.js";
import { type SchemeValue } from "../../values/types.js";
import { EnvCapability } from "../../common/capability.js";

describe("error-object exit arm (value position)", () => {
  it("make-error-object as a final form exits as a same-class host Error", async () => {
    const [err] = await exec(`(make-error-object "hi" 1)`);
    expect(err).toBeInstanceOf(R7RSError);
    expect((err as R7RSError).message).toBe("hi");
    expect((err as R7RSError).irritants).toEqual([1]);
  });

  it("guard's else returning the condition exits it as a value", async () => {
    const [err] = await exec(`(guard (exn (else exn)) (error "boom" 42))`);
    expect(err).toBeInstanceOf(R7RSError);
    expect((err as R7RSError).message).toBe("boom");
    expect((err as R7RSError).irritants).toEqual([42]);
  });

  it("toJS exits a boxed error as a same-class host Error (irritants crossed)", async () => {
    const {
      values: [boxed],
    } = await execState(`(make-error-object "drift" 42 "tag")`);
    const viaToJS = toJS(boxed) as R7RSError;
    expect(viaToJS).toBeInstanceOf(R7RSError);
    expect(viaToJS.message).toBe("drift");
    expect(viaToJS.irritants).toEqual([42, "tag"]);
  });

  it("subclass fidelity: same class, name, irritants crossed, original stack carried", () => {
    const original = new R7RSReadError("read-boom", 1, "x");
    const crossed = errorToHost(original, (el) => el);
    expect(crossed).not.toBe(original);
    expect(crossed).toBeInstanceOf(R7RSReadError);
    expect(crossed).toBeInstanceOf(R7RSError);
    expect(crossed.name).toBe("R7RSReadError");
    expect(crossed.message).toBe("read-boom");
    expect(crossed.irritants).toEqual([1, "x"]);
    expect(crossed.stack).toBe(original.stack);
  });

  it("a RAISED error still takes the throw path — rejection, not the value-exit arm", async () => {
    await expect(exec(`(error "bang")`)).rejects.toThrow();
  });
});

describe("host Error inbound — stack collapses to absent", () => {
  const wrappedError = () => {
    const w = jsToScheme(CONSTANT_CTX, new Error("host-boom"), {}, EMPTY_PROVENANCE);
    expect(w).toBeInstanceOf(AJSObject);
    return w as AJSObject;
  };

  it("stack reads nil; message stays readable", () => {
    const w = wrappedError();
    expect(w.get("stack")).toBe(nil);
    const message = w.get("message");
    expect(message).toBeInstanceOf(AString);
    expect(String(message)).toBe("host-boom");
  });

  it("stack is not-has and unlisted (Error own props are non-enumerable — keys is [] by JS semantics)", () => {
    const w = wrappedError();
    expect(w.has("stack")).toBe(false);
    expect(w.has("message")).toBe(true);
    expect(w.keys()).not.toContain("stack");
  });

  it("the whole path: Error → borrowed wrapper → @ → nil at the exec boundary", async () => {
    const errCap = EnvCapability.define("test/host-error", {
      symbols: (symbol, z) => ({
        "host-error": symbol.rosetta`host-error: a host Error object`(
          { input: [], output: [z.dynamic] },
          // The impl returns a raw host Error, which crosses BORROWED (AJSObject
          // wrapper) — the cast names the post-crossing truth the borrow performs.
          async () => new Error("host-boom") as unknown as SchemeValue,
        ),
      }),
    });
    // nil is the empty list — assert in Scheme coordinates (`null?`), not by exit shape.
    const [stackIsNil] = await exec(`(null? (@ (host-error) "stack"))`, { capabilities: [errCap] });
    expect(stackIsNil).toBe(true);
    const [message] = await exec(`(@ (host-error) "message")`, { capabilities: [errCap] });
    expect(message).toBe("host-boom");
  });
});
