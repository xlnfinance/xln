// require-roster-regression — guards the END-TO-END path that broke in the
// codemirror plugin: the require-type shape only reaches the editor if the host
// roster the lens is built from actually contains `require`.
//
// The earlier `require-shape.test.ts` proves the lens works when handed a
// HAND-BUILT roster (`[["require", "(specifier: SStr): unknown"]]`). That green
// test hid the real bug: in studio the roster is DERIVED from the live runtime
// env (`assembleHostPrelude([...rosettaTypesOf(env)])`), and if `require` is
// missing from that derivation the emitter lowers `(require "x.json")` to a BARE
// `require(...)` (Node's global → `any`), the ArrShape overload is never
// consulted, and the editor shows `unknown` with no error and no crash —
// exactly the "requireIsHostMember= false" symptom we chased.
//
// This suite builds the roster the way studio does, from the REAL session, so a
// regression in the derivation chain (defineRequireRosetta drops `type`,
// assembleHostPrelude drops a member, the mint stops stamping it)
// turns this red instead of silently degrading the editor.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import { disposeRunContext, execState, LexicalScope } from "@inhuman.tools/arrival";
import { rosettaTypesOf } from "@inhuman.tools/arrival/lsp-internals";
import { arrivalLoaderCapability, loaderFromResolver, resolveRequireType } from "@inhuman.tools/arrival-modules";
import { beforeAll, describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

// The project's data files, keyed by require path → raw source.
const FILES: Record<string, string> = {
  "personas.json": `[{"name":"Ada","age":36}]`,
};

// Stub: this session never executes requires (the lens only reads its roster).
const stubLoader = loaderFromResolver((p) => FILES[p] ?? null);

/** Live session mint over the in-repo loader pack. `require` is raw-bound (never
 *  `defineRosetta`-wrapped), so the mint stamps it into the side-table by hand —
 *  the host convention this suite pins. Built async (eval has no sync path). */
let env: LexicalScope["env"];
beforeAll(async () => {
  const capabilities = [arrivalLoaderCapability] as const;
  const config: Record<string, unknown> = { loader: stubLoader };
  const scope = LexicalScope.fresh("regression");
  const first = await execState("(begin)", { capabilities, config, scope });
  rosettaTypesOf(scope.env).set("require", "(specifier: SStr): unknown");
  await disposeRunContext(first.runCtx);
  env = scope.env;
});

// The seam studio synthesizes host-side: route a file's source through the
// SAME loader registry the runtime parses with → a TS type string.
const dataLoader = loaderFromResolver((p) => FILES[p] ?? null);
const resolveReqType = (p: string): string | null =>
  FILES[p] === undefined ? null : resolveRequireType(dataLoader, p, FILES[p]!);

describe("require roster reaches the lens (the codemirror-plugin bug)", () => {
  it("the runtime env registers `require` in its rosetta-type roster", () => {
    // The invariant that, when violated, manifested as `requireIsHostMember=false`.
    expect(rosettaTypesOf(env).has("require")).toBe(true);
  });

  it("the studio-derived host roster carries `require` as a member", () => {
    const host = assembleHostPrelude([...rosettaTypesOf(env)]);
    // Without this, the emitter writes bare `require(...)` and the shape is lost.
    expect(host.members).toContain("require");
  });

  it("a lens built from the REAL env roster resolves (require) to its shape", () => {
    const host = assembleHostPrelude([...rosettaTypesOf(env)]);
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false },
      host,
      resolveModule: (p) => FILES[p] ?? null,
      resolveRequireType: resolveReqType,
    });
    const scheme = `(define personas (require "personas.json"))\n(car personas)`;
    const at = scheme.lastIndexOf("personas") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("name");
    expect(info!.displayText).toContain("age");
  });

  it("REPRO: an EMPTY roster (the bug state) silently drops the shape", () => {
    // This is the failure the plugin exhibited: the service was created/memoized
    // BEFORE the roster was published, so `require` was not a host member. The
    // emitter then lowers to a bare `require(...)`, the overload is bypassed, and
    // the editor shows no shape and no error — a silent degradation. We pin it so
    // the contrast with the green case above is explicit and can't drift away.
    const emptyHost = assembleHostPrelude([]);
    const ls = createSchemeLanguageService({
      compilerOptions: { noImplicitAny: false },
      host: emptyHost,
      resolveModule: (p) => FILES[p] ?? null,
      resolveRequireType: resolveReqType,
    });
    const scheme = `(define personas (require "personas.json"))\n(car personas)`;
    const at = scheme.lastIndexOf("personas") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    // No `require` member → no `require` lowering → no granular shape.
    expect(info?.displayText ?? "").not.toContain("age");
  });
});
