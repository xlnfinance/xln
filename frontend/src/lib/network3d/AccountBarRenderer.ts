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
 */
export function createAccountBars(
  scene: THREE.Scene,
  fromEntity: EntityData,
  toEntity: EntityData,
  derived: DerivedAccountData,
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

  const segments: AccountSegments = {
    outOwnCredit: derived.outOwnCredit * barScale,
    inCollateral: derived.inCollateral * barScale,
    outPeerCredit: derived.outPeerCredit * barScale,
    inOwnCredit: derived.inOwnCredit * barScale,
    outCollateral: derived.outCollateral * barScale,
    inPeerCredit: derived.inPeerCredit * barScale
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
      segments,
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
      segments,
      barHeight
    );
  }

  scene.add(group);
  return group;
}

/**
 * Spread mode: bars extend FROM each entity toward middle with gap
 */
function renderSpreadMode(
  group: THREE.Group,
  fromEntity: EntityData,
  _toEntity: EntityData,
  direction: THREE.Vector3,
  segments: AccountSegments,
  barHeight: number,
  fromEntitySize: number,
  _toEntitySize: number
): void {
  const barRadius = barHeight * 2.5;
  const safeGap = 0.2; // Small gap between entity surface and bar
  const minGapSpread = 2; // Gap in middle

  // Left-side bars extend from left entity rightward
  const leftStartPos = fromEntity.position.clone().add(
    direction.clone().normalize().multiplyScalar(fromEntitySize + barRadius + safeGap)
  );

  let leftOffset = 0;
  const leftBars: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'outOwnCredit', colorType: 'availableCredit' },  // Our unused (pink) - closest to entity
    { key: 'inCollateral', colorType: 'secured' },          // Our collateral (green) - middle
    { key: 'outPeerCredit', colorType: 'unsecured' }        // Their used (red) - closest to gap
  ];

  leftBars.forEach((barSpec) => {
    const length = segments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      const barCenter = leftStartPos.clone().add(direction.clone().normalize().multiplyScalar(leftOffset + length/2));
      bar.position.copy(barCenter);

      // Rotate cylinder to align with connection direction
      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    leftOffset += length;
  });

  // Right-side bars extend from right entity LEFTWARD toward gap
  const rightStartPos = _toEntity.position.clone().sub(
    direction.clone().normalize().multiplyScalar(_toEntitySize + barRadius + safeGap)
  );

  let rightOffset = 0;
  const rightBars: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'inPeerCredit', colorType: 'availableCredit' },  // Their unused (pink) - closest to entity
    { key: 'outCollateral', colorType: 'secured' },         // Their collateral (green) - middle
    { key: 'inOwnCredit', colorType: 'unsecured' }          // Our used (red) - closest to gap
  ];

  rightBars.forEach((barSpec) => {
    const length = segments[barSpec.key];
    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      // Position bars going LEFTWARD from right entity toward gap
      const barCenter = rightStartPos.clone().sub(direction.clone().normalize().multiplyScalar(rightOffset + length/2));
      bar.position.copy(barCenter);

      // Rotate cylinder to align with connection direction
      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }
    rightOffset += length;
  });
}

/**
 * Close mode: 7-region stack at centerline with yellow delta separator
 */
function renderCloseMode(
  group: THREE.Group,
  fromEntity: EntityData,
  toEntity: EntityData,
  direction: THREE.Vector3,
  segments: AccountSegments,
  barHeight: number
): void {
  const barRadius = barHeight * 2.5;
  const totalBarsLength =
    segments.outOwnCredit + segments.inCollateral + segments.outPeerCredit +
    segments.inOwnCredit + segments.outCollateral + segments.inPeerCredit;

  const centerPoint = fromEntity.position.clone().lerp(toEntity.position, 0.5);
  const halfBarsLength = totalBarsLength / 2;
  const startPos = centerPoint.clone().sub(direction.clone().normalize().multiplyScalar(halfBarsLength));

  let currentOffset = 0;
  const barOrder: Array<{key: keyof AccountSegments, colorType: keyof typeof BAR_COLORS}> = [
    { key: 'outOwnCredit', colorType: 'availableCredit' },  // our unused credit - light red
    { key: 'inCollateral', colorType: 'secured' },          // our collateral - green
    { key: 'outPeerCredit', colorType: 'unsecured' },       // their used credit - red
    // DELTA SEPARATOR HERE (index 2)
    { key: 'inOwnCredit', colorType: 'unsecured' },         // our used credit - red
    { key: 'outCollateral', colorType: 'secured' },         // their collateral - green
    { key: 'inPeerCredit', colorType: 'availableCredit' }   // their unused credit - light red
  ];

  barOrder.forEach((barSpec, index) => {
    const length = segments[barSpec.key];

    if (length > 0.01) {
      const bar = createBarCylinder(barRadius, length, BAR_COLORS[barSpec.colorType], barSpec.colorType);
      const barCenter = startPos.clone().add(direction.clone().multiplyScalar(currentOffset + length/2));
      bar.position.copy(barCenter);

      // Rotate cylinder to align with connection direction
      const axis = new THREE.Vector3(0, 1, 0);
      bar.quaternion.setFromUnitVectors(axis, direction.clone().normalize());

      group.add(bar);
    }

    currentOffset += length;

    // Add delta separator after outPeerCredit (index 2)
    if (index === 2) {
      const separatorPos = startPos.clone().add(direction.clone().multiplyScalar(currentOffset));
      const separator = createDeltaSeparator(barHeight, direction);
      separator.position.copy(separatorPos);
      group.add(separator);
    }
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
