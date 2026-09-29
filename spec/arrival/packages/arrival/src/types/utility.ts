// types/utility.ts — type-only TypeScript plumbing. Zero imports, no domain types.
//
// These aliases are consumed from values, membrane, bake, and env. Parking
// them in any of those layers mints a fake edge — `AJSArray` importing `MaybePromise`
// from loader would put membrane above the knot. `utils/` is the runtime twin
// (`maybeThen`); this file is the type twin. Not `_bake`: bake sits inside the knot,
// and values importing a 1-line alias from it thickens the knot for no reason.
//
// Importable from anywhere, including knot members — a leaf by construction.

/** Sync-or-async. Bake awaits; a type that forces `Promise<T>` would tax every sync impl. */
export type MaybePromise<T> = T | Promise<T>;

/** `any` detector (`0 extends (1 & T)`). Without this, `any[]` collapses to `never`. */
export type IsAny<T> = 0 extends 1 & T ? true : false;
