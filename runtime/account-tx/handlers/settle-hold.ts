/**
 * Settlement Hold/Release Handlers
 *
 * Implements frame-atomic ring-fencing for settlement workspace.
 * When a settlement is proposed, holds are set via bilateral consensus.
 * When settlement is executed or rejected, holds are released.
 *
 * This ensures determinism: both sides see the same holds at the same frame height.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * SECURITY: Validates tx.diffs against workspace.diffs to prevent bricking
 * ═══════════════════════════════════════════════════════════════════════════
 */

import type { AccountMachine, AccountTx } from '../../types';
import { isLeftEntity } from '../../entity-id-utils';

type SettleHoldTx = Extract<AccountTx, { type: 'settle_hold' }>;
type SettleReleaseTx = Extract<AccountTx, { type: 'settle_release' }>;

/**
 * Handle settle_hold - set holds on deltas for pending settlement
 *
 * Called during frame application when settlement workspace is created.
 * Both sides apply atomically, ensuring deterministic hold state.
 *
 * SECURITY: Validates that requested holds match workspace diffs and
 * don't exceed available capacity (RCPAN: Reserve + Credit + Pending).
 */
export async function handleSettleHold(
  accountMachine: AccountMachine,
  tx: SettleHoldTx
): Promise<{
  success: boolean;
  events: string[];
  error?: string;
}> {
  const { workspaceVersion, diffs } = tx.data;

  console.log(`🔒 SETTLE-HOLD: Setting holds for workspace v${workspaceVersion}`);

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Validate workspace exists and version matches
  // ═══════════════════════════════════════════════════════════════════════════
  // Prevents attackers from proposing arbitrary holds without a valid workspace
  const workspace = accountMachine.settlementWorkspace;
  if (!workspace) {
    console.error(`❌ SECURITY: settle_hold without workspace`);
    return {
      success: false,
      events: [],
      error: 'SECURITY: settle_hold requires active settlement workspace'
    };
  }

  if (workspace.version !== workspaceVersion) {
    console.error(`❌ SECURITY: settle_hold version mismatch: tx=${workspaceVersion}, workspace=${workspace.version}`);
    return {
      success: false,
      events: [],
      error: `SECURITY: settle_hold version mismatch (expected ${workspace.version}, got ${workspaceVersion})`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Validate tx.diffs matches workspace.diffs
  // ═══════════════════════════════════════════════════════════════════════════
  // Prevents attackers from proposing different holds than agreed workspace
  //
  // NOTE: settle_hold.diffs uses leftWithdrawing/rightWithdrawing
  // while workspace.diffs uses leftDiff/rightDiff (negative = withdrawing)
  // We need to convert and compare

  const workspaceDiffs = workspace.diffs || [];

  if (diffs.length !== workspaceDiffs.length) {
    console.error(`❌ SECURITY: settle_hold diff count mismatch: tx=${diffs.length}, workspace=${workspaceDiffs.length}`);
    return {
      success: false,
      events: [],
      error: 'SECURITY: settle_hold diffs count does not match workspace'
    };
  }

  // Verify each diff matches workspace (converting field names)
  // workspace.leftDiff < 0 means left is withdrawing that amount
  // workspace.rightDiff < 0 means right is withdrawing that amount
  for (let i = 0; i < diffs.length; i++) {
    const txDiff = diffs[i]!;
    const wsDiff = workspaceDiffs[i]!;

    // Convert workspace diffs to withdrawing amounts
    // Negative diff = withdrawing, so abs(negative) = withdrawing amount
    const expectedLeftWithdrawing = wsDiff.leftDiff < 0n ? -wsDiff.leftDiff : 0n;
    const expectedRightWithdrawing = wsDiff.rightDiff < 0n ? -wsDiff.rightDiff : 0n;

    if (txDiff.tokenId !== wsDiff.tokenId ||
        txDiff.leftWithdrawing !== expectedLeftWithdrawing ||
        txDiff.rightWithdrawing !== expectedRightWithdrawing) {
      console.error(`❌ SECURITY: settle_hold diff[${i}] mismatch`);
      console.error(`   tx: token=${txDiff.tokenId}, leftW=${txDiff.leftWithdrawing}, rightW=${txDiff.rightWithdrawing}`);
      console.error(`   ws: token=${wsDiff.tokenId}, leftD=${wsDiff.leftDiff}, rightD=${wsDiff.rightDiff}`);
      console.error(`   expected: leftW=${expectedLeftWithdrawing}, rightW=${expectedRightWithdrawing}`);
      return {
        success: false,
        events: [],
        error: `SECURITY: settle_hold diff[${i}] does not match workspace`
      };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Validate capacity (RCPAN check)
  // ═══════════════════════════════════════════════════════════════════════════
  // Ensure holds don't exceed what the entity actually has available.
  //
  // Two sources of funds for settlements:
  //   1. Entity RESERVES (leftDiff < 0 → depositing from reserves into account)
  //      → Capacity = entity reserves (validated on-chain by Depository.sol)
  //      → Off-chain hold only prevents concurrent double-spend of same reserves
  //   2. Bilateral ACCOUNT (collateralDiff < 0 → withdrawing from collateral)
  //      → Capacity = collateral + credit + delta position (checked here)
  //
  // We only enforce bilateral capacity limits for withdrawals from the account.
  // Reserve-sourced deposits are validated by L1 at settlement execution time.
  // ═══════════════════════════════════════════════════════════════════════════
  const iAmLeft = isLeftEntity(accountMachine.proofHeader.fromEntity, accountMachine.proofHeader.toEntity);

  for (const diff of diffs) {
    const delta = accountMachine.deltas.get(diff.tokenId);
    if (!delta) {
      console.warn(`⚠️ SETTLE-HOLD: No delta for tokenId ${diff.tokenId}`);
      continue;
    }

    // Find matching workspace diff to determine operation type
    const wsDiff = workspaceDiffs.find(d => d.tokenId === diff.tokenId);
    const isLeftDeposit = (wsDiff?.leftDiff ?? 0n) < 0n && (wsDiff?.collateralDiff ?? 0n) > 0n;
    const isRightDeposit = (wsDiff?.rightDiff ?? 0n) < 0n && (wsDiff?.collateralDiff ?? 0n) > 0n;

    // Calculate bilateral account capacity (for withdrawal operations)
    const totalDelta = delta.ondelta + delta.offdelta;
    const leftCapacity = delta.collateral + delta.rightCreditLimit + (totalDelta > 0n ? 0n : -totalDelta);
    const rightCapacity = delta.collateral + delta.leftCreditLimit + (totalDelta < 0n ? 0n : totalDelta);

    // Current holds already placed
    const existingLeftHold = delta.leftSettleHold ?? 0n;
    const existingRightHold = delta.rightSettleHold ?? 0n;

    // Check left capacity (skip for deposits — L1 validates reserves)
    if (!isLeftDeposit && existingLeftHold + diff.leftWithdrawing > leftCapacity) {
      console.error(`❌ SECURITY: settle_hold exceeds left capacity for token ${diff.tokenId}`);
      console.error(`   requested: ${existingLeftHold} + ${diff.leftWithdrawing} = ${existingLeftHold + diff.leftWithdrawing}`);
      console.error(`   capacity: ${leftCapacity}`);
      return {
        success: false,
        events: [],
        error: `SECURITY: settle_hold exceeds left capacity for token ${diff.tokenId}`
      };
    }

    // Check right capacity (skip for deposits — L1 validates reserves)
    if (!isRightDeposit && existingRightHold + diff.rightWithdrawing > rightCapacity) {
      console.error(`❌ SECURITY: settle_hold exceeds right capacity for token ${diff.tokenId}`);
      console.error(`   requested: ${existingRightHold} + ${diff.rightWithdrawing} = ${existingRightHold + diff.rightWithdrawing}`);
      console.error(`   capacity: ${rightCapacity}`);
      return {
        success: false,
        events: [],
        error: `SECURITY: settle_hold exceeds right capacity for token ${diff.tokenId}`
      };
    }

    // Initialize holds if not present
    delta.leftSettleHold ??= 0n;
    delta.rightSettleHold ??= 0n;

    // Add holds (tracked even for deposits to prevent concurrent double-spend)
    delta.leftSettleHold += diff.leftWithdrawing;
    delta.rightSettleHold += diff.rightWithdrawing;

    console.log(`   Token ${diff.tokenId}: leftHold=${delta.leftSettleHold}, rightHold=${delta.rightSettleHold}${isLeftDeposit ? ' (L-deposit)' : ''}${isRightDeposit ? ' (R-deposit)' : ''}`);
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
  tx: SettleReleaseTx
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
