// Result: a step that can be refused returns the refusal as a value, tagged by the module that refuses.
//
// Every fold here stops at the first refusal and asks no later item.

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> =>
  (r.ok ? ok(f(r.value)) : r);
export const flatMap = <T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> =>
  (r.ok ? f(r.value) : r);
export const mapErr = <T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> =>
  (r.ok ? r : err(f(r.error)));
export const unwrapOr = <T, E>(r: Result<T, E>, f: (e: E) => T): T => (r.ok ? r.value : f(r.error));

/** Snapshots the iterable, then folds left to right; the first refusal is the answer and `f` sees no later item. */
export const foldResult = <S, X, E>(
  xs: Iterable<X>, init: S, f: (s: S, x: X, i: number) => Result<S, E>,
): Result<S, E> =>
  [...xs].reduce<Result<S, E>>((acc, x, i) => (acc.ok ? f(acc.value, x, i) : acc), ok(init));

/**
 * Folds left to right and collects one output per item.
 *
 * The one transient accumulator in the vocabulary (registered in style/README.md). Appending with `[...ys, y]`
 * copies every earlier output on every step, so a fold over n items costs n² (2.7 s at n = 40k). `collected` is
 * created by this call, only this call pushes to it, and it is handed out once, after the last push, as a
 * readonly array no caller shares.
 */
export const mapAccumResult = <S, X, Y, E>(
  xs: Iterable<X>, init: S, f: (s: S, x: X, i: number) => Result<readonly [S, Y], E>,
): Result<readonly [S, readonly Y[]], E> => {
  const collected: Y[] = [];
  const keep = ([next, y]: readonly [S, Y]): S => {
    collected.push(y);
    return next;
  };
  const stepOnce = (s: S, x: X, i: number): Result<S, E> => map(f(s, x, i), keep);
  return map(foldResult(xs, init, stepOnce), (last) => [last, collected] as const);
};

/** The same fold for a step that cannot be refused. */
export const mapAccum = <S, X, Y>(
  xs: Iterable<X>, init: S, f: (s: S, x: X, i: number) => readonly [S, Y],
): readonly [S, readonly Y[]] => {
  const folded = mapAccumResult(xs, init, (s, x, i) => ok(f(s, x, i)));
  return folded.ok ? folded.value : folded.error;
};

export const traverse = <X, Y, E>(
  xs: Iterable<X>, f: (x: X, i: number) => Result<Y, E>,
): Result<readonly Y[], E> => {
  const collect = (_: undefined, x: X, i: number) => map(f(x, i), (y) => [undefined, y] as const);
  return map(mapAccumResult(xs, undefined, collect), ([, ys]) => ys);
};

type Values<R> = { readonly [K in keyof R]: R[K] extends Result<infer V, unknown> ? V : never };
type Faults<R> = R[keyof R] extends Result<unknown, infer E> ? E : never;

/** The values of named results as one record, or the first refusal in key order; later results are already computed. */
export const all = <R extends Record<string, Result<unknown, unknown>>>(results: R): Result<Values<R>, Faults<R>> => {
  const named = ([key, r]: readonly [string, unknown]) =>
    map(r as Result<unknown, Faults<R>>, (value) => [key, value] as const);
  return map(traverse(Object.entries(results), named), Object.fromEntries) as Result<Values<R>, Faults<R>>;
};

/** `every` over a refusable predicate: the first `false` or the first refusal ends it. */
export const everyResult = <X, E>(xs: Iterable<X>, pass: (x: X) => Result<boolean, E>): Result<boolean, E> =>
  foldResult(xs, true, (all, x) => (all ? pass(x) : ok(false)));
