/**
 * CompiledResolutionChain — sealed ambient form of a baked capability base
 * (the immutable bake product: frozen Map, lookup/toString only). Distinct from
 * the mutable AmbientRuntime frame it seals from — Capabilities.globalRoot/refFrame
 * return this as the hygiene sentinel.
 *
 * Seal merges every layer's own bindings child-wins into one flat Map
 * (`env/vocabulary.ts` bake, `env/assemble-run.ts` run). `compileResolutionChain`
 * asserts no live resolver remains — the artifact cannot represent one.
 *
 * No write surface post-seal. REPL writes go on the session frame above the chain
 * (generator-exec defaultLexicalRoot). Glass `{ env }` keeps the live walk (no bake).
 *
 * `hash` = sorted vocabulary names (provenance baked-env slot). deferred: binding-value
 * hashing for cross-deploy reuse (same shape currently shares a hash).
 */
import invariant from "tiny-invariant";
import { type AmbientRuntime, type AmbientValue, ResolvingAmbient } from "../env/AmbientRuntime.js";
import type { RunContext } from "../run/RunContext.js";

export class CompiledResolutionChain {
  /** Merged frozen map every lookup reads. Single-element `steps` for callers that
   *  introspect chain shape. */
  readonly steps: readonly [ReadonlyMap<string | symbol, AmbientValue>];
  /** Content address (see the module header — vocabulary-shape identity, value hashing deferred). */
  readonly hash: string;
  /** The merged vocabulary (MCP discovery / allBoundNames). */
  readonly names: ReadonlySet<string | symbol>;

  private readonly flat: ReadonlyMap<string | symbol, AmbientValue>;

  constructor(flat: ReadonlyMap<string | symbol, AmbientValue>) {
    this.flat = flat;
    this.steps = [flat];
    this.names = new Set(flat.keys());
    this.hash = hashFlatMap(flat);
  }

  /** The composed base lookup — `undefined` on a miss. `ctx` is accepted for call-site
   *  symmetry with the live resolver walk (`AmbientRuntime._lookupWithResolvers`) but
   *  unused here: a flat map has no run-dependent middleware to thread it through. */
  lookup(name: string | symbol, _ctx?: RunContext): AmbientValue | undefined {
    return this.flat.get(name);
  }

  toString(): string {
    return `#<compiled-resolution-chain:${this.hash}:1 step(s)>`;
  }
}

function canonicalName(key: string | symbol): string {
  return typeof key === "string" ? key : `#sym:${String(key.description ?? "")}`;
}

/** Locale-independent, code-unit-wise comparator — the content address must be
 *  byte-stable across realms and locales (localeCompare is neither). */
function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** FNV-1a over the canonical, sorted vocabulary — deterministic, realm-independent. */
function hashFlatMap(flat: ReadonlyMap<string | symbol, AmbientValue>): string {
  const canonical = ["crc-v0", [...flat.keys()].map(canonicalName).toSorted(byCodeUnit).join(",")].join("|");
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compile a sealed env chain into its ambient artifact. Walks `base → … → root`
 * child-first, merging every layer's OWN bindings into ONE flat map (a closer layer's
 * entry overwrites — child-wins union, matching the live walk's own-bindings
 * precedence). Asserts, per layer, that no live resolver remains registered — the
 * artifact this module produces cannot represent one.
 */
export function compileResolutionChain(base: AmbientRuntime): CompiledResolutionChain {
  const layers: AmbientRuntime[] = [];
  for (let layer: AmbientRuntime | null = base; layer !== null; layer = layer.__parent__) layers.push(layer);

  const merged = new Map<string | symbol, AmbientValue>();
  // Deepest layer first so a CLOSER layer's entry overwrites — child-wins union.
  for (let i = layers.length - 1; i >= 0; i--) {
    const layer = layers[i];
    if (layer instanceof ResolvingAmbient) {
      invariant(
        layer.resolverSpecs().length === 0,
        `compileResolutionChain: layer "${String(layer.__name__)}" still has ${layer.resolverSpecs().length} ` +
          `live resolver(s) registered at seal time — the sealed chain has no resolver-interleaving ` +
          `representation; the kernel bake-overlay must unregister before assembly resolves.`,
      );
    }
    const record = layer.__env__;
    for (const key of Object.keys(record)) merged.set(key, record[key]);
    for (const sym of Object.getOwnPropertySymbols(record)) merged.set(sym, record[sym]);
  }

  return new CompiledResolutionChain(merged);
}

// ── The seal registry ────────────────────────────────────────────────────────────────
//
// ONE chain per baked base (realm-shared memo, GC'd with the env). The vocabulary-path
// assembly call sites call this at bake end — the explicit SEAL — so an assembled base
// reaching the exec seam by any route resolves through the same artifact.
const sealedChains = new WeakMap<AmbientRuntime, CompiledResolutionChain>();

export function sealResolutionChain(base: AmbientRuntime): CompiledResolutionChain {
  let chain = sealedChains.get(base);
  if (chain === undefined) {
    chain = compileResolutionChain(base);
    sealedChains.set(base, chain);
  }
  return chain;
}
