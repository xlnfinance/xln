/**
 * AccountBarRenderer - 3D visualization of bilateral account capacity
 *
 * Renders the 7-region capacity visualization:
 * [our_unused_credit][our_collateral][their_used_credit] |DELTA| [our_used_credit][their_collateral][their_unused_credit]
 *
 * Two modes:
 * - Close: All bars stacked at centerline with yellow delta separator
 * - Spread: Bars extend from each entity with gap in middle
 */

import * as THREE from 'three';
import type { EntityData, DerivedAccountData } from './types';

export interface AccountBarVisual {
  glowColor: string | null;
  glowSide: string | null;
  glowIntensity: number;
  isDashed: boolean;
  pulseSpeed: number;
}

export interface AccountBarSettings {
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  desyncDetected?: boolean | undefined; // Bilateral consensus in progress
  bilateralState?: AccountBarVisual | null | undefined; // Visual state from consensus
}

export interface AccountSegments {
  outOwnCredit: number;    // our unused credit (pink wireframe)
  inCollateral: number;     // our collateral (green solid)
  outPeerCredit: number;    // their used credit (red wireframe)
  inOwnCredit: number;      // our used credit (red wireframe)
  outCollateral: number;    // their collateral (green solid)
  inPeerCredit: number;     // their unused credit (pink wireframe)
}

const BAR_COLORS = {
  availableCredit: 0xff9c9c,  // light red - unused credit
  secured: 0x5cb85c,          // green - collateral
  unsecured: 0xdc3545         // red - used credit
} as const;

/**
 * Create account capacity bars for a bilateral account (multi-token parallel bars)
 * @param deltas - Map of all token deltas for this account
 * @param fromIsLeft - whether fromEntity is the LEFT entity (smaller entityId)
 * @param xlnFunctions - XLN runtime functions (needed for deriveDelta)
 */
export function createAccountBars(
  scene: THREE.Scene,
  fromEntity: EntityData,
  toEntity: EntityData,
  deltas: Map<number, any>,  // Map<tokenId, Delta>
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number,
  xlnFunctions: any  // XLNRuntime interface
): THREE.Group {
  const group = new THREE.Group();

  // Sort tokens for consistent ordering across all accounts
  const sortedTokenIds = Array.from(deltas.keys()).sort((a, b) => a - b);
  if (sortedTokenIds.length === 0) {
    console.warn('[AccountBars] No tokens in account deltas');
    return group; // Empty group
  }

  // Calculate bar dimensions
  const barHeight = 0.08;
  const direction = new THREE.Vector3().subVectors(toEntity.position, fromEntity.position);
  const normalizedDirection = direction.clone().normalize();

  // Calculate perpendicular vector for parallel bar layout
  const perpendicular = calculatePerpendicularVector(normalizedDirection);

  // Auto-scale bar radius for many tokens
  const tokenCount = sortedTokenIds.length;
  const baseRadius = barHeight * 2.5;  // Original barRadius = 0.2
  const adjustedRadius = tokenCount > 4 ? baseRadius * Math.min(1.0, 4 / tokenCount) : baseRadius;
  const adjustedDiameter = adjustedRadius * 2;

  // Calculate total width and start offset for centering
  const totalWidth = tokenCount * adjustedDiameter;
  const startOffset = -(totalWidth / 2) + (adjustedDiameter / 2);

  // Create bars for each token with perpendicular offset
  for (let i = 0; i < tokenCount; i++) {
    const tokenId = sortedTokenIds[i]!;  // Safe: i < tokenCount guarantees element exists
    const delta = deltas.get(tokenId);

    if (!delta || !xlnFunctions?.deriveDelta) {
      console.warn(`[AccountBars] Missing delta or deriveDelta for token ${tokenId}`);
      continue;
    }

    // Derive capacity data for this token and convert BigInt to number
    const fromDerivedRaw = xlnFunctions.deriveDelta(delta, fromIsLeft);
    const toDerivedRaw = xlnFunctions.deriveDelta(delta, !fromIsLeft);

    // Convert BigInt values to numbers for 3D visualization
    const fromDerived: DerivedAccountData = {
      delta: Number(fromDerivedRaw.delta),
      totalCapacity: Number(fromDerivedRaw.totalCapacity || 0n),
      ownCreditLimit: Number(fromDerivedRaw.ownCreditLimit || 0n),
      peerCreditLimit: Number(fromDerivedRaw.peerCreditLimit || 0n),
      inCapacity: Number(fromDerivedRaw.inCapacity || 0n),
      outCapacity: Number(fromDerivedRaw.outCapacity || 0n),
      collateral: Number(fromDerivedRaw.collateral || 0n),
      outOwnCredit: Number(fromDerivedRaw.outOwnCredit || 0n),
      inCollateral: Number(fromDerivedRaw.inCollateral || 0n),
      outPeerCredit: Number(fromDerivedRaw.outPeerCredit || 0n),
      inOwnCredit: Number(fromDerivedRaw.inOwnCredit || 0n),
      outCollateral: Number(fromDerivedRaw.outCollateral || 0n),
      inPeerCredit: Number(fromDerivedRaw.inPeerCredit || 0n)
    };

    const toDerived: DerivedAccountData = {
      delta: Number(toDerivedRaw.delta),
      totalCapacity: Number(toDerivedRaw.totalCapacity || 0n),
      ownCreditLimit: Number(toDerivedRaw.ownCreditLimit || 0n),
      peerCreditLimit: Number(toDerivedRaw.peerCreditLimit || 0n),
      inCapacity: Number(toDerivedRaw.inCapacity || 0n),
      outCapacity: Number(toDerivedRaw.outCapacity || 0n),
      collateral: Number(toDerivedRaw.collateral || 0n),
      outOwnCredit: Number(toDerivedRaw.outOwnCredit || 0n),
      inCollateral: Number(toDerivedRaw.inCollateral || 0n),
      outPeerCredit: Number(toDerivedRaw.outPeerCredit || 0n),
      inOwnCredit: Number(toDerivedRaw.inOwnCredit || 0n),
      outCollateral: Number(toDerivedRaw.outCollateral || 0n),
      inPeerCredit: Number(toDerivedRaw.inPeerCredit || 0n)
    };

    // Calculate perpendicular offset for this token's bars
    const offset = startOffset + (i * adjustedDiameter);
    const perpendicularOffset = perpendicular.clone().multiplyScalar(offset);

    // Create token-specific bar group
    const tokenBarGroup = createTokenBars(
      fromEntity,
      toEntity,
      normalizedDirection,
      fromDerived,
      toDerived,
      fromIsLeft,
      settings,
      getEntitySize,
      tokenId,
      adjustedRadius,
      barHeight
    );

    // Apply perpendicular offset to position this token's bars
    tokenBarGroup.position.copy(perpendicularOffset);
    group.add(tokenBarGroup);
  }

  scene.add(group);
  return group;
}

/**
 * Create bars for a single token (extracted from original createAccountBars logic)
 */
function createTokenBars(
  fromEntity: EntityData,
  toEntity: EntityData,
  normalizedDirection: THREE.Vector3,
  fromDerived: DerivedAccountData,
  toDerived: DerivedAccountData,
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number,
  tokenId: number,
  barRadius: number,
  barHeight: number
): THREE.Group {
  const tokenGroup = new THREE.Group();

  // Scale bars based on token value (1px = $1 invariant)
  const decimals = 18;
  const tokensToVisualUnits = 0.00001; // 1M tokens → 10 visual units
  const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (settings.portfolioScale / 5000);

  // Compute CREDIT DEBT segment (how much I borrowed from peer's CREDIT line)
  // RED = using peer's credit (actual debt, risky)
  // GREEN = backed by collateral (safe, secured)
  const computeCreditDebtSegment = (derived: DerivedAccountData, isLeft: boolean): number => {
    const delta = derived.delta;
    const iOwe = isLeft ? (delta < 0) : (delta > 0);

    if (!iOwe) return 0; // I don't owe peer

    const debtAmount = Math.abs(delta);

    // SIMPLE RULE: Check if ACCOUNT has collateral
    // If collateral exists and covers the flow → GREEN (collateral-backed, no debt segment)
    // If collateral = 0 or insufficient → RED (credit-backed, show debt)
    if (derived.collateral > 0 && debtAmount <= derived.collateral) {
      // Flow is fully backed by collateral in account → GREEN (no debt segment)
      return 0;
    }

    // Flow uses credit (either no collateral or beyond collateral)
    const creditDebt = Math.max(0, debtAmount - derived.collateral);

    // Only show if peer actually extended credit
    if (creditDebt > 0 && derived.peerCreditLimit > 0) {
      return Math.min(creditDebt, derived.peerCreditLimit);
    }

    return 0;
  };

  const fromDebtSegment = computeCreditDebtSegment(fromDerived, fromIsLeft) * barScale;
  const toDebtSegment = computeCreditDebtSegment(toDerived, !fromIsLeft) * barScale;

  // When peer uses our credit, reduce our outOwnCredit (unused credit) accordingly
  // Delta > 0 for LEFT means RIGHT owes → LEFT's credit is being used by RIGHT
  // Delta < 0 for LEFT means LEFT owes → RIGHT's credit is being used by LEFT
  const computeCreditUsedByPeer = (derived: DerivedAccountData, isLeft: boolean): number => {
    const delta = derived.delta;
    const peerOwes = isLeft ? (delta > 0) : (delta < 0);
    if (peerOwes && derived.ownCreditLimit > 0) {
      // Peer is using our credit. Amount = delta beyond collateral, capped by our credit limit
      const amountBeyondCollateral = Math.max(0, Math.abs(delta) - derived.outCollateral);
      return Math.min(amountBeyondCollateral, derived.ownCreditLimit);
    }
    return 0;
  };

  const fromCreditUsed = computeCreditUsedByPeer(fromDerived, fromIsLeft) * barScale;
  const toCreditUsed = computeCreditUsedByPeer(toDerived, !fromIsLeft) * barScale;

  // HYBRID MODEL (matches AccountPreview.svelte semantics):
  // - Unused credit shows on BORROWER's side (who can use it)
  // - Used credit shows on LENDER's side (who extended it)

  // FROM entity segments (their perspective):
  // LEFT side of FROM bars: what FROM can use
  // - inPeerCredit: credit available FROM peer (unused, on borrower side)
  // - inCollateral: FROM's collateral
  // - inOwnCredit: debt FROM owes (using their credit)

  const fromSegments: AccountSegments = {
    // FROM's LEFT side (what FROM can use):
    inPeerCredit: fromDerived.inPeerCredit * barScale,        // unused credit from peer
    inCollateral: fromDerived.inCollateral * barScale,        // FROM's collateral
    inOwnCredit: fromDebtSegment,                              // debt FROM owes

    // FROM's RIGHT side (not used in spread mode for FROM's bars):
    outOwnCredit: (fromDerived.outOwnCredit * barScale) - fromCreditUsed,
    outCollateral: fromDerived.outCollateral * barScale,
    outPeerCredit: fromDerived.outPeerCredit * barScale
  };

  // TO entity segments (their perspective):
  // LEFT side of TO bars: what TO can use
  // - inPeerCredit: credit available FROM peer (unused, on borrower side)
  // - inCollateral: TO's collateral
  // - inOwnCredit: debt TO owes (using their credit)

  const toSegments: AccountSegments = {
    // TO's LEFT side (what TO can use):
    inPeerCredit: toDerived.inPeerCredit * barScale,          // unused credit from peer
    inCollateral: toDerived.inCollateral * barScale,          // TO's collateral
    inOwnCredit: toDebtSegment,                                // debt TO owes

    // TO's RIGHT side (not used in spread mode for TO's bars):
    outOwnCredit: (toDerived.outOwnCredit * barScale) - toCreditUsed,
    outCollateral: toDerived.outCollateral * barScale,
    outPeerCredit: toDerived.outPeerCredit * barScale
  };

  // Get entity sizes to avoid collision
  const fromEntitySize = getEntitySize(fromEntity.id, tokenId);
  const toEntitySize = getEntitySize(toEntity.id, tokenId);

  if (settings.barsMode === 'spread') {
    renderSpreadMode(
      tokenGroup,
      fromEntity,
      toEntity,
      normalizedDirection,
      fromSegments,
      toSegments,
      barHeight,
      fromEntitySize,
      toEntitySize,
      fromCreditUsed,
      toCreditUsed,
      settings,
      barRadius  // Pass adjusted radius for this token count
    );
  } else {
    renderCloseMode(
      tokenGroup,
      fromEntity,
      toEntity,
      normalizedDirection,
      fromSegments,
      toSegments,
      barHeight,
      fromCreditUsed,
      toCreditUsed,
      settings,
      barRadius  // Pass adjusted radius for this token count
    );
  }

  return tokenGroup;
}

/**
 * Spread mode: each entity's bars extend FROM that entity toward the middle
 * Each entity shows their OWN perspective values on their side
 */
function renderSpreadMode(
  group: THREE.Group,
  fromEntity: EntityData,
  toEntity: EntityData,
  direction: THREE.Vector3,
  fromSegments: AccountSegments,
  toSegments: AccountSegments,
  barHeight: number,
  fromEntitySize: number,
  toEntitySize: number,
  fromCreditUsed: number,
  toCreditUsed: number,
  settings: AccountBarSettings,
  barRadius: number  // Adjusted radius passed from parent
): void {
  const safeGap = 0.2;

  // FROM entity bars - extend from fromEntity toward toEntity
  // Show FROM's perspective: their capacity + credit TO extended that FROM used
  const fromStartPos = fromEntity.position.clone().add(
    direction.clone().normalize().multiplyScalar(fromEntitySize + barRadius + safeGap)
  );

  let fromOffset = 0;
  // FROM's side of account: outOwnCredit → outCollateral → outPeerCredit
  // 1. outOwnCredit = credit FROM can use (extended by peer) - light red
  // 2. outCollateral = FROM's deposited collateral - green
  // 3. outPeerCredit = peer's debt using FROM's credit line - dark red (used credit)
  const fromBarSegments = [
    { length: fromSegments.outOwnCredit, colorType: 'availableCredit' as const, label: 'credit FROM can use' },
    { length: fromSegments.outCollateral, colorType: 'secured' as const, label: 'FROM deposited collateral' },
    { length: fromSegments.outPeerCredit, colorType: 'unsecured' as const, label: 'peer debt (using FROM credit)' }
  ];

  fromBarSegments.forEach((segment) => {
    if (segment.length > 0.01) {
      const bar = createBarCylinder(barRadius, segment.length, BAR_COLORS[segment.colorType], segment.colorType, 'left', settings.bilateralState);
      const barCenter = fromStartPos.clone().add(direction.clone().normalize().multiplyScalar(fromOffset + segment.length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    fromOffset += segment.length;
  });

  // TO entity bars - extend from toEntity toward fromEntity
  // Show TO's perspective: their capacity + credit TO extended that FROM used
  const toStartPos = toEntity.position.clone().sub(
    direction.clone().normalize().multiplyScalar(toEntitySize + barRadius + safeGap)
  );

  let toOffset = 0;
  // TO's side of account: outOwnCredit → outCollateral → outPeerCredit
  // 1. outOwnCredit = credit TO can use (extended by peer) - light red
  // 2. outCollateral = TO's deposited collateral - green
  // 3. outPeerCredit = peer's debt using TO's credit line - dark red (used credit)
  const toBarSegments = [
    { length: toSegments.outOwnCredit, colorType: 'availableCredit' as const, label: 'credit TO can use' },
    { length: toSegments.outCollateral, colorType: 'secured' as const, label: 'TO deposited collateral' },
    { length: toSegments.outPeerCredit, colorType: 'unsecured' as const, label: 'peer debt (using TO credit)' }
  ];

  toBarSegments.forEach((segment) => {
    if (segment.length > 0.01) {
      const bar = createBarCylinder(barRadius, segment.length, BAR_COLORS[segment.colorType], segment.colorType, 'right', settings.bilateralState);
      // Position bars going toward fromEntity (subtract)
      const barCenter = toStartPos.clone().sub(direction.clone().normalize().multiplyScalar(toOffset + segment.length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    toOffset += segment.length;
  });
}

/**
 * Close mode: stacked bars at centerline
 * FROM entity bars | DELTA SEPARATOR | TO entity bars
 */
function renderCloseMode(
  group: THREE.Group,
  fromEntity: EntityData,
  toEntity: EntityData,
  direction: THREE.Vector3,
  fromSegments: AccountSegments,
  toSegments: AccountSegments,
  barHeight: number,
  fromCreditUsed: number,
  toCreditUsed: number,
  settings: AccountBarSettings,
  barRadius: number  // Adjusted radius passed from parent
): void {

  // Same pattern as spread mode: outOwnCredit → outCollateral → outPeerCredit
  const fromBarSegments = [
    { length: fromSegments.outOwnCredit, colorType: 'availableCredit' as const },
    { length: fromSegments.outCollateral, colorType: 'secured' as const },
    { length: fromSegments.outPeerCredit, colorType: 'unsecured' as const }
  ];

  const toBarSegments = [
    { length: toSegments.outOwnCredit, colorType: 'availableCredit' as const },
    { length: toSegments.outCollateral, colorType: 'secured' as const },
    { length: toSegments.outPeerCredit, colorType: 'unsecured' as const }
  ];

  // Calculate total length
  let fromLength = 0;
  let toLength = 0;
  fromBarSegments.forEach(seg => { fromLength += seg.length; });
  toBarSegments.forEach(seg => { toLength += seg.length; });

  const totalLength = fromLength + toLength;
  const centerPoint = fromEntity.position.clone().lerp(toEntity.position, 0.5);
  const startPos = centerPoint.clone().sub(direction.clone().normalize().multiplyScalar(totalLength / 2));

  let currentOffset = 0;

  // FROM entity bars (first half)
  fromBarSegments.forEach((segment) => {
    if (segment.length > 0.01) {
      const bar = createBarCylinder(barRadius, segment.length, BAR_COLORS[segment.colorType], segment.colorType, 'left', settings.bilateralState);
      const barCenter = startPos.clone().add(direction.clone().multiplyScalar(currentOffset + segment.length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    currentOffset += segment.length;
  });

  // Delta separator at center
  const separatorPos = startPos.clone().add(direction.clone().multiplyScalar(currentOffset));
  const separator = createDeltaSeparator(barHeight, direction);
  separator.position.copy(separatorPos);
  group.add(separator);

  // TO entity bars (second half)
  toBarSegments.forEach((segment) => {
    if (segment.length > 0.01) {
      const bar = createBarCylinder(barRadius, segment.length, BAR_COLORS[segment.colorType], segment.colorType, 'right', settings.bilateralState);
      const barCenter = startPos.clone().add(direction.clone().multiplyScalar(currentOffset + segment.length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    currentOffset += segment.length;
  });
}

/**
 * Create a bar cylinder with proper material based on consensus state
 */
function createBarCylinder(
  radius: number,
  length: number,
  color: number,
  colorType: keyof typeof BAR_COLORS,
  barSide: 'left' | 'right',
  bilateralState: AccountBarVisual | null | undefined
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);
  const isUnusedCredit = colorType === 'availableCredit';

  // Bar glow disabled - just show base color (no orange/gold/yellow glow nonsense)
  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity: isUnusedCredit ? 0.2 : 1.0,
    emissive: new THREE.Color(color).multiplyScalar(0.1), // Subtle emissive, same color
    emissiveIntensity: isUnusedCredit ? 0.2 : 0.1,
    wireframe: isUnusedCredit
  });

  const mesh = new THREE.Mesh(geometry, material);

  // Pulsing animation removed - static glow conveys state, no animation needed
  // bilateralState glow colors still used (yellow/blue/red = consensus state)

  return mesh;
}

/**
 * Create yellow disk separator marking delta (zero point)
 */
function createDeltaSeparator(barHeight: number, direction: THREE.Vector3): THREE.Mesh {
  const diskRadius = barHeight * 12; // 3x bigger for visibility
  const diskThickness = barHeight * 0.3; // Very thin for sharp knife appearance

  const geometry = new THREE.CylinderGeometry(diskRadius, diskRadius, diskThickness, 32);
  const material = new THREE.MeshLambertMaterial({
    color: 0xffff00, // YELLOW separator for visibility
    transparent: true,
    opacity: 0.95,
    emissive: 0xffff00,
    emissiveIntensity: 0.5
  });

  const separator = new THREE.Mesh(geometry, material);

  // Align cylinder axis (Y) with line direction so disk face is perpendicular
  const axis = new THREE.Vector3(0, 1, 0);
  const targetAxis = direction.clone().normalize();
  separator.quaternion.setFromUnitVectors(axis, targetAxis);

  return separator;
}

/**
 * Calculate perpendicular vector to entity connection line
 * Used for positioning parallel token bars
 */
function calculatePerpendicularVector(direction: THREE.Vector3): THREE.Vector3 {
  const up = new THREE.Vector3(0, 1, 0);
  let perpendicular = new THREE.Vector3().crossVectors(direction, up).normalize();

  // Edge case: If direction is vertical (parallel to UP), cross product fails
  if (perpendicular.length() < 0.01) {
    const forward = new THREE.Vector3(0, 0, 1);
    perpendicular = new THREE.Vector3().crossVectors(direction, forward).normalize();
  }

  return perpendicular;
}
