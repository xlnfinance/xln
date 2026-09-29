/**
 * LEDGER — staged spec: count-cone minimality vs. provenance-everything (R5).
 *
 * R5 is RULED: both cone queries are required ("why is this an input" / "what
 * changes if I adjust this output"). These `it.todo` stubs mark an implementation
 * gate (the wireframe), not a design gate.
 *
 *   - DROP: `(length (map f xs))` still forces `f` today (`map` is strict). The
 *     wireframe's static-wire collapse lets `length` read cardinality without
 *     forcing `f`.
 *   - ATTRIBUTION: a count's cone stays teleological (union of element ids) until
 *     the wireframe makes it structurally minimal without sacrificing conservation
 *     (P10).
 */
import { it } from "vitest";

it.todo(
  "PROBE — DROP: (length (map f xs)) elides f entirely once the wireframe collapses the static map→length wire (gate: C3 execution-plan wireframe)",
);

it.todo(
  "PROBE — ATTRIBUTION: a count's provenance cone is minimal (cardinality-only), not entangled with element identity, once the wireframe lands (gate: C3 execution-plan wireframe)",
);
