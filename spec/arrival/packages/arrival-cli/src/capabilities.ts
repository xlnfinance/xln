/**
 * HOST-SIDE CAPABILITY ARMING: capabilities are armed by the HOST only — CLI args +
 * config file; `(require …)` stays the module loader and NEVER arms authority — the
 * doors teach absence.
 *
 * Two channels, one product ({@link ArmedCapabilities}):
 *
 *   • `--with <specifier>` (repeatable) — a module id (npm package, package subpath,
 *     or relative path) whose resolved module exports {@link EnvCapability}
 *     instance(s). Every capability-shaped export is collected; a module exporting
 *     none is a teaching error naming what WAS found.
 *   • `arrival.config.ts` / `arrival.config.json` (cwd-resolved, `--config` override)
 *     — `{ capabilities: [{ module, config? }…], config? }`. Per-capability `config`
 *     slices merge into the ONE shared bag (the `ExecOptions.config` posture: each
 *     capability validates its own slice via its zod schemas; unrelated capabilities
 *     ride one bag without knowing about each other).
 *
 * IDENTITY: `instanceof EnvCapability` is the primary check — pnpm workspaces dedupe
 * `@inhuman.tools/arrival`, so a loaded module and this CLI share one class object. The
 * duck fallback (constructor name + the {name, spec, lower} shape) covers the
 * duplicated-install case (two arrival copies in one graph) honestly instead of
 * rejecting a real capability over class identity.
 *
 * TS CONFIG: loaded via plain dynamic `import()` — the built CLI runs under node, and
 * node ≥ 23.6 type-strips `.ts` natively. Older node throws ERR_UNKNOWN_FILE_EXTENSION;
 * we re-throw as a teaching error pointing at `arrival.config.json` (v1's guaranteed
 * format) rather than carrying a transpiler dependency.
 */
import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { EnvCapability } from "@inhuman.tools/arrival/capability";

/** The host-armed set every verb threads: the capability instances + the ONE shared
 *  config bag their `lower()` calls all receive. */
export interface ArmedCapabilities {
  readonly capabilities: readonly EnvCapability[];
  readonly config: Record<string, unknown>;
}

/** Primary: `instanceof` (pnpm-deduped workspace ⇒ one class object). Fallback: the
 *  duplicated-install duck — constructor NAME + the instance shape (`name` string,
 *  `spec` object, `lower` fn). The predicate is the one narrowing seam; no cast
 *  survives past it. */
export function isEnvCapability(v: unknown): v is EnvCapability {
  if (v instanceof EnvCapability) return true;
  if (typeof v !== "object" || v === null) return false;
  const duck = v as { constructor?: { name?: string }; name?: unknown; spec?: unknown; lower?: unknown };
  return (
    duck.constructor?.name === "EnvCapability" &&
    typeof duck.name === "string" &&
    typeof duck.spec === "object" &&
    duck.spec !== null &&
    typeof duck.lower === "function"
  );
}

/** One-word type tag for the teaching error's "what WAS found" listing. */
function describeExport(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "object") {
    const ctor = (v as { constructor?: { name?: string } }).constructor?.name;
    return ctor !== undefined && ctor !== "Object" ? `object (${ctor})` : "object";
  }
  return typeof v;
}

/** A specifier is a PATH iff it says so (`./`, `../`, absolute) — everything else is a
 *  bare npm id resolved from `baseDir` (the user's project), falling back to the CLI's
 *  own module graph (workspace siblings) when the project-local resolution misses. */
async function importModule(specifier: string, baseDir: string): Promise<Record<string, unknown>> {
  const load = async (url: string): Promise<Record<string, unknown>> => {
    try {
      return (await import(url)) as Record<string, unknown>;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ERR_UNKNOWN_FILE_EXTENSION" &&
        url.endsWith(".ts")
      ) {
        throw new Error(
          `arrival: ${specifier} is TypeScript, and this node (${process.version}) cannot type-strip it. ` +
            `Use node ≥ 23.6, or a .js/.mjs/.json form of the module.`,
        );
      }
      throw new Error(`arrival: cannot load ${specifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (specifier.startsWith("./") || specifier.startsWith("../") || path.isAbsolute(specifier)) {
    return load(pathToFileURL(path.resolve(baseDir, specifier)).href);
  }
  // Bare specifier: resolve from the user's project first (their node_modules), so a
  // project-local capability package wins over anything visible from the CLI install.
  try {
    const projectRequire = createRequire(path.join(baseDir, "package.json"));
    return await load(pathToFileURL(projectRequire.resolve(specifier)).href);
  } catch {
    return load(specifier); // the CLI's own graph — workspace/global installs
  }
}

/** `--with` semantics: import the module, collect EVERY capability-shaped export
 *  (default included). Zero capabilities ⇒ the teaching error — what was found, what
 *  was expected. */
export async function loadCapabilityModule(specifier: string, baseDir: string): Promise<EnvCapability[]> {
  const mod = await importModule(specifier, baseDir);
  const found: EnvCapability[] = [];
  const rejected: string[] = [];
  for (const [name, value] of Object.entries(mod)) {
    if (isEnvCapability(value)) found.push(value);
    else rejected.push(`${name} (${describeExport(value)})`);
  }
  if (found.length === 0) {
    const seen = rejected.length === 0 ? "no exports at all" : `exports: ${rejected.join(", ")}`;
    throw new Error(
      `arrival: ${specifier} is not a capability module — it has ${seen}.\n` +
        `Expected one or more EnvCapability exports, e.g.\n` +
        `  import { EnvCapability } from "@inhuman.tools/arrival/capability";\n` +
        `  export default EnvCapability.define("my/capability", { symbols: (symbol, z) => ({ … }) });`,
    );
  }
  return found;
}

/** The config file's declared shape — validated field by field with teaching errors
 *  (no schema dependency: the CLI's own surface stays two-deps lean). */
interface ArrivalConfigFile {
  readonly capabilities?: readonly { readonly module: string; readonly config?: Record<string, unknown> }[];
  readonly config?: Record<string, unknown>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseConfigShape(raw: unknown, file: string): ArrivalConfigFile {
  const teach = (what: string): never => {
    throw new Error(
      `arrival: ${file} is not a valid config — ${what}.\n` +
        `Expected: { "capabilities": [{ "module": "<specifier>", "config": { … } }], "config": { … } }`,
    );
  };
  if (!isRecord(raw)) return teach(`the top level is ${describeExport(raw)}, not an object`);
  if (raw.capabilities !== undefined) {
    if (!Array.isArray(raw.capabilities))
      return teach(`"capabilities" is ${describeExport(raw.capabilities)}, not an array`);
    for (const [i, entry] of raw.capabilities.entries()) {
      if (!isRecord(entry)) return teach(`capabilities[${i}] is ${describeExport(entry)}, not an object`);
      if (typeof entry.module !== "string")
        return teach(`capabilities[${i}].module is ${describeExport(entry.module)}, not a module specifier string`);
      if (entry.config !== undefined && !isRecord(entry.config))
        return teach(`capabilities[${i}].config is ${describeExport(entry.config)}, not an object`);
    }
  }
  if (raw.config !== undefined && !isRecord(raw.config))
    return teach(`"config" is ${describeExport(raw.config)}, not an object`);
  return raw as ArrivalConfigFile;
}

const CONFIG_BASENAMES = ["arrival.config.ts", "arrival.config.json"];

async function exists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

/** Read the raw config value: `.json` via readFile+parse; `.ts`/`.js`/`.mjs` via
 *  dynamic import of its DEFAULT export (the config IS a value, not a module of
 *  capabilities — those are named by `module` specifiers inside it). */
async function readConfigValue(file: string): Promise<unknown> {
  if (file.endsWith(".json")) {
    const text = await readFile(file, "utf8");
    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new Error(`arrival: ${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const mod = await importModule(file, path.dirname(file));
  if (!("default" in mod)) {
    throw new Error(`arrival: ${file} must default-export the config object (export default { capabilities: […] })`);
  }
  return mod.default;
}

/**
 * Locate + load the config file: `--config` override wins (missing ⇒ teaching error —
 * an EXPLICIT path is intent); otherwise the first of `arrival.config.ts`,
 * `arrival.config.json` in `cwd` (absent ⇒ `undefined`, the unarmed default). Module
 * specifiers inside the file resolve relative to the FILE's dir, so a `--config
 * path/to/arrival.config.json` keeps its relative `./caps/*.mjs` entries meaningful.
 */
export async function loadConfigFile(cwd: string, override?: string): Promise<ArmedCapabilities | undefined> {
  let file: string | undefined;
  if (override === undefined) {
    for (const base of CONFIG_BASENAMES) {
      const candidate = path.join(cwd, base);
      if (await exists(candidate)) {
        file = candidate;
        break;
      }
    }
  } else {
    file = path.resolve(cwd, override);
    if (!(await exists(file))) throw new Error(`arrival: cannot read config ${override}: no such file`);
  }
  if (file === undefined) return undefined;

  const parsed = parseConfigShape(await readConfigValue(file), file);
  const baseDir = path.dirname(file);
  const capabilities: EnvCapability[] = [];
  // ONE shared bag: the file-level `config` first, then each entry's slice (later
  // entries win key-wise — the bag is shared, each capability validates its own slice).
  const config: Record<string, unknown> = { ...parsed.config };
  for (const entry of parsed.capabilities ?? []) {
    capabilities.push(...(await loadCapabilityModule(entry.module, baseDir)));
    Object.assign(config, entry.config);
  }
  return { capabilities, config };
}

/**
 * The one arming entry the CLI verbs call: config file (if any) + every `--with`
 * module, identity-deduped (listing the same singleton twice arms it once).
 * `undefined` when NOTHING is armed — the verbs then keep their byte-identical
 * pre-capability paths (realm-default ambient, no per-run assembly).
 */
export async function armCapabilities(
  withSpecifiers: readonly string[],
  configOverride: string | undefined,
  cwd: string,
): Promise<ArmedCapabilities | undefined> {
  const fromFile = await loadConfigFile(cwd, configOverride);
  const capabilities: EnvCapability[] = [...(fromFile?.capabilities ?? [])];
  for (const spec of withSpecifiers) {
    for (const cap of await loadCapabilityModule(spec, cwd)) {
      if (!capabilities.includes(cap)) capabilities.push(cap);
    }
  }
  if (capabilities.length === 0 && fromFile === undefined) return undefined;
  return { capabilities, config: fromFile?.config ?? {} };
}
