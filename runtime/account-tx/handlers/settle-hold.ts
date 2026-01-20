/**
 * Settlement Hold/Release Handlers
 *
 * Implements frame-atomic ring-fencing for settlement workspace.
 * When a settlement is proposed, holds are set via bilateral consensus.
 * When settlement is executed or rejected, holds are released.
 *
 * This ensures determinism: both sides see the same holds at the same frame height.
 */

import type { AccountMachine, AccountTx } from '../../types';

type SettleHoldTx = Extract<AccountTx, { type: 'settle_hold' }>;
type SettleReleaseTx = Extract<AccountTx, { type: 'settle_release' }>;

/**
 * Handle settle_hold - set holds on deltas for pending settlement
 *
 * Called during frame application when settlement workspace is created.
 * Both sides apply atomically, ensuring deterministic hold state.
 */
export async function handleSettleHold(
  accountMachine: AccountMachine,
  tx: SettleHoldTx,
  _isOurFrame: boolean = true
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
}> {
  const { workspaceVersion, diffs } = tx.data;

  console.log(`🔒 SETTLE-HOLD: Setting holds for workspace v${workspaceVersion}`);

  for (const diff of diffs) {
    const delta = accountMachine.deltas.get(diff.tokenId);
    if (!delta) {
      console.warn(`⚠️ SETTLE-HOLD: No delta for tokenId ${diff.tokenId}`);
      continue;
    }

    // Initialize holds if not present
    delta.leftSettleHold ??= 0n;
    delta.rightSettleHold ??= 0n;

    // Add holds
    delta.leftSettleHold += diff.leftWithdrawing;
    delta.rightSettleHold += diff.rightWithdrawing;

    console.log(`   Token ${diff.tokenId}: leftHold=${delta.leftSettleHold}, rightHold=${delta.rightSettleHold}`);
  }

  return {
    success: true,
    events: [`🔒 Settlement holds set for workspace v${workspaceVersion}`],
  };
}

/**
 * Handle settle_release - release holds when settlement completes or is rejected
 *
 * Called during frame application when settlement workspace is cleared.
 * Both sides apply atomically, ensuring deterministic hold release.
 */
export async function handleSettleRelease(
  accountMachine: AccountMachine,
  tx: SettleReleaseTx,
  _isOurFrame: boolean = true
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
}> {
  const { workspaceVersion, diffs } = tx.data;

  console.log(`🔓 SETTLE-RELEASE: Releasing holds for workspace v${workspaceVersion}`);

  for (const diff of diffs) {
    const delta = accountMachine.deltas.get(diff.tokenId);
    if (!delta) {
      console.warn(`⚠️ SETTLE-RELEASE: No delta for tokenId ${diff.tokenId}`);
      continue;
    }

    // Initialize holds if not present (safety)
    delta.leftSettleHold ??= 0n;
    delta.rightSettleHold ??= 0n;

    // Release holds with underflow guard (check BEFORE subtracting)
    const currentLeftHold = delta.leftSettleHold;
    const currentRightHold = delta.rightSettleHold;

    if (currentLeftHold < diff.leftWithdrawing) {
      console.warn(`⚠️ SETTLE-RELEASE: leftSettleHold underflow! ${currentLeftHold} < ${diff.leftWithdrawing}, clamping to 0`);
      delta.leftSettleHold = 0n;
    } else {
      delta.leftSettleHold = currentLeftHold - diff.leftWithdrawing;
    }

    if (currentRightHold < diff.rightWithdrawing) {
      console.warn(`⚠️ SETTLE-RELEASE: rightSettleHold underflow! ${currentRightHold} < ${diff.rightWithdrawing}, clamping to 0`);
      delta.rightSettleHold = 0n;
    } else {
      delta.rightSettleHold = currentRightHold - diff.rightWithdrawing;
    }

    console.log(`   Token ${diff.tokenId}: leftHold=${delta.leftSettleHold}, rightHold=${delta.rightSettleHold}`);
  }

  return {
    success: true,
    events: [`🔓 Settlement holds released for workspace v${workspaceVersion}`],
  };
}
