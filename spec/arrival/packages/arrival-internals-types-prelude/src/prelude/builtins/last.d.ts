// ─────────────────────────────────────────────────────────────────────────────
// `last` — last element of a list.
//
// Scheme semantics: (last list) → the final element of a non-empty list.
//
// Untyped compose pipelines (`(compose :state last :versions)`) rely on the
// lens's call-site param inference (service-core inferParamInsertions) to
// annotate the lambda domain from callers — not on an `any` overload here.
// ─────────────────────────────────────────────────────────────────────────────

declare function last<T>(xs: List<T>): T;
