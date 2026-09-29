/**
 * Host harvest — contracted callables PRE does not already declare.
 *
 * Skip is by name (`skipNames` = PRE `declare function` leaves), not pack
 * prefix (`scheme/*`). Defines stay schemePrelude bodies. Signature: authored
 * `type:` else `signatureOf`, Promise stripped (lens is sync).
 */
import type { EnvCapability, SymbolDeclaration } from "../common/capability.js";
import { contractOf } from "../common/capability-internals.js";
import { signatureOf } from "./schema-to-ts.js";

export interface HarvestedPlaneHost {
  readonly entries: readonly (readonly [name: string, type: string])[];
  readonly kwargsMembers: readonly string[];
}

function isKwargsInputRest(rest: unknown): boolean {
  if (rest === null || rest === undefined || typeof rest !== "object" || Array.isArray(rest)) {
    return false;
  }
  if (typeof (rest as { parse?: unknown }).parse === "function") return false;
  return true;
}

const SKIP_KINDS = new Set(["alias", "define-syntax", "macro", "keyword", "define", "value", "door"]);

/** Await is materialization; the scheme program is sync. */
function stripLensPromise(sig: string): string {
  const s = sig.trim();
  const m = /^(.*=> )Promise<(.+)>\s*$/s.exec(s);
  return m ? `${m[1]}${m[2]}` : s;
}

function defKind(def: SymbolDeclaration): string {
  if (def !== null && typeof def === "object" && "kind" in def) {
    return String((def as { kind: unknown }).kind);
  }
  return "";
}

/**
 * Walk `caps` deps-first. `skipNames` is PRE leaves — never overlay those.
 */
export function harvestPlaneHost(caps: readonly EnvCapability[], skipNames: ReadonlySet<string>): HarvestedPlaneHost {
  const seen = new Set<EnvCapability>();
  const byName = new Map<string, string>();
  const kwargs = new Set<string>();

  const walk = (cap: EnvCapability): void => {
    if (seen.has(cap)) return;
    seen.add(cap);
    for (const dep of cap.spec.deps ?? []) walk(dep);

    const symbols = cap.spec.symbols;
    if (symbols === undefined || typeof symbols === "function") return;

    for (const [name, def] of Object.entries(symbols as Record<string, SymbolDeclaration>)) {
      if (skipNames.has(name) || byName.has(name)) continue;
      if (SKIP_KINDS.has(defKind(def))) continue;

      const entity = contractOf(def);
      if (entity === undefined) continue;
      if (SKIP_KINDS.has(entity.kind)) continue;

      const authored =
        "type" in entity && typeof entity.type === "string" && entity.type.trim().length > 0
          ? entity.type.trim()
          : null;
      const sig = stripLensPromise(authored ?? signatureOf(entity));
      if (sig === "never" || sig === "unknown" || sig === "") continue;

      const rest = "inputRest" in entity ? entity.inputRest : undefined;
      if (isKwargsInputRest(rest)) kwargs.add(name);
      byName.set(name, sig);
    }
  };

  for (const cap of caps) walk(cap);
  if (!byName.has("require") && !skipNames.has("require")) {
    byName.set("require", "(specifier: string): any");
  }
  return { entries: [...byName.entries()], kwargsMembers: [...kwargs].sort() };
}
