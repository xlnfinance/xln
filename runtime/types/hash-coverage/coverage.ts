/**
 * Compile-time exact field coverage for hash-reachable nested types.
 *
 * `satisfies readonly (keyof T)[]` proves every catalog entry exists on T.
 * Exported `AssertNever<FieldGap<T, Fields>>` aliases/tuples prove no T key is
 * missing. Instantiate those aliases at the definition site; a generic wrapper
 * around `AssertNever` does not force the `never` check.
 * Distributive `AllKeys` is required for unions: `keyof (A | B)` is only the
 * intersection and would hide variant-only payload keys.
 */
export type AssertNever<T extends never> = T;
export type Covered<T, _Coverage extends never> = T;
export type AllKeys<T> = T extends unknown ? keyof T : never;
export type FieldGap<T, Fields extends readonly PropertyKey[]> = Exclude<AllKeys<T>, Fields[number]>;
