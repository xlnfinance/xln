// BASE_ROSTER — full base capability set for self-hosting vocabulary.
// The surface `buildVocabulary` folds into every run's own tuple instead of
// resolving by parenting on a pre-baked realm singleton.
//
// CORNERSTONE (docs/environments.md §HERMETIC): ambient and global/lexical scope are
// separate species. Vocabulary is ambient — frozen, pre-existing, unforgeable — and
// SELF-HOSTING: a run's vocabulary is
//   buildVocabulary([...capabilities, ...BASE_ROSTER], config)
// never a child frame parented on a pre-baked realm. Every base symbol becomes an
// ordinary member of the tuple's C3 closure.
//
// WHY NOT passing every JS-native pack as a co-root with BASE_PACKS: most JS-native
// packs (chars/strings/equality/numeric/vectors) are already deps-reachable from
// BASE_PACKS (polyglot-racket/clojure, srfi-1/43/128/235, polyglot). Those deps lists
// agree on one partial order: equality before numeric before {strings/vectors/chars/…}.
// Extra co-roots re-assert array order (vectors BEFORE equality BEFORE numeric) —
// which contradicts the deps-driven order. C3 treats co-root order as a real merge
// constraint (`common/dag-linearize.ts`), so the conflict throws
// `AssembleLinearizationError` on every vocabulary build.
//
// FIX: only add JS-native packs NOT deps-reachable from BASE_PACKS — `bytevectors`
// and `errorObjects` (nothing's deps name them; they have zero deps). Chars/strings/
// equality/numeric/vectors still land transitively in the closure.
//
// ORDER: BASE_PACKS first, then the two standalone extras.
//
// CALLER MERGE ORDER is not this module's concern: `execStateViaVocabulary` builds
// `[...capabilities, ...BASE_ROSTER]` (user first, roster last) so independent roots
// keep root-list order as C3 tie-break and BASE_ROSTER lands at lower precedence
// (processed first in deps-first apply — bindings present before user define-bake)
// while user caps keep higher precedence (self overwrites dep).

import type { EnvCapability } from "../common/capability.js";
import { BASE_PACKS } from "./base-packs.js";
import bytevectors from "./r7rs/bytevectors.js";
import errorObjects from "./r7rs/error-objects.js";

export const BASE_ROSTER: readonly EnvCapability[] = [...BASE_PACKS, bytevectors, errorObjects];
