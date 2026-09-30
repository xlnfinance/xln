// A value that may be absent, named as a union so a caller can never read "nothing" as a value.
//
// Use it where absence is a normal answer (no such signer, no such count). Where absence is a refusal the caller must
// explain, return a Result with a tagged fault instead.
import { match, type Tagged } from "./tagged.ts";

export type Option<T> = Tagged<"some", { value: T }> | Tagged<"none">;

export const some = <T>(value: T): Option<T> => ({ _tag: "some", value });
export const none: Option<never> = { _tag: "none" };

/** The value when there is one, the fallback when there is not. */
export const orElse = <T, F>(option: Option<T>, fallback: F): T | F =>
  match(option, { some: ({ value }) => value, none: () => fallback });
