/**
 * Improved Payment Channel Capacity Calculator
 * 
 * Mathematical Model:
 * - A payment channel has collateral locked by both parties
 * - Each party can extend credit beyond collateral (trust-based)
 * - The "delta" represents net flow: positive = owed to you, negative = you owe
 * - Total capacity = collateral + creditLimitLeft + creditLimitRight
 */

import type { Delta } from './types';

/**
 * Safe bigint operations with overflow protection
 */
const SafeMath = {
  add: (a: bigint, b: bigint): bigint => {
    const result = a + b;
    // Check for overflow (simplified - in production use proper bounds)
    if (a > 0n && b > 0n && result < a) {
      throw new Error(`Overflow in addition: ${a} + ${b}`);
    }
    return result;
  },
  
  subtract: (a: bigint, b: bigint): bigint => {
    const result = a - b;
    // Check for underflow
    if (a < b && result > a) {
      throw new Error(`Underflow in subtraction: ${a} - ${b}`);
    }
    return result;
  },
  
  min: (...values: bigint[]): bigint => {
    return values.reduce((min, val) => val < min ? val : min);
  },
  
  max: (...values: bigint[]): bigint => {
    return values.reduce((max, val) => val > max ? val : max);
  },
  
  clamp: (value: bigint, min: bigint, max: bigint): bigint => {
    if (min > max) throw new Error(`Invalid bounds: min ${min} > max ${max}`);
    return SafeMath.max(min, SafeMath.min(value, max));
  }
};

/**
 * Channel state representation
 */
interface ChannelState {
  netDelta: bigint;      // Net position (ondelta + offdelta)
  collateral: bigint;    // Total locked collateral
  ownCreditLimit: bigint;   // Credit we extend
  peerCreditLimit: bigint;  // Credit they extend
  ownAllowance: bigint;     // Reserved for pending operations (us)
  peerAllowance: bigint;    // Reserved for pending operations (them)
}

/**
 * Capacity components breakdown
 */
interface CapacityComponents {
  // Collateral allocation
  collateralUsedByUs: bigint;    // Collateral covering our debt
  collateralUsedByPeer: bigint;  // Collateral covering their debt
  collateralFree: bigint;        // Unallocated collateral
  
  // Credit usage
  ownCreditUsed: bigint;      // Our credit being used
  ownCreditAvailable: bigint; // Our credit still available
  peerCreditUsed: bigint;     // Their credit being used  
  peerCreditAvailable: bigint; // Their credit still available
  
  // Final capacities
  inboundCapacity: bigint;   // Max we can receive
  outboundCapacity: bigint;  // Max we can send
}

/**
 * Calculate capacity components with clear mathematical model
 */
function calculateCapacityComponents(state: ChannelState): CapacityComponents {
  const { netDelta, collateral, ownCreditLimit, peerCreditLimit, ownAllowance, peerAllowance } = state;
  
  // Ensure non-negative base values
  const safeCollateral = SafeMath.max(0n, collateral);
  const safeOwnCredit = SafeMath.max(0n, ownCreditLimit);
  const safePeerCredit = SafeMath.max(0n, peerCreditLimit);
  
  // Calculate collateral allocation based on net position
  let collateralUsedByUs = 0n;
  let collateralUsedByPeer = 0n;
  
  if (netDelta > 0n) {
    // We are owed money (peer owes us)
    collateralUsedByPeer = SafeMath.min(netDelta, safeCollateral);
    collateralUsedByUs = 0n;
  } else if (netDelta < 0n) {
    // We owe money
    const absDebt = -netDelta;
    collateralUsedByUs = SafeMath.min(absDebt, safeCollateral);
    collateralUsedByPeer = 0n;
  }
  
  const collateralFree = SafeMath.max(0n, 
    safeCollateral - collateralUsedByUs - collateralUsedByPeer
  );
  
  // Calculate credit usage
  let ownCreditUsed = 0n;
  let peerCreditUsed = 0n;
  
  if (netDelta < 0n) {
    // We owe money - check if it exceeds collateral
    const absDebt = -netDelta;
    const debtBeyondCollateral = SafeMath.max(0n, absDebt - safeCollateral);
    ownCreditUsed = SafeMath.min(debtBeyondCollateral, safeOwnCredit);
  } else if (netDelta > 0n) {
    // Peer owes us - check if it exceeds collateral
    const debtBeyondCollateral = SafeMath.max(0n, netDelta - safeCollateral);
    peerCreditUsed = SafeMath.min(debtBeyondCollateral, safePeerCredit);
  }
  
  const ownCreditAvailable = SafeMath.max(0n, safeOwnCredit - ownCreditUsed);
  const peerCreditAvailable = SafeMath.max(0n, safePeerCredit - peerCreditUsed);
  
  // Calculate final capacities
  // Inbound: what we can receive = peer's available resources - their reserved allowance
  const inboundBeforeAllowance = SafeMath.add(
    SafeMath.add(collateralFree, collateralUsedByUs),
    peerCreditAvailable
  );
  const inboundCapacity = SafeMath.max(0n, 
    SafeMath.subtract(inboundBeforeAllowance, peerAllowance)
  );
  
  // Outbound: what we can send = our available resources - our reserved allowance
  const outboundBeforeAllowance = SafeMath.add(
    SafeMath.add(collateralFree, collateralUsedByPeer),
    ownCreditAvailable
  );
  const outboundCapacity = SafeMath.max(0n,
    SafeMath.subtract(outboundBeforeAllowance, ownAllowance)
  );
  
  return {
    collateralUsedByUs,
    collateralUsedByPeer,
    collateralFree,
    ownCreditUsed,
    ownCreditAvailable,
    peerCreditUsed,
    peerCreditAvailable,
    inboundCapacity,
    outboundCapacity
  };
}

/**
 * Create enhanced ASCII visualization with better scaling
 */
function createVisualization(
  state: ChannelState,
  components: CapacityComponents,
  width: number = 50
): string {
  const totalCapacity = SafeMath.add(
    SafeMath.add(state.collateral, state.ownCreditLimit),
    state.peerCreditLimit
  );
  
  if (totalCapacity === 0n) {
    return '[' + ' '.repeat(width) + ']';
  }
  
  // Calculate segment widths proportionally
  const scale = (value: bigint): number => {
    const scaled = Number((value * BigInt(width)) / totalCapacity);
    return Math.min(Math.max(0, scaled), width);
  };
  
  const leftCreditWidth = scale(state.ownCreditLimit);
  const collateralWidth = scale(state.collateral);
  const rightCreditWidth = width - leftCreditWidth - collateralWidth;
  
  // Build visualization with different characters for each segment
  const leftSegment = '─'.repeat(leftCreditWidth);    // Our credit zone
  const collateralSegment = '█'.repeat(collateralWidth);  // Collateral zone
  const rightSegment = '─'.repeat(rightCreditWidth);   // Peer credit zone
  
  // Calculate position of the balance pointer
  const pointerPosition = scale(state.netDelta + state.ownCreditLimit);
  const clampedPosition = Math.max(0, Math.min(pointerPosition, width - 1));
  
  // Build final visualization
  const bar = leftSegment + collateralSegment + rightSegment;
  const withPointer = 
    bar.substring(0, clampedPosition) + 
    '▼' + 
    bar.substring(clampedPosition + 1);
  
  // Add labels
  const labels = `[L:${formatBigInt(state.ownCreditLimit)} C:${formatBigInt(state.collateral)} R:${formatBigInt(state.peerCreditLimit)}]`;
  const position = `Δ:${formatBigInt(state.netDelta)}`;
  
  return `${labels}\n[${withPointer}] ${position}`;
}

/**
 * Format bigint for display (simplified - extend as needed)
 */
function formatBigInt(value: bigint): string {
  const str = value.toString();
  if (str.length <= 6) return str;
  
  // Use K, M, B suffixes for large numbers
  const absValue = value < 0n ? -value : value;
  const sign = value < 0n ? '-' : '';
  
  if (absValue >= 1_000_000_000n) {
    return `${sign}${Number(absValue / 1_000_000n) / 1000}B`;
  } else if (absValue >= 1_000_000n) {
    return `${sign}${Number(absValue / 1_000n) / 1000}M`;
  } else if (absValue >= 1_000n) {
    return `${sign}${Number(absValue) / 1000}K`;
  }
  return str;
}

/**
 * Main improved deriveDelta function
 */
export function deriveDeltaImproved(delta: Delta, isLeft: boolean) {
  console.log(`📊 Calculating capacities for ${isLeft ? 'LEFT' : 'RIGHT'} party`);
  
  // Build channel state
  const state: ChannelState = {
    netDelta: SafeMath.add(delta.ondelta, delta.offdelta),
    collateral: SafeMath.max(0n, delta.collateral),
    ownCreditLimit: isLeft ? delta.leftCreditLimit : delta.rightCreditLimit,
    peerCreditLimit: isLeft ? delta.rightCreditLimit : delta.leftCreditLimit,
    ownAllowance: isLeft ? delta.leftAllowence : delta.rightAllowence,
    peerAllowance: isLeft ? delta.rightAllowence : delta.leftAllowence
  };
  
  // Flip net delta for right party view
  if (!isLeft) {
    state.netDelta = -state.netDelta;
  }
  
  // Calculate components
  const components = calculateCapacityComponents(state);
  
  // Create visualization
  const visualization = createVisualization(state, components);
  
  // Log detailed breakdown
  console.log('Channel State:');
  console.log(`  Net Delta: ${formatBigInt(state.netDelta)}`);
  console.log(`  Collateral: ${formatBigInt(state.collateral)}`);
  console.log(`  Own Credit Limit: ${formatBigInt(state.ownCreditLimit)}`);
  console.log(`  Peer Credit Limit: ${formatBigInt(state.peerCreditLimit)}`);
  console.log('\nCapacity Breakdown:');
  console.log(`  Inbound Capacity: ${formatBigInt(components.inboundCapacity)}`);
  console.log(`  Outbound Capacity: ${formatBigInt(components.outboundCapacity)}`);
  console.log('\nVisualization:');
  console.log(visualization);
  
  // Return backward-compatible structure plus new fields
  return {
    // Original fields
    delta: state.netDelta,
    collateral: state.collateral,
    inCollateral: components.collateralUsedByUs,
    outCollateral: components.collateralUsedByPeer,
    inOwnCredit: components.ownCreditUsed,
    outPeerCredit: components.peerCreditUsed,
    inAllowence: state.peerAllowance,
    outAllowence: state.ownAllowance,
    totalCapacity: SafeMath.add(SafeMath.add(state.collateral, state.ownCreditLimit), state.peerCreditLimit),
    ownCreditLimit: state.ownCreditLimit,
    peerCreditLimit: state.peerCreditLimit,
    inCapacity: components.inboundCapacity,
    outCapacity: components.outboundCapacity,
    outOwnCredit: components.ownCreditAvailable,
    inPeerCredit: components.peerCreditAvailable,
    ascii: visualization,
    
    // New detailed breakdown
    components,
    state
  };
}
