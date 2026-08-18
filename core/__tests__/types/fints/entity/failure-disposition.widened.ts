import type { FailureDisposition } from '../../../../protocol/errors/failure-taxonomy';

type WidenedFailureDisposition = FailureDisposition | 'ignored';

export const illegalFailureDisposition: WidenedFailureDisposition = 'ignored';
