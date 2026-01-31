/**
 * Bilateral Consensus State Classification
 * Determines visual state of account for rendering uncommitted frames
 *
 * KISS principle: 3 states (mempool, proposed, committed)
 * Right-wins rule: On simultaneous proposals, LEFT rolls back
 */

import type { AccountMachine } from './types';

export type BilateralState =
  | 'committed'    // Both sides synced
  | 'mempool'      // Local transactions not yet proposed
  | 'proposed'     // Frame sent to peer, awaiting ACK
  | 'conflict';    // Simultaneous proposals detected

export interface BilateralVisualizationState {
  state: BilateralState;
  isLeftEntity: boolean;
  shouldRollback: boolean;  // True if LEFT in conflict (Right wins)
  pendingHeight: number | null;
  mempoolCount: number;
}

/**
 * Classify bilateral consensus state for ONE side of the account
 * @param myAccount - My view of the bilateral account
 * @param peerCurrentHeight - Peer's committed frame height (from their replica)
 * @param isLeft - Am I the left entity? (for conflict resolution)
 */
export function classifyBilateralState(
  myAccount: AccountMachine | undefined,
  peerCurrentHeight: number | undefined,
  isLeft: boolean
): BilateralVisualizationState {
  if (!myAccount) {
    return {
      state: 'committed',
      isLeftEntity: isLeft,
      shouldRollback: false,
      pendingHeight: null,
      mempoolCount: 0,
    };
  }

  const myHeight = myAccount.currentFrame?.height ?? 0;
  const myPendingHeight = myAccount.pendingFrame?.height ?? null;
  const peerHeight = peerCurrentHeight ?? 0;
  const mempoolCount = myAccount.mempool?.length ?? 0;

  // CONFLICT: Both sides have pendingFrame at same height
  // RIGHT wins, LEFT must rollback (deterministic tie-breaker)
  const hasPendingFrame = myPendingHeight !== null;
  const peerAhead = peerHeight > myHeight;

  if (hasPendingFrame && peerAhead && peerHeight === myPendingHeight) {
    return {
      state: 'conflict',
      isLeftEntity: isLeft,
      shouldRollback: isLeft, // LEFT rolls back, RIGHT wins
      pendingHeight: myPendingHeight,
      mempoolCount,
    };
  }

  // PROPOSED: I sent frame, peer hasn't applied yet
  if (hasPendingFrame && peerHeight < (myPendingHeight ?? 0)) {
    return {
      state: 'proposed',
      isLeftEntity: isLeft,
      shouldRollback: false,
      pendingHeight: myPendingHeight,
      mempoolCount,
    };
  }

  // MEMPOOL: Have transactions but haven't proposed yet
  if (mempoolCount > 0 && !hasPendingFrame) {
    return {
      state: 'mempool',
      isLeftEntity: isLeft,
      shouldRollback: false,
      pendingHeight: null,
      mempoolCount,
    };
  }

  // COMMITTED: No pending frames, peer is synced
  return {
    state: 'committed',
    isLeftEntity: isLeft,
    shouldRollback: false,
    pendingHeight: null,
    mempoolCount: 0,
  };
}

/**
 * Get visual properties for account bar rendering
 */
export interface AccountBarVisual {
  glowColor: 'yellow' | 'blue' | 'red' | null;
  glowSide: 'left' | 'right' | 'both' | null;
  glowIntensity: number; // 0.0 to 1.0
  isDashed: boolean;     // True for uncommitted state
  pulseSpeed: number;    // ms per pulse cycle (0 = no pulse)
}

export function getAccountBarVisual(
  leftState: BilateralVisualizationState,
  rightState: BilateralVisualizationState
): AccountBarVisual {

  // CONFLICT: Both proposed simultaneously
  if (leftState.state === 'conflict' || rightState.state === 'conflict') {
    return {
      glowColor: 'red',
      glowSide: 'both',
      glowIntensity: 0.8,
      isDashed: true,
      pulseSpeed: 500, // Fast pulse indicates conflict
    };
  }

  // PROPOSED from left
  if (leftState.state === 'proposed') {
    return {
      glowColor: 'yellow',
      glowSide: 'left',
      glowIntensity: 0.6,
      isDashed: true,
      pulseSpeed: 1000,
    };
  }

  // PROPOSED from right
  if (rightState.state === 'proposed') {
    return {
      glowColor: 'yellow',
      glowSide: 'right',
      glowIntensity: 0.6,
      isDashed: true,
      pulseSpeed: 1000,
    };
  }

  // MEMPOOL on either side (subtle indication)
  if (leftState.state === 'mempool' || rightState.state === 'mempool') {
    const side = leftState.state === 'mempool' ? 'left' : 'right';
    return {
      glowColor: 'yellow',
      glowSide: side,
      glowIntensity: 0.2, // Very subtle
      isDashed: false,
      pulseSpeed: 2000,   // Slow pulse
    };
  }

  // COMMITTED: Both sides synced
  return {
    glowColor: null,
    glowSide: null,
    glowIntensity: 0,
    isDashed: false,
    pulseSpeed: 0,
  };
}
