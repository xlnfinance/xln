import type { AccountFrame } from '../../types/account';
import { cloneIsolatedAccountFrame } from '../../protocol/state/account-input-clone';

export const cloneAccountFrame = (frame: AccountFrame): AccountFrame =>
  cloneIsolatedAccountFrame(frame);
