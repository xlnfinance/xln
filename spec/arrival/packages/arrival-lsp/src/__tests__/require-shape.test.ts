// require-shape — `(require "data.json")` resolves to its GRANULAR shape, not
// `unknown`. The editor twin of the runtime loader registry: the lens is fed a
// `resolveRequireType` seam over the loader builtins plus test-local type
// facets for dep-bearing suffixes (yaml/hbs). Those suffixes have no type
// channel on the loader barrel (the owning capability registers runtime parse
// only); the lens still needs a type string, so this file supplies one.
//
// Per `.claude/rules/tests.md` this is a `__tests__/` verdict (boolean pass/fail).

import {
  loaderFromResolver,
  resolveRequireType,
  valueToTsType,
  type ExtensionHandler,
  type Loader,
} from "@inhuman.tools/arrival-modules";
import { describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService } from "../language-service.js";

// The project's data files, keyed by require path → raw source. The host
// (studio) holds these; here a tiny in-memory map stands in.
const FILES: Record<string, string> = {
  "personas.json": `[{"name":"Ada","age":36}]`,
  "config.yaml": `title: Hi\ncount: 3`,
};

/** Fixture-only `key: value` maps — proves the lens seam, not yaml correctness. */
const yamlType: ExtensionHandler = {
  resolve: (contents) => ({ kind: "value", value: contents }),
  type: (source) => {
    const obj: Record<string, unknown> = {};
    for (const line of source.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      const colon = trimmed.indexOf(":");
      if (colon === -1) continue;
      const key = trimmed.slice(0, colon).trim();
      const raw = trimmed.slice(colon + 1).trim();
      const n = Number(raw);
      obj[key] = raw !== "" && Number.isFinite(n) ? n : raw;
    }
    return valueToTsType(obj);
  },
};

const hbsType: ExtensionHandler = {
  resolve: (contents) => ({ kind: "value", value: contents }),
  type: () => `(arg: unknown, ...rest: unknown[]) => string`,
};

function editorLoader(files: Record<string, string>): Loader {
  const loader = loaderFromResolver((p) => files[p] ?? null);
  loader.resolvers.set(".yaml", yamlType);
  loader.resolvers.set(".yml", yamlType);
  loader.resolvers.set(".hbs", hbsType);
  return loader;
}

const loader = editorLoader(FILES);
// `require` must be a HOST MEMBER for the emitter to lower `(require …)` →
// `require(…)` (a bare `require` would resolve to Node's global → any).
// In studio this comes from `rosettaTypesOf(env)`; here a one-entry roster.
const host = assembleHostPrelude([["require", "(specifier: SStr): unknown"]]);
const ls = createSchemeLanguageService({
  compilerOptions: { noImplicitAny: false },
  host,
  resolveModule: (p) => FILES[p] ?? null,
  resolveRequireType: (p) => (FILES[p] === undefined ? null : resolveRequireType(loader, p, FILES[p]!)),
});

describe("(require data-file) → granular shape", () => {
  it("a required .json hovers as its precise list-of-object shape", () => {
    const scheme = `(define personas (require "personas.json"))\n(car personas)`;
    const at = scheme.lastIndexOf("personas") + 1; // body occurrence (token-mapped)
    const info = ls.getQuickInfoAtPosition(scheme, at);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("name");
    expect(info!.displayText).toContain("age");
  });

  it("a required .yaml resolves its object shape too", () => {
    const scheme = `(define cfg (require "config.yaml"))\n(car (list cfg))`;
    const at = scheme.lastIndexOf("cfg") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    expect(info).not.toBeNull();
    expect(info!.displayText).toContain("title");
    expect(info!.displayText).toContain("count");
  });

  it("misusing a field's type bites — the shape is real, not unknown", () => {
    // `age` is number; string-append wants string — must error, proving the field
    // type flows (an `unknown` require would NOT bite). (car sugarcoats to [0]
    // which no longer rejects numbers under noImplicitAny:false.)
    const scheme = `(define personas (require "personas.json"))\n` + `(string-append (@ (car personas) "age") "x")`;
    const diags = ls.getSemanticDiagnostics(scheme);
    expect(diags.length).toBeGreaterThan(0);
  });

  it("an unmapped require stays unknown — no overload, no false shape", () => {
    const scheme = `(define x (require "mystery.bin"))\n(car (list x))`;
    const at = scheme.lastIndexOf("x") + 1;
    const info = ls.getQuickInfoAtPosition(scheme, at);
    // No shape pushed for .bin → require stays `unknown`; no crash, no overload.
    expect(info?.displayText ?? "").not.toContain("name");
  });
});

// Regression: incomplete specialized `require("path")` overloads made a second
// data path fail with `'"summary-of-persona.hbs"' is not assignable to
// parameter of type '"personas.yaml"'`. Require-as-import gives each path its
// own default-export module instead.
describe("require-as-import — multi-path faces (no overload bag)", () => {
  const multiFiles: Record<string, string> = {
    "personas.yaml": `name: Ada\nage: 36\n`,
    "summary-of-persona.hbs": "Hello {{name}}",
  };
  const multiLoader = editorLoader(multiFiles);
  const multiLs = createSchemeLanguageService({
    compilerOptions: { noImplicitAny: false },
    host: assembleHostPrelude([["require", "(specifier: SStr): unknown"]]),
    resolveModule: (p) => multiFiles[p] ?? null,
    resolveRequireType: (p) => {
      const text = multiFiles[p];
      if (text === undefined) return null;
      return resolveRequireType(multiLoader, p, text);
    },
  });

  it("yaml + hbs together: no path-literal overload clash", () => {
    const scheme =
      `(define personas (require "personas.yaml"))\n` +
      `(define summary (require "summary-of-persona.hbs"))\n` +
      `(summary personas)\n`;
    const program = multiLs.getTypelevelProgram(scheme);
    expect(program).toMatch(/import __req\d+ from "\.\/__req__\/personas\.yaml\.ts"/);
    expect(program).toMatch(/import __req\d+ from "\.\/__req__\/summary-of-persona\.hbs\.ts"/);
    expect(program).not.toMatch(/declare function require\(specifier: "/);
    expect(program).not.toMatch(/require\("/);

    const modules = multiLs.getTypelevelModules();
    expect(Object.keys(modules).some((k) => k.includes("personas.yaml"))).toBe(true);
    expect(Object.keys(modules).some((k) => k.includes("summary-of-persona.hbs"))).toBe(true);

    const diags = multiLs.getSemanticDiagnostics(scheme);
    const clash = diags.filter((d) =>
      /No overload matches|not assignable to parameter of type '"/.test(String(d.messageText ?? "")),
    );
    expect(clash).toEqual([]);
  });
});
