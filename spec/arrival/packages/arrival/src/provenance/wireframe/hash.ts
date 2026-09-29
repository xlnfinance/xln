/**
 * Wireframe hashes — two named digests:
 *
 *   - `templateHash` / `hashGraph` — spans STRIPPED. Content over a whole graph
 *     (nodes structural, wires' source/params/paramRefs/consumer/`fact`, egress).
 *     Per-GRAPH (main, define template, fan interior), not per-node. `wire.fact`
 *     is content: differently tagged twins must not collide.
 *   - `siteHash` — templateHash + instantiation span (plane identity). Same
 *     template at two map sites → one templateHash, two siteHashes.
 *
 * RecordId uniqueness is NOT this hash's job — `rootOrdinalPath` / OrdinalPath
 * keep multi-site content collisions free without leaking position into content.
 *
 * α-RULING: NOT α-invariant. Bound-variable spelling is in source/params; hashing
 * more distinctions is safer than De Bruijn (wrong α could unify free-name semantics).
 * Same source twice → same hash; α-renamed → different (pinned by tests).
 */
import type { OrdinalPath, SiteHash, TemplateHash } from "../store/ids.js";
import type { Wire, WireframeGraph, WireframeNode, WireParam } from "./types.js";

/** FNV-1a content-hash idiom (local; not imported from chain hashing). */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function canonicalParamRef(ref: WireParam): string {
  return ref.kind === "slot" ? `slot:${ref.name}` : `node:${ref.name}:${ref.node}`;
}

/** Span excluded; fact tag included (content). */
function canonicalWire(wire: Wire): string {
  const refs = wire.paramRefs.map(canonicalParamRef).join(",");
  return [
    `src:${wire.source}`,
    `params:${wire.params.join(",")}`,
    `refs:${refs}`,
    `into:${wire.consumer.node}:${wire.consumer.slot}`,
    `fact:${wire.fact ? wire.fact.verb : ""}`,
  ].join("/");
}

/** Every field except span; fan/binder interiors recurse via hashGraph. */
function canonicalNode(node: WireframeNode): string {
  switch (node.kind) {
    case "source":
    case "sink":
    case "transparent":
    case "opaque":
      return `${node.kind}:${node.op}`;
    case "mux":
      return `mux:${node.op}:${node.arms}`;
    case "fan":
      return [
        "fan",
        node.op,
        `len:${node.lengthPreserving}`,
        `elParams:${node.elementParams ? node.elementParams.join(",") : ""}`,
        `fnOp:${node.fnOp ?? ""}`,
        `roles:${node.callbackRoles ? JSON.stringify(node.callbackRoles) : ""}`,
        `template:${node.template ? hashGraph(node.template) : ""}`,
      ].join("/");
    case "binder":
      return [
        "binder",
        node.op,
        `cycles:${node.cycles}`,
        `params:${node.params.join(",")}`,
        `interior:${hashGraph(node.interior)}`,
      ].join("/");
    case "recur":
      return "recur";
    case "template-ref":
      return `template-ref:${node.name}`;
    case "port":
      return `port:${node.direction}`;
  }
}

export function hashGraph(graph: WireframeGraph): TemplateHash {
  const nodesCanon = graph.nodes.map(canonicalNode).join("|");
  const wiresCanon = graph.wires.map(canonicalWire).join("|");
  const canonical = `nodes:${nodesCanon}##wires:${wiresCanon}##egress:${graph.egress ?? "none"}`;
  return fnv1a("template-v0", canonical);
}

export function siteHash(templateHash: TemplateHash, site: string): SiteHash {
  return fnv1a("site-v0", `${templateHash}::${site}`);
}

/** Sentinel site for program.main (single static instantiation). */
export const MAIN_PROGRAM_SITE = "@main";

/**
 * Root ordinal = index in graph.nodes (deterministic builder order).
 * Separates content-addressed templateHash collisions across sites.
 */
export function rootOrdinalPath(nodeIndex: number): OrdinalPath {
  return [nodeIndex];
}

export function siteOf(node: WireframeNode): string {
  return node.span;
}
