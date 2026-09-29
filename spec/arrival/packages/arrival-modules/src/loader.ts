/**
 * Module RESOLUTION primitives for `(require …)`: Loader interface (resolve + read +
 * per-suffix ExtensionHandler table), path jail, builtin data-format parsers, and
 * data ↔ scheme ↔ editor-TS-type projections.
 *
 * The require VERB (single-flight cache, cycle detection, eval loop) is declared by
 * `arrivalLoaderCapability` as symbol.native — state lives on that capability's
 * per-RunContext resources bag. `runResolverOf`/`runEnvOf` read the composed
 * resolver off `this: CallCtx` (evaluator dispatch puts it there).
 */
import { execExpr, parse, jsToScheme, type CallCtx, type SchemeValue } from "@inhuman.tools/arrival";
import { CONSTANT_CTX, type SchemeEnv } from "@inhuman.tools/arrival/host-internals";
import { ABytevector, ADict, APair, AString, ASymbol, nil } from "@inhuman.tools/arrival/reflect-internals";
import { RunResolverUnreachableError, RequirePathError } from "./errors.js";
import { parseJsonc } from "./parse-jsonc.js";

/** Sync-or-async. A type that forces `Promise<T>` would tax every sync resolver. */
export type MaybePromise<T> = T | Promise<T>;

/** The run env the verbs evaluate module forms into — typed `SchemeEnv`, never the
 *  package-internal `AmbientRuntime` class. Every real caller's env is a base-linked live one
 *  (the prelude-scope mint in loader-capability.ts's `require/extension`). */
export type RunEnv = SchemeEnv;

/** A scheme value, derived from the public `execExpr` (the concrete union is not on
 *  arrival's public surface, but the alias is exported so `dataToScheme` / `require`'s
 *  declaration (loader-capability.ts) can name it — a derived name, not a new type). */
export type SchemeVal = Awaited<ReturnType<typeof execExpr>>;

/** The run's COMPOSED resolver (scope + capability base) — teaching error when absent.
 *  require is a membrane penetration; it reads `this.resolver`, which evaluator
 *  dispatch copies from `EvalContext.resolver` onto the CallCtx.
 *
 *  WHY resolver not just env: lexical frame is null-rooted; stdlib lives on capability base.
 *  Evaluating forms against env alone loses builtins. Through THIS resolver, defines still
 *  spill into `resolver.env` and builtins resolve as for the requiring program. */
/** The composed resolver `CallCtx.resolver` names — env + lookup. Arrival's
 *  concrete `Resolver` class is not part of this package's surface. */
export type RunResolver = NonNullable<CallCtx["resolver"]>;

export function runResolverOf(ctx: CallCtx, verb: string): RunResolver {
  const resolver = ctx.resolver;
  RunResolverUnreachableError.invariant(resolver !== undefined, verb);
  return resolver;
}

/** The run env these verbs spill module `define`s into — the composed resolver's lexical
 *  frame. The env-shaped face of {@link runResolverOf} for callers that need only the frame
 *  (`require/extension`'s assembler binding, the prelude-scope mint). The through-`unknown`
 *  widen is safe: the frame is a concrete `AmbientRuntime` satisfying `SchemeEnv`, and every
 *  use here is on the shared surface. */
export function runEnvOf(ctx: CallCtx, verb: string): RunEnv {
  return runResolverOf(ctx, verb).env as unknown as RunEnv;
}

/** A parsed scheme form — exactly what `parse` yields and `execExpr` consumes.
 *  Derived from `parse` to avoid depending on the (unexported) `SchemeValue`. */
export type SchemeForm = Awaited<ReturnType<typeof parse>>[number];

/** What an extension resolver produces; the require rosetta executes it.
 *  - `load`  → `execExpr` each form into the run env (spill); require returns ⊥.
 *  - `eval`  → `execExpr` the forms, return the LAST value (e.g. an `.hbs` lambda).
 *  - `value` → return the (plain, membrane-safe) value; the caller binds it
 *    explicitly with `(define x (require …))`. No spill into the global env — a
 *    data file's binding is as greppable and provenance-clear as an import.
 *
 *  ── THE CALLABLE RULE (non-obvious, load-bearing) ─────────────────────────────
 *  A `value` MUST be DATA, never a JS function. `require`'s value channel crosses
 *  through `jsToScheme`, and the membrane VOIDS an inbound JS function to `#void`
 *  (BY DESIGN — a borrowed/returned JS callback is an untrackable interaction that
 *  provenance can't follow; see arrival's membrane materialization). So a resolver
 *  that returns `{ kind: "value", value: <jsFn> }` yields a `#void` binding and
 *  `(the-fn …)` throws "Not callable".
 *
 *  To expose a CALLABLE from a `require`d file, the resolver returns `kind: "eval"`
 *  whose forms evaluate to a SCHEME LAMBDA that composes directly-bound native verbs
 *  — the lambda is a real (trackable) scheme value, and the verbs live in the env
 *  (never crossing the membrane). The `.hbs` shape is the reference:
 *      `(lambda args (template/handlebars <src> args))`
 *  i.e. parse to scheme DATA, then return a scheme lambda over it (the verb doing the
 *  work — `template/handlebars` — is directly bound). `value` is for data files
 *  (`.json`/`.yaml`/…); callables are ALWAYS `eval` + scheme lambdas. */
export type ResolverResult =
  | { kind: "load"; forms: SchemeForm[] }
  | { kind: "eval"; forms: SchemeForm[] }
  | { kind: "value"; value: unknown };

export type ContentResolver = (contents: string | Uint8Array, ctx: { path: string }) => MaybePromise<ResolverResult>;

/** The EDITOR twin of a {@link ContentResolver}: given a `(require)`d file's raw
 *  source, synthesize the TS type the lens should give `(require "path")` —
 *  plain TS (`string`/`number`/`boolean`/`null`) + scheme carriers (`List<…>` /
 *  object literals). Same surface leaf signatures and schema harvest use after
 *  the branded-scalar abandonment (`types.d.ts`: membrane values ARE their JS
 *  types). Returns `null` when the handler has no static shape (lens →
 *  `unknown`). PURE — parses like `resolve`, never touches a run env.
 *  Co-located with `resolve` so one registration teaches runtime + editor. */
export type RequireTypeProvider = (source: string, ctx: { path: string }) => string | null;

/** An extension's handler: its runtime `resolve` and its optional editor `type`
 *  provider (the require analogue of a rosetta's `{ fn, type }`). */
export interface ExtensionHandler {
  resolve: ContentResolver;
  type?: RequireTypeProvider;
}

export interface Loader {
  /** Pure path math: specifier resolved against the importing module's dir →
   *  canonical root-relative key. Throws on escape above the root. */
  resolve(specifier: string, fromDir: string): MaybePromise<string>;
  /** The one IO call + the jail. Throws (located) if the key isn't in the root. */
  read(path: string): MaybePromise<string | Uint8Array>;
  /** extension → terminal handler (runtime resolve + editor type). Longest
   *  matching suffix wins. */
  resolvers: Map<string, ExtensionHandler>;
}

/** Single-function resolver (`path → source`). May be async — `Loader.read` awaits
 *  it — so a resolver can fetch a not-yet-loaded module on demand (e.g. over a fs). */
export type RequireResolver = (path: string) => MaybePromise<string>;

// ── path helpers (posix, no node:path dep — runs in browser + worker + node) ──

/** Normalize a posix path, dropping `.`/empty segments and applying `..`. Throws
 *  if `..` would escape above the root — the traversal jail. */
function normalizePath(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    RequirePathError.invariant(seg !== "\0" && !seg.includes("\0"), "nul-byte", p);
    if (seg === "..") {
      RequirePathError.invariant(out.length > 0, "escapes-root", p);
      out.pop();
    } else {
      out.push(seg);
    }
  }
  return out.join("/");
}

/** Resolve `specifier` against `fromDir`. A leading `/` is root-relative. */
function joinPath(fromDir: string, specifier: string): string {
  if (specifier.startsWith("/")) return normalizePath(specifier);
  return normalizePath(fromDir ? `${fromDir}/${specifier}` : specifier);
}

/** Exported for `require`'s own declaration (loader-capability.ts), which pushes it onto
 *  `dirStack` for relative-require resolution once a module's forms start evaluating. */
export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

// ── data parsers ──────────────────────────────────────────────────────────────
//
// Only the DEP-FREE formats parse here. `.json` accepts JSONC (// and /* */ comments +
// trailing commas — the tsconfig/VS Code dialect); strict JSON is a subset. Dep-bearing
// formats — `.yaml`/`.yml` (`yaml`), `.toml` (`smol-toml`) — live on this package's
// `./yaml` and `./toml` export paths, each owning its parser as an optional peer,
// so the loader barrel carries no external dep (per .claude/rules/env-quasi-packages.md
// — split to isolate an external dependency). Those capabilities register their resolver
// by NAME at bootstrap; `require`'s ext→name overlay resolves it. Known wart: that
// overlay is the RUNTIME face only — the editor type seam (`resolveRequireType`) reads
// this static table, so `.yaml`/`.toml` carry no lens type provider and hover as
// `unknown` (see `defaultResolvers`).
const DATA_PARSERS: Record<string, (text: string) => unknown> = {
  ".json": (text) => parseJsonc(text),
  ".ndjson": (text) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("//"))
      .map((line) => parseJsonc(line)),
};

/** Project a parsed value onto its JSON shape (Dates → ISO strings, drops undefined) so a required
 *  data file enters the program as plain JSON-shaped data. NOT a deep clone — `structuredClone`
 *  would preserve the very non-JSON types this is meant to drop. Exported so the dep-bearing ext
 *  capabilities (`ext/yaml`, `ext/toml`) project their parsed value through the SAME projection the
 *  builtin data resolvers use — one definition, no drift. */
// eslint-disable-next-line unicorn/prefer-structured-clone -- JSON projection, not a clone
export const normalizeToJson = (v: unknown): unknown => JSON.parse(JSON.stringify(v));

/** Decode loader contents to source text — the ONE coercion every
 *  {@link ContentResolver} must use, in place of `String(contents)`.
 *
 *  `read` is `string | Uint8Array`. Registered native verbs receive the boxed
 *  twins (`AString` / `ABytevector`) — same two payloads, already constructed.
 *
 *  `String()` on a `Uint8Array` joins byte VALUES with commas rather than
 *  decoding UTF-8: `String(new TextEncoder().encode(";;"))` is `"59,59"`, not
 *  `";;"`. Fed to `parse`, that garble reads as a number followed by a free `,`
 *  — `Unbound variable \`unquote'` at line 1 of a file whose bytes are valid
 *  scheme. Every resolver routes through here so no format can regress into
 *  that silent mistranslation.
 *
 *  Exported for the dep-bearing ext capabilities (`ext/yaml`, `ext/toml`,
 *  `arrival/handlebars`), which resolve contents outside this module — same
 *  one-definition-no-drift reason as {@link normalizeToJson}. */
export function contentsToText(contents: string | Uint8Array | AString | ABytevector): string {
  if (typeof contents === "string") return contents;
  if (contents instanceof Uint8Array) return new TextDecoder().decode(contents);
  if (contents instanceof AString) return contents.valueOf();
  return new TextDecoder().decode(contents.__bytevector__);
}

/** Shape a required DATA value into the program's world: arrays → scheme LISTS (Pair
 *  chains) at EVERY depth, plain objects → {@link ADict} (scheme values stored as-is),
 *  scalars boxed by `jsToScheme`.
 *
 *  The loader's OWN data contract, done explicitly — NOT delegated to `jsToScheme`, whose
 *  rosetta boundary makes a borrowed JS array a VECTOR (so `(append (require "x.json") …)`
 *  would throw "Expecting nil or pair got js-array") and a plain object an AJSObject whose
 *  source must stay pure-JS. Pre-shaping leaves into an AJSObject source mixed the worlds
 *  (nested AString/AExact in a "JS" object) so `toJS` identity-unwrapped a contaminated
 *  source. ADict is the native carrier for already-evaluated scheme entries — its
 *  `arrival/toJS` peels nested values correctly.
 *
 *  Arrays list-ify HERE, eagerly (a data file is finite and read once per run — the
 *  single-flight cache holds the shaped value). Exported for `require`'s declaration
 *  (loader-capability.ts), which shapes a `kind: "value"` result through this. */
export function dataToScheme(v: unknown): SchemeVal {
  if (Array.isArray(v)) {
    let tail: SchemeVal = nil;
    for (let i = v.length - 1; i >= 0; i--) tail = new APair(dataToScheme(v[i]), tail);
    return tail;
  }
  if (
    v !== null &&
    typeof v === "object" &&
    (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null)
  ) {
    const pairs: Array<readonly [ASymbol, SchemeValue]> = [];
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      pairs.push([new ASymbol(k), dataToScheme(val) as SchemeValue]);
    }
    return new ADict(pairs);
  }
  return jsToScheme(CONSTANT_CTX, v);
}

// ── value → lens TS type ──────────────────────────────────────────────────────
//
// Synthesize the TS type string the lens gives `(require "data.json")`. Mirrors
// the runtime wrap (`jsToScheme`): a JS array becomes a scheme LIST (`List<T>`), a
// plain object an accessible record (`{ "k": T; … }`), scalars their PLAIN JS
// types (`string`/`number`/`boolean`/`null`). Pure + recursive with depth/
// breadth guards so a pathological blob degrades to `unknown` instead of
// emitting a megabyte of types.
//
// Scalars are NOT `SStr`/`SNum`/`SBool` — those aliases still exist as a compat
// bridge in the prelude, but leaf signatures and schema harvest print natives
// (`types.d.ts` header). Emitting brands here reintroduced a second dialect for
// require shapes alone; wrong.

const TS_TYPE_MAX_DEPTH = 8;
const TS_TYPE_MAX_KEYS = 200;

function unionElementTypes(items: readonly unknown[], depth: number): string {
  const seen = new Set<string>();
  for (const item of items) {
    seen.add(valueToTsType(item, depth + 1));
    if (seen.size > 24) return "unknown"; // too many distinct shapes — give up cleanly
  }
  if (seen.size === 0) return "unknown";
  return [...seen].join(" | ");
}

export function valueToTsType(value: unknown, depth = 0): string {
  if (depth > TS_TYPE_MAX_DEPTH) return "unknown";
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      break;
  }
  if (Array.isArray(value)) {
    const elem = unionElementTypes(value, depth);
    return `List<${elem.includes(" | ") ? `(${elem})` : elem}>`;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > TS_TYPE_MAX_KEYS) return "unknown";
    if (entries.length === 0) return "{}";
    const fields = entries.map(([k, v]) => `${JSON.stringify(k)}: ${valueToTsType(v, depth + 1)}`);
    return `{ ${fields.join("; ")} }`;
  }
  return "unknown";
}

/** The default extension registry: the `.scm` BUILTIN + the DEP-FREE data formats.
 *
 *  `.scm` is the one true builtin (the evaluator + recursive `require` — an intrinsic, never a
 *  registered extension). The dep-free data formats (`.json`/`.ndjson`/`.txt`) stay here for TWO
 *  reasons: (1) a bare loader (CLI `--file` mode, an env rooting no ext capability) still resolves
 *  them at runtime; (2) — load-bearing — they carry the LENS TYPE PROVIDER (`type`), which the
 *  editor seam (`resolveRequireType`) reads off THIS static table. Their runtime face is also
 *  re-registered by the `ext/json` / `ext/ndjson` / `ext/txt` capabilities; when one is rooted,
 *  `require`'s by-name overlay uses the capability verb and this entry is the fallback — identical
 *  value (same `normalizeToJson`), no divergence.
 *
 *  Dep-bearing formats are NOT builtins: `.yaml`/`.yml` (`./yaml`), `.toml` (`./toml`), `.hbs`
 *  (`./handlebars`), `.prompt` (`ext/prompt`) each own their dep. That sheds the loader's external
 *  deps — at the cost that `.yaml`/`.toml` hover as `unknown` in the lens (the by-name registry has
 *  no type channel; see the data-parsers note above). `.hbs`/`.prompt` never had a type provider. */
export function defaultResolvers(): Map<string, ExtensionHandler> {
  // Data files share ONE parser per extension across both faces: `resolve`
  // parses + normalizes to the runtime value, `type` parses + synthesizes the
  // editor shape. Same `DATA_PARSERS[ext]` on both sides — the registration is
  // the single source, so the lens shape can never drift from the runtime value.
  const dataHandlers = Object.keys(DATA_PARSERS).map((ext): [string, ExtensionHandler] => [
    ext,
    {
      resolve: (contents) => ({
        kind: "value",
        value: normalizeToJson(DATA_PARSERS[ext]!(contentsToText(contents))),
      }),
      type: (source) => {
        try {
          return valueToTsType(normalizeToJson(DATA_PARSERS[ext]!(source)));
        } catch {
          return null; // unparseable mid-edit — no shape, lens falls back to unknown
        }
      },
    },
  ]);
  return new Map<string, ExtensionHandler>([
    // Pass the module path as `source` so a throw inside this file reads as
    // `path:line` in the scheme stack (L3).
    [
      ".scm",
      { resolve: async (contents, { path }) => ({ kind: "load", forms: await parse(contentsToText(contents), path) }) },
    ],
    ...dataHandlers,
    [".txt", { resolve: (contents) => ({ kind: "value", value: contentsToText(contents) }), type: () => "string" }],
    // No entry for the dep-bearing formats (`.hbs`/`.yaml`/`.toml`/`.prompt`): a bare loader
    // rooting none of their capabilities has no fallback here, so requiring one is a clean
    // no-resolver error — which IS the scoping guarantee (you must root the owning capability).
  ]);
}

/** Longest registered suffix that the basename ends with (extensions begin with
 *  `.`, so the match is dot-bounded). Terminal — one handler, no chaining. Exported for
 *  `require`'s own declaration (loader-capability.ts), which falls through to this when
 *  the by-name registry overlay has no binding for the path's resolver. */
export function pickHandler(path: string, resolvers: Map<string, ExtensionHandler>): ExtensionHandler | undefined {
  const base = path.slice(path.lastIndexOf("/") + 1);
  let best: { ext: string; handler: ExtensionHandler } | undefined;
  for (const [ext, handler] of resolvers) {
    if (base.length > ext.length && base.endsWith(ext) && (!best || ext.length > best.ext.length)) {
      best = { ext, handler };
    }
  }
  return best?.handler;
}

/** The editor seam: synthesize the TS type for `(require "path")` by routing the
 *  file's source through the SAME registry the runtime resolves with — so a
 *  custom extension registered with a `type` provider teaches the lens too. The
 *  studio calls this per data file and pushes the resulting `{ path → tsType }`
 *  to the lens. Returns `null` when no handler claims the path or its handler has
 *  no `type` provider (a `.scm` library, an opaque blob) — the lens then emits
 *  no `require` overload and the value stays `unknown`. */
export function resolveRequireType(loader: Loader, path: string, source: string): string | null {
  const handler = pickHandler(path, loader.resolvers);
  if (handler?.type === undefined) return null;
  try {
    return handler.type(source, { path });
  } catch {
    return null; // a throwing provider must never break the editor — degrade to unknown
  }
}

export function loaderFromResolver(resolver: RequireResolver): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => resolver(path),
    resolvers: defaultResolvers(),
  };
}

/** The minimal read surface {@link makeFsLoader} needs. node:fs's `fs.promises`
 *  and plexus-vfs's `createFsClient(vfs).promises` both satisfy it as-is (both
 *  expose `readFile(path)`); a browser FileSystem-Access-API directory handle
 *  adapts with a tiny shim. `read` returns bytes OR text — text formats decode
 *  through {@link contentsToText} (UTF-8, never `String()`), and the binary path
 *  stays `Uint8Array`, so a bytes-only `readFile` needs no encoding argument. */
export interface FsReadLike {
  readFile(path: string): MaybePromise<string | Uint8Array>;
}

/**
 * Build a {@link Loader} over any read-capable filesystem — the generic-fs seam
 * that lets a program's `(require …)` resolve against node:fs, plexus-vfs, the
 * browser FileSystem Access API, or any `{ readFile }` shape, with no Plexus and
 * no `Project` in sight.
 *
 * Paths are root-relative POSIX keys (the same jail `resolve` enforces). A
 * root-relative fs (plexus-vfs, an in-project vfs) takes `.promises` directly;
 * a whole-disk fs roots the key itself, e.g. node:fs:
 *   `makeFsLoader({ readFile: (p) => fs.promises.readFile(nodePath.join(root, p)) })`.
 */
export function makeFsLoader(fs: FsReadLike): Loader {
  return {
    resolve: (specifier, fromDir) => joinPath(fromDir, specifier),
    read: (path) => fs.readFile(path),
    resolvers: defaultResolvers(),
  };
}
