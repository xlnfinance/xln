import { err, ok, type Result } from "../../../kernel/core/result.ts";

export const reasonOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/** What `work` resolves to, or the fault `fault` makes of the reason it was rejected for. */
export const attempt = <T, E>(work: Promise<T>, fault: (reason: string) => E): Promise<Result<T, E>> =>
  work.then((value): Result<T, E> => ok(value), (cause): Result<T, E> => err(fault(reasonOf(cause))));
