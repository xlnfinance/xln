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
import { toDerivedAccountData, type DerivedAccountData } from './derivedAccount';
import { requireTokenDecimals } from '#lib/components/Entity/token-metadata.ts';
import type { Delta } from '@xln/core/api/public/runtime-module';
import { accountAnnotationLines, createAccountAnnotation, type AccountAnnotationContext } from './timeline/accountAnnotation';

/** Minimal endpoint shape the bars need. Structurally satisfied by GraphEntityData. */
export interface BarEndpoint {
  id: string;
  position: THREE.Vector3;
}

export interface AccountBarVisual {
  glowColor: string | null;
  glowSide: string | null;
  glowIntensity: number;
  isDashed: boolean;
  pulseSpeed: number;
}

export interface DisputeInfo {
  startedByLeft: boolean;
  disputeTimeout: number;
  initialNonce: number;
}

export interface AccountBarSettings {
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  /** Thickness multiplier: a projector needs bars that read from the back of the room. */
  barRadiusScale?: number | undefined;
  /**
   * Visual units per token minor unit, by token. A presentation sizes bars to the network on
   * stage instead of the fixed "1M tokens = 10 units" rule; a token absent here draws nothing.
   */
  capacityScale?: ReadonlyMap<number, number> | null | undefined;
  desyncDetected?: boolean | undefined; // Bilateral consensus in progress
  bilateralState?: AccountBarVisual | null | undefined; // Visual state from consensus
  dispute?: DisputeInfo | null | undefined; // Active dispute info
  /** Presentation: state the bars' numbers in words above the account. */
  annotation?: AccountAnnotationContext | null | undefined;
}

export interface AccountSegments {
  outOwnCredit: number;    // our unused credit (pink wireframe)
  inCollateral: number;     // our collateral (green solid)
  outPeerCredit: number;    // their used credit (red wireframe)
  inOwnCredit: number;      // our used credit (red wireframe)
  outCollateral: number;    // their collateral (green solid)
  inPeerCredit: number;     // their unused credit (pink wireframe)
}

/**
 * The wallet's position palette (ui/src/styles/tokens.css): collateral is green, credit in use
 * is violet exposure, credit room nobody has drawn on is a grey ghost.
 */
export const BAR_COLORS = {
  availableCredit: 0xb8c0ce,  // grey - credit room, granted but unused
  secured: 0x22c55e,          // green - collateral
  unsecured: 0xa78bfa         // violet - credit in use (exposure)
} as const;

/** The delta marker: where the balance between the two parties currently sits. */
export const DELTA_MARKER_COLOR = 0xffffff;

/** The translucent sleeve around an account under dispute. */
export const DISPUTE_SLEEVE_COLOR = 0xf26d6d;

/**
 * Create account capacity bars for a bilateral account (multi-token parallel bars)
 * @param parent - Object the bars attach to. MUST be the same object the caller detaches
 *                 them from later (the graph world group), otherwise removal is a no-op
 *                 and every rebuild leaks a bar group into the scene.
 * @param deltas - Map of all token deltas for this account
 * @param fromIsLeft - whether fromEntity is the LEFT entity (smaller entityId)
 * @param xlnFunctions - XLN runtime functions (needed for deriveDelta)
 */
export function createAccountBars(
  parent: THREE.Object3D,
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
  deltas: Map<number, Delta>,
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number,
  xlnFunctions: {
    deriveDelta(delta: Delta, isLeft: boolean): Partial<Record<keyof DerivedAccountData, unknown>>;
    getTokenInfo(tokenId: number): { decimals: number } | undefined;
  } | null | undefined,
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
  const baseRadius = barHeight * 2.5 * (settings.barRadiusScale ?? 1);  // Original barRadius = 0.2
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
    const tokenDecimals = requireTokenDecimals(
      xlnFunctions.getTokenInfo?.(tokenId)?.decimals,
      `token:${tokenId}`,
    );
    const fromDerived = toDerivedAccountData(xlnFunctions.deriveDelta(delta, fromIsLeft));
    const toDerived = toDerivedAccountData(xlnFunctions.deriveDelta(delta, !fromIsLeft));

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
      tokenDecimals,
      adjustedRadius,
    );

    // Apply perpendicular offset to position this token's bars
    tokenBarGroup.position.copy(perpendicularOffset);
    group.add(tokenBarGroup);
  }

  // One dispute indicator per account: the dispute freezes the whole account, every token.
  if (settings.dispute) {
    group.add(createDisputeIndicator(fromEntity, toEntity, settings.dispute.startedByLeft, fromIsLeft, adjustedRadius));
  }

  if (settings.annotation) {
    const [leftId, rightId] = fromIsLeft ? [fromEntity.id, toEntity.id] : [toEntity.id, fromEntity.id];
    const lines = accountAnnotationLines(leftId, rightId, deltas, settings.annotation);
    if (lines.length > 0) {
      // Below the bars: bank names sit above their spheres, so the space under an account is
      // free. On a sloped account, lean toward the higher bank, away from the lower bank's name.
      const slope = toEntity.position.y - fromEntity.position.y;
      const lean = Math.abs(slope) > 4 ? (slope > 0 ? 0.62 : 0.38) : 0.5;
      const anchor = fromEntity.position.clone().lerp(toEntity.position, lean);
      anchor.y -= adjustedRadius * 2.5 + settings.annotation.lineHeight * (lines.length * 0.6 + 0.5);
      group.add(createAccountAnnotation(lines, anchor, settings.annotation.lineHeight));
    }
  }

  parent.add(group);
  return group;
}

/**
 * Create bars for a single token (extracted from original createAccountBars logic)
 */
function createTokenBars(
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
  normalizedDirection: THREE.Vector3,
  fromDerived: DerivedAccountData,
  toDerived: DerivedAccountData,
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number,
  tokenId: number,
  tokenDecimals: number,
  barRadius: number,
): THREE.Group {
  const tokenGroup = new THREE.Group();

  // Scale bars based on token value (1px = $1 invariant), unless the stage supplies its own scale.
  const tokensToVisualUnits = 0.00001; // 1M tokens → 10 visual units
  const barScale = settings.capacityScale
    ? settings.capacityScale.get(tokenId) ?? 0
    : (tokensToVisualUnits / Math.pow(10, tokenDecimals)) * (settings.portfolioScale / 5000);

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
      fromEntitySize,
      toEntitySize,
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
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
  direction: THREE.Vector3,
  fromSegments: AccountSegments,
  toSegments: AccountSegments,
  fromEntitySize: number,
  toEntitySize: number,
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
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
  direction: THREE.Vector3,
  fromSegments: AccountSegments,
  toSegments: AccountSegments,
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

  // Delta separator where the balance sits. A token lane with no capacity has no bar, and a
  // marker floating on nothing would read as a second balance.
  if (totalLength > barRadius) {
    const separatorPos = startPos.clone().add(direction.clone().multiplyScalar(currentOffset));
    const separator = createDeltaSeparator(barRadius, direction);
    separator.position.copy(separatorPos);
    group.add(separator);
  }

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
  _barSide: 'left' | 'right',
  _bilateralState: AccountBarVisual | null | undefined
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 24);
  const isUnusedCredit = colorType === 'availableCredit';

  // Unused credit is room, not value: a translucent solid reads at distance, a wireframe does not.
  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity: isUnusedCredit ? 0.45 : 1.0,
    emissive: new THREE.Color(color).multiplyScalar(isUnusedCredit ? 0.25 : 0.35),
    depthWrite: !isUnusedCredit,
  });

  const mesh = new THREE.Mesh(geometry, material);

  // Pulsing animation removed - static glow conveys state, no animation needed
  // bilateralState glow colors still used (yellow/blue/red = consensus state)

  return mesh;
}

/**
 * The delta marker: a thin disk where the balance sits, sized to the bar it cuts.
 */
function createDeltaSeparator(barRadius: number, direction: THREE.Vector3): THREE.Mesh {
  const diskRadius = barRadius * 1.8;
  const diskThickness = barRadius * 0.35; // Thin for a sharp knife appearance

  const geometry = new THREE.CylinderGeometry(diskRadius, diskRadius, diskThickness, 32);
  const material = new THREE.MeshLambertMaterial({
    color: DELTA_MARKER_COLOR,
    transparent: true,
    opacity: 0.95,
    emissive: DELTA_MARKER_COLOR,
    emissiveIntensity: 0.6
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

/**
 * Create dispute indicator - pulsing red glow around the connection
 * Shows ⚔️ icon near the entity that started the dispute
 */
function createDisputeIndicator(
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
  startedByLeft: boolean,
  fromIsLeft: boolean,
  barRadius: number
): THREE.Group {
  const group = new THREE.Group();

  // Calculate midpoint and direction
  const midpoint = new THREE.Vector3().addVectors(fromEntity.position, toEntity.position).multiplyScalar(0.5);
  const direction = new THREE.Vector3().subVectors(toEntity.position, fromEntity.position);
  const length = direction.length();

  // Create subtle red outline around the connection (not a fat glow)
  const glowGeometry = new THREE.CylinderGeometry(
    barRadius * 1.6,  // Sleeve just outside the bar
    barRadius * 1.6,
    length * 0.9,     // Most of connection
    24,
    1,
    true
  );

  // A translucent sleeve in the wallet's dispute red: the bar stays readable inside it.
  const glowMaterial = new THREE.MeshBasicMaterial({
    color: DISPUTE_SLEEVE_COLOR,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const glowCylinder = new THREE.Mesh(glowGeometry, glowMaterial);
  glowCylinder.position.copy(midpoint);

  // Align cylinder with connection direction
  const axis = new THREE.Vector3(0, 1, 0);
  const targetAxis = direction.clone().normalize();
  glowCylinder.quaternion.setFromUnitVectors(axis, targetAxis);

  // Add pulsing animation data
  glowCylinder.userData = {
    isDisputeGlow: true,
    pulsePhase: 0
  };

  group.add(glowCylinder);

  // Create sword icon ⚔️ near the entity that started the dispute
  const startedByFrom = (startedByLeft && fromIsLeft) || (!startedByLeft && !fromIsLeft);
  const initiatorPos = startedByFrom ? fromEntity.position : toEntity.position;
  const defenderPos = startedByFrom ? toEntity.position : fromEntity.position;

  // Position sword 20% from initiator toward defender, slightly above
  const swordPos = initiatorPos.clone().lerp(defenderPos, 0.2);
  swordPos.y += barRadius * 4;

  // Create sword sprite (small red triangle pointing at defender)
  const swordGeometry = new THREE.ConeGeometry(barRadius * 0.8, barRadius * 2, 4);
  const swordMaterial = new THREE.MeshBasicMaterial({
    color: 0xff3333,
    transparent: true,
    opacity: 0.8
  });
  const sword = new THREE.Mesh(swordGeometry, swordMaterial);
  sword.position.copy(swordPos);

  // Point sword toward defender
  const swordDirection = new THREE.Vector3().subVectors(defenderPos, initiatorPos).normalize();
  sword.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), swordDirection);

  // Add sword marker
  sword.userData = {
    isDisputeSword: true,
    initiator: startedByFrom ? 'from' : 'to'
  };

  group.add(sword);

  // Create shield near defender (optional - shows who is defending)
  const shieldPos = defenderPos.clone().lerp(initiatorPos, 0.2);
  shieldPos.y += barRadius * 4;

  const shieldGeometry = new THREE.SphereGeometry(barRadius * 0.9, 16, 16);
  const shieldMaterial = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.7
  });
  const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
  shield.position.copy(shieldPos);

  shield.userData = {
    isDisputeShield: true,
    defender: startedByFrom ? 'to' : 'from'
  };

  group.add(shield);

  return group;
}
