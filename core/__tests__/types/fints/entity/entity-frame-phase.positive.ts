import type { EntityFrame } from '../../../../entity/types';
import type {
  CertifiedEntityFrame,
  DraftEntityFrame,
  LockedEntityFrame,
} from '../../../../entity/consensus/frame/phase-views';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;
type Expect<T extends true> = T;

type DraftHasNoSignatures = Expect<Equal<DraftEntityFrame['collectedSigs'], undefined>>;
type DraftHasNoHankos = Expect<Equal<DraftEntityFrame['hankos'], undefined>>;
type LockedRequiresSignatures = Expect<Equal<LockedEntityFrame['collectedSigs'], Map<string, string[]>>>;
type CertifiedRequiresHankos = Expect<Equal<CertifiedEntityFrame['hankos'], [string]>>;

export const consumeEntityFramePhases = (
  draft: DraftEntityFrame,
  locked: LockedEntityFrame,
  certified: CertifiedEntityFrame,
): [EntityFrame, EntityFrame, EntityFrame, DraftHasNoSignatures, DraftHasNoHankos, LockedRequiresSignatures, CertifiedRequiresHankos] =>
  [draft, locked, certified, true, true, true, true];
