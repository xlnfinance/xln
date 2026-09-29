// Shared env-layer helpers for capability packs.
//
// Pack isolation (docs/environments.md §CAPABILITY: a capability reaches another only
// through a declared `deps` edge, never sideways into its internals) forbids a PACK
// importing another PACK — it does NOT forbid packs sharing a non-pack env-layer
// module, exactly as they all share `common/capability.ts` and
// `values/op-helpers.ts`. This module is that shared door: a helper several packs
// need (e.g. `to_array`, used by r7rs/lists, r7rs/strings, srfi/srfi-13) lives here
// ONCE — the fix for a cross-pack need is this module, not per-pack duplication.

import invariant from "tiny-invariant";
import { APair, isCircularList } from "../values/primitives/APair.js";
import { ANil } from "../values/primitives/ANil.js";
import type { SchemeValue } from "../values/types.js";

/** Reject circular/improper lists (the iterator folds tails). */
export function to_array(name: string): (list: SchemeValue) => SchemeValue[] {
  return function (list: SchemeValue): SchemeValue[] {
    if (list instanceof ANil) {
      return [];
    }
    // Wide `SchemeValue` param: isCircularList only accepts a Pair, so narrow here;
    // a non-Pair non-Nil reaches the loop's own improper-list invariant below.
    invariant(!(list instanceof APair && isCircularList(list)), `${name}: can't convert a circular list`);
    const result: SchemeValue[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        result.push(node.car);
        node = node.cdr;
      } else {
        invariant(node instanceof ANil, `${name}: can't convert improper list`);
        break;
      }
    }
    return result;
  };
}
