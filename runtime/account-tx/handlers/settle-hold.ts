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

import type { AccountMachine, AccountTx, SettlementDiff } from '../../types';
import { compileOps } from '../../settlement-ops';
import { deriveDelta } from '../../account-utils';
import { createStructuredLogger } from '../../logger';

type SettleHoldTx = Extract<AccountTx, { type: 'settle_hold' }>;
type SettleReleaseTx = Extract<AccountTx, { type: 'settle_release' }>;

const settlementHoldLog = createStructuredLogger('account.settle');

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

  settlementHoldLog.debug('hold.start', { workspaceVersion, diffs: diffs.length });

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Validate workspace exists and version matches
  // ═══════════════════════════════════════════════════════════════════════════
  // Prevents attackers from proposing arbitrary holds without a valid workspace
  const workspace = accountMachine.settlementWorkspace;
  if (!workspace) {
    settlementHoldLog.debug('hold.missing_workspace', { workspaceVersion });
    return {
      success: false,
      events: [],
      error: 'SECURITY: settle_hold requires active settlement workspace'
    };
  }

  if (workspace.version !== workspaceVersion) {
    settlementHoldLog.debug('hold.version_mismatch', { txVersion: workspaceVersion, workspaceVersion: workspace.version });
    return {
      success: false,
      events: [],
      error: `SECURITY: settle_hold version mismatch (expected ${workspace.version}, got ${workspaceVersion})`
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SECURITY: Validate tx.diffs matches workspace compiled diffs
  // ═══════════════════════════════════════════════════════════════════════════
  // Prevents attackers from proposing different holds than agreed workspace
  //
  // NOTE: settle_hold.diffs uses leftWithdrawing/rightWithdrawing
  // while compiled diffs use leftDiff/rightDiff (negative = withdrawing)
  // We need to convert and compare

  let workspaceDiffs: SettlementDiff[] = [];
  try {
    workspaceDiffs = compileOps(workspace.ops, workspace.lastModifiedByLeft).diffs;
  } catch {
    // If compile fails, use cached compiled diffs
    workspaceDiffs = workspace.compiledDiffs || [];
  }

  if (diffs.length !== workspaceDiffs.length) {
    settlementHoldLog.debug('hold.diff_count_mismatch', { txDiffs: diffs.length, workspaceDiffs: workspaceDiffs.length });
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
      settlementHoldLog.debug('hold.diff_mismatch', {
        index: i,
        txToken: txDiff.tokenId,
        workspaceToken: wsDiff.tokenId,
        txLeftWithdrawing: txDiff.leftWithdrawing.toString(),
        txRightWithdrawing: txDiff.rightWithdrawing.toString(),
        expectedLeftWithdrawing: expectedLeftWithdrawing.toString(),
        expectedRightWithdrawing: expectedRightWithdrawing.toString(),
      });
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
  for (const diff of diffs) {
    const delta = accountMachine.deltas.get(diff.tokenId);
    if (!delta) {
      settlementHoldLog.debug('hold.missing_delta', { tokenId: diff.tokenId });
      continue;
    }

    // Find matching workspace diff to determine operation type
    const wsDiff = workspaceDiffs.find(d => d.tokenId === diff.tokenId);
    const isLeftDeposit = (wsDiff?.leftDiff ?? 0n) < 0n && (wsDiff?.collateralDiff ?? 0n) > 0n;
    const isRightDeposit = (wsDiff?.rightDiff ?? 0n) < 0n && (wsDiff?.collateralDiff ?? 0n) > 0n;

    // Canonical bilateral capacity view from deriveDelta().
    // Additional hold for each side must not exceed that side's current outbound capacity.
    const leftDerived = deriveDelta(delta, true);
    const rightDerived = deriveDelta(delta, false);
    const leftAvailable = leftDerived.outCapacity;
    const rightAvailable = rightDerived.outCapacity;

    // Check left capacity (skip for reserve-sourced deposits — L1 validates reserves)
    if (!isLeftDeposit && diff.leftWithdrawing > leftAvailable) {
      settlementHoldLog.debug('hold.left_capacity_exceeded', {
        tokenId: diff.tokenId,
        requested: diff.leftWithdrawing.toString(),
        capacity: leftAvailable.toString(),
      });
      return {
        success: false,
        events: [],
        error: `SECURITY: settle_hold exceeds left capacity for token ${diff.tokenId}`
      };
    }

    // Check right capacity (skip for reserve-sourced deposits — L1 validates reserves)
    if (!isRightDeposit && diff.rightWithdrawing > rightAvailable) {
      settlementHoldLog.debug('hold.right_capacity_exceeded', {
        tokenId: diff.tokenId,
        requested: diff.rightWithdrawing.toString(),
        capacity: rightAvailable.toString(),
      });
      return {
        success: false,
        events: [],
        error: `SECURITY: settle_hold exceeds right capacity for token ${diff.tokenId}`
      };
    }

    // Initialize holds if not present
    delta.leftHold ??= 0n;
    delta.rightHold ??= 0n;

    // Add holds (tracked even for deposits to prevent concurrent double-spend)
    delta.leftHold += diff.leftWithdrawing;
    delta.rightHold += diff.rightWithdrawing;

    settlementHoldLog.debug('hold.delta_updated', {
      tokenId: diff.tokenId,
      leftHold: delta.leftHold.toString(),
      rightHold: delta.rightHold.toString(),
      leftDeposit: isLeftDeposit,
      rightDeposit: isRightDeposit,
    });
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

  settlementHoldLog.debug('release.start', { workspaceVersion, diffs: diffs.length });

  const plannedReleases = new Map<number, { left: bigint; right: bigint }>();
  for (const diff of diffs) {
    const existing = plannedReleases.get(diff.tokenId);
    if (existing) {
      existing.left += diff.leftWithdrawing;
      existing.right += diff.rightWithdrawing;
    } else {
      plannedReleases.set(diff.tokenId, {
        left: diff.leftWithdrawing,
        right: diff.rightWithdrawing,
      });
    }
  }

  for (const [tokenId, planned] of plannedReleases) {
    const delta = accountMachine.deltas.get(tokenId);
    if (!delta) {
      settlementHoldLog.debug('release.missing_delta', { tokenId });
      continue;
    }

    delta.leftHold ??= 0n;
    delta.rightHold ??= 0n;

    if (delta.leftHold < planned.left) {
      return {
        success: false,
        events: [],
        error: `SETTLE_RELEASE_HOLD_UNDERFLOW:left token=${tokenId} hold=${delta.leftHold.toString()} release=${planned.left.toString()}`,
      };
    }
    if (delta.rightHold < planned.right) {
      return {
        success: false,
        events: [],
        error: `SETTLE_RELEASE_HOLD_UNDERFLOW:right token=${tokenId} hold=${delta.rightHold.toString()} release=${planned.right.toString()}`,
      };
    }
  }

  for (const diff of diffs) {
    const delta = accountMachine.deltas.get(diff.tokenId);
    if (!delta) {
      settlementHoldLog.debug('release.missing_delta', { tokenId: diff.tokenId });
      continue;
    }

    // Initialize holds if not present (safety)
    delta.leftHold ??= 0n;
    delta.rightHold ??= 0n;

    delta.leftHold -= diff.leftWithdrawing;
    delta.rightHold -= diff.rightWithdrawing;

    settlementHoldLog.debug('release.delta_updated', {
      tokenId: diff.tokenId,
      leftHold: delta.leftHold.toString(),
      rightHold: delta.rightHold.toString(),
    });
  }

  return {
    success: true,
    events: [`🔓 Settlement holds released for workspace v${workspaceVersion}`],
  };
}
