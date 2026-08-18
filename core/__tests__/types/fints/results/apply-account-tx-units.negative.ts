import { toHashlock, type LockId } from '../../../../account/tx/units';

export const illegalHashlockAsLockId: LockId = toHashlock(`0x${'11'.repeat(32)}`);
