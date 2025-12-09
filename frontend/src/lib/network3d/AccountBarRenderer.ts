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

export interface AccountBarSettings {
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  selectedTokenId: number;
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
 * Create account capacity bars for a bilateral account
 * @param fromDerived - deriveDelta result from fromEntity's perspective
 * @param toDerived - deriveDelta result from toEntity's perspective
 * @param fromIsLeft - whether fromEntity is the LEFT entity (smaller entityId)
 */
export function createAccountBars(
  scene: THREE.Scene,
  fromEntity: EntityData,
  toEntity: EntityData,
  fromDerived: DerivedAccountData,
  toDerived: DerivedAccountData,
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number
): THREE.Group {
  const group = new THREE.Group();

  // Calculate bar dimensions
  const barHeight = 0.08;
  const direction = new THREE.Vector3().subVectors(toEntity.position, fromEntity.position);
  const normalizedDirection = direction.clone().normalize();

  // Scale bars based on token value (1px = $1 invariant)
  const decimals = 18;
  const tokensToVisualUnits = 0.00001; // 1M tokens → 10 visual units
  const barScale = (tokensToVisualUnits / Math.pow(10, decimals)) * (settings.portfolioScale / 5000);

  // Compute debt not captured by inOwnCredit
  // Delta sign relative to LEFT: delta < 0 = LEFT owes, delta > 0 = RIGHT owes
  // isLeft tells us which side this entity is on
  const computeDebtSegment = (derived: DerivedAccountData, isLeft: boolean): number => {
    const delta = derived.delta;
    const entityOwes = isLeft ? (delta < 0) : (delta > 0);

    if (entityOwes) {
      const debtAmount = Math.abs(delta);
      // If inOwnCredit doesn't show the debt, it's backed by collateral
      if (derived.inOwnCredit === 0 && derived.inCollateral > 0) {
        return Math.min(debtAmount, derived.inCollateral);
      }
      // Or debt is backed by peer's credit toward us (not shown in our inOwnCredit)
      if (derived.inOwnCredit === 0 && derived.inCollateral === 0) {
        // Debt exists but not backed by our collateral or credit - show it
        return debtAmount;
      }
    }
    return 0;
  };

  const fromDebtSegment = computeDebtSegment(fromDerived, fromIsLeft) * barScale;
  const toDebtSegment = computeDebtSegment(toDerived, !fromIsLeft) * barScale;

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

  // Each entity's bars use their own perspective
  // Adjust inCollateral when debt is shown separately
  // Adjust outOwnCredit when peer is using our credit
  const fromSegments: AccountSegments = {
    outOwnCredit: (fromDerived.outOwnCredit * barScale) - fromCreditUsed,
    inCollateral: (fromDerived.inCollateral * barScale) - fromDebtSegment,
    outPeerCredit: fromDerived.outPeerCredit * barScale,
    inOwnCredit: fromDebtSegment > 0 ? fromDebtSegment : (fromDerived.inOwnCredit * barScale),
    outCollateral: fromDerived.outCollateral * barScale,
    inPeerCredit: fromDerived.inPeerCredit * barScale
  };

  const toSegments: AccountSegments = {
    outOwnCredit: (toDerived.outOwnCredit * barScale) - toCreditUsed,
    inCollateral: (toDerived.inCollateral * barScale) - toDebtSegment,
    outPeerCredit: toDerived.outPeerCredit * barScale,
    inOwnCredit: toDebtSegment > 0 ? toDebtSegment : (toDerived.inOwnCredit * barScale),
    outCollateral: toDerived.outCollateral * barScale,
    inPeerCredit: toDerived.inPeerCredit * barScale
  };

  // Get entity sizes to avoid collision
  const fromEntitySize = getEntitySize(fromEntity.id, settings.selectedTokenId);
  const toEntitySize = getEntitySize(toEntity.id, settings.selectedTokenId);

  if (settings.barsMode === 'spread') {
    renderSpreadMode(
      group,
      fromEntity,
      toEntity,
      normalizedDirection,
      fromSegments,
      toSegments,
      barHeight,
      fromEntitySize,
      toEntitySize
    );
  } else {
    renderCloseMode(
      group,
      fromEntity,
      toEntity,
      normalizedDirection,
      fromSegments,
      toSegments,
      barHeight
    );
  }

  scene.add(group);
  return group;
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
  toEntitySize: number
): void {
  const barRadius = barHeight * 2.5;
  const safeGap = 0.2;

  // FROM entity bars - extend from fromEntity toward toEntity
  // Show FROM's perspective: their collateral, their credit usage
  const fromStartPos = fromEntity.position.clone().add(
    direction.clone().normalize().multiplyScalar(fromEntitySize + barRadius + safeGap)
  );

  let fromOffset = 0;
  // Show what fromEntity has and owes
  const fromBars: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'outOwnCredit', colorType: 'availableCredit' },  // their unused credit (pink)
    { key: 'inCollateral', colorType: 'secured' },          // their collateral (green)
    { key: 'inOwnCredit', colorType: 'unsecured' }          // their credit being used / debt (red)
  ];

  fromBars.forEach((barSpec) => {
    const length = fromSegments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      const barCenter = fromStartPos.clone().add(direction.clone().normalize().multiplyScalar(fromOffset + length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    fromOffset += length;
  });

  // TO entity bars - extend from toEntity toward fromEntity
  // Show TO's perspective: their collateral, their credit usage
  const toStartPos = toEntity.position.clone().sub(
    direction.clone().normalize().multiplyScalar(toEntitySize + barRadius + safeGap)
  );

  let toOffset = 0;
  // Show what toEntity has and owes
  const toBars: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'outOwnCredit', colorType: 'availableCredit' },  // their unused credit (pink)
    { key: 'inCollateral', colorType: 'secured' },          // their collateral (green)
    { key: 'inOwnCredit', colorType: 'unsecured' }          // their credit being used / debt (red)
  ];

  toBars.forEach((barSpec) => {
    const length = toSegments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      // Position bars going toward fromEntity (subtract)
      const barCenter = toStartPos.clone().sub(direction.clone().normalize().multiplyScalar(toOffset + length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    toOffset += length;
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
  barHeight: number
): void {
  const barRadius = barHeight * 2.5;

  // Same bar pattern for each entity
  const barPattern: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'outOwnCredit', colorType: 'availableCredit' },  // unused credit (pink)
    { key: 'inCollateral', colorType: 'secured' },          // collateral (green)
    { key: 'inOwnCredit', colorType: 'unsecured' }          // credit being used / debt (red)
  ];

  // Calculate total length
  let fromLength = 0;
  let toLength = 0;
  barPattern.forEach(spec => {
    fromLength += fromSegments[spec.key];
    toLength += toSegments[spec.key];
  });

  const totalLength = fromLength + toLength;
  const centerPoint = fromEntity.position.clone().lerp(toEntity.position, 0.5);
  const startPos = centerPoint.clone().sub(direction.clone().normalize().multiplyScalar(totalLength / 2));

  let currentOffset = 0;

  // FROM entity bars (first half)
  barPattern.forEach((barSpec) => {
    const length = fromSegments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      const barCenter = startPos.clone().add(direction.clone().multiplyScalar(currentOffset + length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());
      group.add(bar);
    }
    currentOffset += length;
  });

  // Delta separator at center
  const separatorPos = startPos.clone().add(direction.clone().multiplyScalar(currentOffset));
  const separator = createDeltaSeparator(barHeight, direction);
  separator.position.copy(separatorPos);
  group.add(separator);

  // TO entity bars (second half)
  barPattern.forEach((barSpec) => {
    const length = toSegments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      const barCenter = startPos.clone().add(direction.clone().multiplyScalar(currentOffset + length/2));
      bar.position.copy(barCenter);

      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());
      group.add(bar);
    }
    currentOffset += length;
  });
}

/**
 * Create a bar cylinder with proper material based on type
 */
function createBarCylinder(
  radius: number,
  length: number,
  color: number,
  colorType: keyof typeof BAR_COLORS
): THREE.Mesh {
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 16);

  // Unused credit: transparent wireframe (unloaded trust - mental clarity)
  // Used credit (red) & Collateral (green): BRIGHT and SOLID (actual value at stake)
  const isUnusedCredit = colorType === 'availableCredit';

  const material = new THREE.MeshLambertMaterial({
    color,
    transparent: true,
    opacity: isUnusedCredit ? 0.2 : 1.0, // Unused: 20% transparent, Used/Collateral: 100% solid
    emissive: new THREE.Color(color).multiplyScalar(isUnusedCredit ? 0.03 : 0.15),
    wireframe: isUnusedCredit, // Only unused credit is wireframe
    emissiveIntensity: isUnusedCredit ? 0.3 : 1.0
  });

  return new THREE.Mesh(geometry, material);
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
