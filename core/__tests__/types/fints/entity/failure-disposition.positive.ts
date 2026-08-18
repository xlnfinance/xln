import type { FailureDisposition } from '../../../../protocol/errors/failure-taxonomy';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type ExactFailureDisposition = Expect<Equal<
  FailureDisposition,
  'reject' | 'retry' | 'dispute' | 'halt_runtime'
>>;

export const allFailureDispositions: [
  FailureDisposition,
  FailureDisposition,
  FailureDisposition,
  FailureDisposition,
  ExactFailureDisposition,
] = ['reject', 'retry', 'dispute', 'halt_runtime', true];
