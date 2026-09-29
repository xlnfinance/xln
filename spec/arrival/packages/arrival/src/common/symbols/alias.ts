// symbol.alias — duplicate binding of an existing symbol under a new name.
// docs/environments.md §SYMBOL-KINDS. Resolved at capability bind time (same locus as
// DoorCause stamping): factory runs inside a symbols literal before EnvCapability exists.
// Bind loop substitutes the target's baked def and binds a second time under the alias name —
// byte-equivalent runtime, no wrapper. Target absent from same capability ⇒ assembly error.
// Uncatalogued: kind "alias" is not an AEntity member; catalog walks skip it.

/** Marker symbol.alias produces — resolved (never bound) by capability.ts apply loop. */
export interface AliasSymbolDef {
  readonly kind: "alias";
  /** Existing sibling key in the same capability's symbols record. */
  readonly target: string;
}

/** Template head is the whole target name (no name:doc split — inherits target's doc). */
export function alias(tpl: TemplateStringsArray, ...sub: (string | number)[]): AliasSymbolDef {
  let target = "";

  for (let i = 0; i < tpl.length; i++) {
    target += tpl[i];
    if (i < sub.length) target += String(sub[i]);
  }
  return { kind: "alias", target: target.trim() };
}
