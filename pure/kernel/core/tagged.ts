// Tagged unions and brands: the vocabulary every other module states its models in.
//
// A union member is an object with a `_tag`; `match` takes one arm per tag, so a new member is a compile error in
// every match that has not handled it. A brand is a value the type system will not accept from a bare string or number.

declare const __brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [__brand]: { readonly [K in B]: B } };
export type Flat<T> = { readonly [K in keyof T]: T[K] } & {};
export type Tagged<Tag extends string, Extra extends object = {}> =
  Tag extends unknown ? Flat<{ readonly _tag: Tag } & Extra> : never;
export type Of<T extends { readonly _tag: string }, K extends T["_tag"]> =
  Extract<T, { readonly _tag: K }>;

/** The closing arm of a `switch` over a union: it only type checks when every member has a case above it. */
const assertNever = (x: never): never => {
  throw new Error(`unreachable: ${String(x)}`);
};

const arm = <A extends object, K extends keyof A>(arms: A, k: K): A[K] =>
  (Object.hasOwn(arms, k) ? arms[k] : assertNever(k as never));

export const match = <T extends { readonly _tag: string }, R>(
  value: T, arms: { [K in T["_tag"]]: (v: Of<T, K>) => R },
): R => arm(arms, value._tag as T["_tag"])(value as never);
