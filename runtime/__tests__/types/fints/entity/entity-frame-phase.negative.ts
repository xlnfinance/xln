import type { EntityFrame } from '../../../../entity/types';
import type {
  CertifiedEntityFrame,
  DraftEntityFrame,
  LockedEntityFrame,
} from '../../../../entity/consensus/frame/phase-views';

declare const frame: EntityFrame;

export const illegalDraftFromUnknownPhase: DraftEntityFrame = frame;
export const illegalLockedFromUnknownPhase: LockedEntityFrame = frame;
export const illegalCertifiedFromUnknownPhase: CertifiedEntityFrame = frame;
