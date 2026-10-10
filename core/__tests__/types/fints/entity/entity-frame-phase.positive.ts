import type { EntityFrame } from '../../../../entity/types';
import type {
  CertifiedEntityFrame,
  LockedEntityFrame,
} from '../../../../entity/consensus/frame/phase-views';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type LockedRequiresSignatures = Expect<Equal<LockedEntityFrame['collectedSigs'], Map<string, string[]>>>;
type CertifiedRequiresHankos = Expect<Equal<CertifiedEntityFrame['hankos'], [string]>>;

export const consumeEntityFramePhases = (
  locked: LockedEntityFrame,
  certified: CertifiedEntityFrame,
): [EntityFrame, EntityFrame, LockedRequiresSignatures, CertifiedRequiresHankos] =>
  [locked, certified, true, true];
