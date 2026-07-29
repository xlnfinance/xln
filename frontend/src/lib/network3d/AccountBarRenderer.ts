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
import { CAPACITY_REGION_ORDER, capacityVector, stageBarFor } from './capacityBar';
import { beginCapacityMotion, type CapacityMotionFrame } from './accountBarMotion';
import { requireTokenDecimals } from '$lib/components/Entity/token-metadata';

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
  initialDisputeNonce: number;
}

export interface AccountBarSettings {
  barsMode: 'close' | 'spread';
  portfolioScale: number;
  desyncDetected?: boolean | undefined; // Bilateral consensus in progress
  bilateralState?: AccountBarVisual | null | undefined; // Visual state from consensus
  dispute?: DisputeInfo | null | undefined; // Active dispute info
  /**
   * Stretch each account's bar across the gap between its two entities instead of scaling
   * it by absolute value.
   *
   * The absolute scale ("1M tokens → 10 units") is what an operator wants: two accounts
   * side by side are comparable at a glance. But bar length and node spacing then have
   * nothing to do with each other, so a $500K account on a 40-unit edge renders as a
   * 5-unit stub whose seven regions cannot be told apart. Filling the edge trades
   * cross-account comparison for being able to read one account at all.
   */
  fitToEdge?: boolean | undefined;
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
 * Two colours carry meaning; the third state carries none on purpose.
 *
 * Green is money — collateral in an account, and the reserves the nodes are made of. Red is
 * credit that has been drawn: someone owes it. Credit that has *not* been drawn is neither,
 * so it gets no hue of its own: a translucent gradient at full volume, showing how far the
 * delta could still travel without claiming any of it is held.
 */
const BAR_COLORS = {
  availableCredit: 0xd7c2cf,  // translucent gradient - room the delta can still travel
  secured: 0x2ee6a8,          // green - collateral posted on the jurisdiction
  unsecured: 0xe24b4a         // red - credit drawn, i.e. debt
} as const;

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
  deltas: Map<number, any>,  // Map<tokenId, Delta>
  fromIsLeft: boolean,
  settings: AccountBarSettings,
  getEntitySize: (entityId: string, tokenId: number) => number,
  xlnFunctions: any  // XLNRuntime interface
): THREE.Group {
  const group = new THREE.Group();

  // Sort tokens for consistent ordering across all accounts.
  //
  // A token lane the account never used has no capacity, no collateral and no delta —
  // nothing to draw except its delta separator, which then floats on the edge as a second
  // marker with no bar behind it. An empty lane is not part of the account's story.
  const sortedTokenIds = Array.from(deltas.keys())
    .filter((tokenId) => accountLaneIsUsed(deltas.get(tokenId)))
    .sort((a, b) => a - b);
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
  // A bar stretched across the edge also has to be thick enough to see from the distance
  // that fits the network on screen. Girth follows the entities it connects, not the edge:
  // tying it to length would make a long edge a pipe and a short one a thread, when both
  // carry the same kind of thing.
  const endpointSize = Math.min(
    getEntitySize(fromEntity.id, sortedTokenIds[0] ?? 1),
    getEntitySize(toEntity.id, sortedTokenIds[0] ?? 1),
  );
  const baseRadius = settings.fitToEdge
    ? Math.max(barHeight * 2.5, endpointSize * 0.62)
    : barHeight * 2.5;  // Original barRadius = 0.2
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
    const tokenBarGroup = settings.fitToEdge
      ? createCanonicalTokenBar({
          fromEntity,
          toEntity,
          fromIsLeft,
          delta,
          tokenId,
          radius: adjustedRadius,
          getEntitySize,
          xlnFunctions,
        })
      : createTokenBars(
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
          barHeight
        );

    // Apply perpendicular offset to position this token's bars
    tokenBarGroup.position.copy(perpendicularOffset);
    group.add(tokenBarGroup);
  }

  parent.add(group);
  return group;
}

/**
 * One account, laid out by the invariant and free to move.
 *
 * Regions come straight from `stageBarFor` — the same numbers the 2D stage draws and the
 * runtime's own ASCII prints — so the bar cannot drift from the maths. Every segment is a
 * unit cylinder scaled along the edge, which makes a reallocation a change of scale and
 * position rather than a rebuild: the separator slides toward whoever paid and the shares
 * on each side follow it.
 */
function createCanonicalTokenBar(params: {
  fromEntity: BarEndpoint;
  toEntity: BarEndpoint;
  fromIsLeft: boolean;
  delta: unknown;
  tokenId: number;
  radius: number;
  getEntitySize: (entityId: string, tokenId: number) => number;
  xlnFunctions: { deriveDelta: (delta: unknown, isLeft: boolean) => unknown };
}): THREE.Group {
  const group = new THREE.Group();
  const bar = stageBarFor(params.xlnFunctions.deriveDelta(params.delta, true) as never);
  if (bar.total <= 0n) return group;

  // The canonical axis runs from LEFT to RIGHT, whichever way the edge was handed to us.
  const leftEntity = params.fromIsLeft ? params.fromEntity : params.toEntity;
  const rightEntity = params.fromIsLeft ? params.toEntity : params.fromEntity;
  const axis = new THREE.Vector3().subVectors(rightEntity.position, leftEntity.position);
  const axisLength = axis.length();
  if (axisLength <= 0) return group;
  const direction = axis.clone().normalize();
  const leftSize = params.getEntitySize(leftEntity.id, params.tokenId);
  const rightSize = params.getEntitySize(rightEntity.id, params.tokenId);
  const span = Math.max(0.001, axisLength - leftSize - rightSize - 1.6);
  const origin = leftEntity.position.clone().addScaledVector(direction, leftSize + 0.8);
  const alignment = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction);

  const segments = CAPACITY_REGION_ORDER.map((kind) => {
    const isCredit = kind === 'ownCreditFree' || kind === 'peerCreditFree';
    const isDrawn = kind === 'ownCreditDrawn' || kind === 'peerCreditDrawn';
    const geometry = new THREE.CylinderGeometry(params.radius, params.radius, 1, 16, 1);
    if (isCredit) applyCreditGradient(geometry, kind === 'ownCreditFree' ? 'left' : 'right');
    const material = isCredit
      ? new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.42, depthWrite: false })
      : new THREE.MeshLambertMaterial({
          color: isDrawn ? BAR_COLORS.unsecured : BAR_COLORS.secured,
          emissive: new THREE.Color(isDrawn ? BAR_COLORS.unsecured : BAR_COLORS.secured).multiplyScalar(0.1),
          emissiveIntensity: 0.1,
        });
    const mesh = new THREE.Mesh(geometry, material);
    mesh.quaternion.copy(alignment);
    mesh.userData['regionKind'] = kind;
    group.add(mesh);
    return { kind, mesh, material, isDrawn };
  });

  const separator = createDeltaSeparator(params.radius / 2.5, direction);
  group.add(separator);

  const apply = (frame: CapacityMotionFrame): void => {
    let cursor = 0;
    segments.forEach((segment, index) => {
      const size = frame.vector.sizes[index] ?? 0;
      const length = size * span;
      segment.mesh.visible = length > 0.004;
      segment.mesh.scale.set(1, Math.max(length, 0.0001), 1);
      segment.mesh.position.copy(origin).addScaledVector(direction, cursor + length / 2);
      if (segment.isDrawn) {
        // Strain, not alarm: a line barely touched sits still, one near its limit breathes.
        const strain = segment.kind === 'ownCreditDrawn' ? frame.strain.own : frame.strain.peer;
        segment.material.emissiveIntensity = 0.1 + strain * 0.9 * (0.55 + 0.45 * Math.sin(Date.now() / (420 - strain * 240)));
      }
      cursor += length;
    });
    separator.position.copy(origin).addScaledVector(direction, frame.vector.markerAt * span);
  };

  const accountKey = `${leftEntity.id}|${rightEntity.id}|${params.tokenId}`;
  apply(beginCapacityMotion(accountKey, capacityVector(bar), Date.now(), apply));
  return group;
}

/**
 * Has this token lane ever been used?
 *
 * Reads the stored delta rather than a derived view: collateral, either credit limit, or a
 * non-zero balance each mean the lane carries state worth showing.
 */
function accountLaneIsUsed(delta: unknown): boolean {
  if (!delta || typeof delta !== 'object') return false;
  const lane = delta as Record<string, unknown>;
  const amount = (key: string): bigint => {
    const value = lane[key];
    return typeof value === 'bigint' ? (value < 0n ? -value : value) : 0n;
  };
  return (
    amount('collateral') > 0n ||
    amount('leftCreditLimit') > 0n ||
    amount('rightCreditLimit') > 0n ||
    amount('ondelta') > 0n ||
    amount('offdelta') > 0n
  );
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
  barHeight: number
): THREE.Group {
  const tokenGroup = new THREE.Group();

  // Get entity sizes to avoid collision, and to know how much room the bar actually has.
  const fromEntitySize = getEntitySize(fromEntity.id, tokenId);
  const toEntitySize = getEntitySize(toEntity.id, tokenId);

  // Scale bars based on token value (1px = $1 invariant)
  const tokensToVisualUnits = 0.00001; // 1M tokens → 10 visual units
  const absoluteScale = (tokensToVisualUnits / Math.pow(10, tokenDecimals)) * (settings.portfolioScale / 5000);
  /**
   * Everything the bar is made of, before scaling. Both sides together span the account's
   * whole capacity, so this is what has to fit between the two entities.
   */
  const rawSpan =
    fromDerived.outOwnCredit + fromDerived.outCollateral + fromDerived.outPeerCredit +
    toDerived.outOwnCredit + toDerived.outCollateral + toDerived.outPeerCredit;
  const edgeSpan = Math.max(
    0,
    fromEntity.position.distanceTo(toEntity.position) - fromEntitySize - toEntitySize - 1.6,
  );
  const barScale = settings.fitToEdge && rawSpan > 0 && edgeSpan > 0
    ? edgeSpan / rawSpan
    : absoluteScale;

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

  // Add dispute indicator if active dispute exists
  if (settings.dispute) {
    const disputeIndicator = createDisputeIndicator(
      fromEntity,
      toEntity,
      settings.dispute.startedByLeft,
      fromIsLeft,
      barRadius
    );
    tokenGroup.add(disputeIndicator);
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
  fromEntity: BarEndpoint,
  toEntity: BarEndpoint,
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
  const isUnusedCredit = colorType === 'availableCredit';
  // Undrawn credit keeps its full volume: it is how far the delta can still travel, and
  // shrinking it would understate the room the account actually has. What changes is the
  // material — a translucent gradient that fades toward the far end, so the eye reads
  // "possible" instead of "held" without spending a third colour on it. The old wireframe
  // read as a rendering artefact and fought the two colours that carry meaning.
  const geometry = new THREE.CylinderGeometry(radius, radius, length, 16, 1);
  if (isUnusedCredit) applyCreditGradient(geometry, barSide);

  const material = isUnusedCredit
    ? new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent: true,
        opacity: 0.42,
        depthWrite: false,
      })
    : new THREE.MeshLambertMaterial({
        color,
        transparent: true,
        opacity: 1.0,
        emissive: new THREE.Color(color).multiplyScalar(0.1), // Subtle emissive, same color
        emissiveIntensity: 0.1,
      });

  const mesh = new THREE.Mesh(geometry, material);

  // Pulsing animation removed - static glow conveys state, no animation needed
  // bilateralState glow colors still used (yellow/blue/red = consensus state)

  return mesh;
}

/** Where undrawn credit is nearest to being used, and where it fades out. */
const CREDIT_NEAR = new THREE.Color(0xd7c2cf);
const CREDIT_FAR = new THREE.Color(0x2d2731);

/**
 * Fade an undrawn-credit segment along its own axis.
 *
 * Bright where it meets the money — the end the delta would reach first — and falling away
 * toward the limit, which is the part least likely to ever be used. The two ends are
 * mirrored per side so both halves of an account fade outward from the middle rather than
 * both fading the same way.
 */
function applyCreditGradient(geometry: THREE.CylinderGeometry, barSide: 'left' | 'right'): void {
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  let minY = Infinity;
  let maxY = -Infinity;
  for (let index = 0; index < position.count; index += 1) {
    const y = position.getY(index);
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const span = maxY - minY || 1;
  const shade = new THREE.Color();
  for (let index = 0; index < position.count; index += 1) {
    const along = (position.getY(index) - minY) / span;
    const toward = barSide === 'left' ? along : 1 - along;
    shade.copy(CREDIT_FAR).lerp(CREDIT_NEAR, toward);
    colors[index * 3] = shade.r;
    colors[index * 3 + 1] = shade.g;
    colors[index * 3 + 2] = shade.b;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/**
 * The delta: the one cut that divides the account.
 *
 * White, not a colour — it is not a kind of money, it is the line telling you which side
 * of the pipe belongs to whom. A hue here would compete with the two that carry meaning.
 */
function createDeltaSeparator(barHeight: number, direction: THREE.Vector3): THREE.Mesh {
  const diskRadius = barHeight * 12; // 3x bigger for visibility
  const diskThickness = barHeight * 0.3; // Very thin for sharp knife appearance

  const geometry = new THREE.CylinderGeometry(diskRadius, diskRadius, diskThickness, 32);
  const material = new THREE.MeshLambertMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.95,
    emissive: 0xffffff,
    emissiveIntensity: 0.35
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
    barRadius * 1.3,  // Subtle outer glow, just slightly larger than bar
    barRadius * 1.3,
    length * 0.9,     // Most of connection
    8,
    1,
    true  // Open-ended wireframe look
  );

  const glowMaterial = new THREE.MeshBasicMaterial({
    color: 0xff2222,
    transparent: true,
    opacity: 0.15,
    side: THREE.DoubleSide,
    wireframe: true  // Wireframe for subtle danger zone look
  });

  const glowCylinder = new THREE.Mesh(glowGeometry, glowMaterial);
  glowCylinder.position.copy(midpoint);

  // Align cylinder with connection direction
  const axis = new THREE.Vector3(0, 1, 0);
  const targetAxis = direction.clone().normalize();
  glowCylinder.quaternion.setFromUnitVectors(axis, targetAxis);

  // Add pulsing animation data
  (glowCylinder as any).userData = {
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
  (sword as any).userData = {
    isDisputeSword: true,
    initiator: startedByFrom ? 'from' : 'to'
  };

  group.add(sword);

  // Create shield near defender (optional - shows who is defending)
  const shieldPos = defenderPos.clone().lerp(initiatorPos, 0.2);
  shieldPos.y += barRadius * 4;

  const shieldGeometry = new THREE.SphereGeometry(barRadius * 1.5, 8, 8);
  const shieldMaterial = new THREE.MeshBasicMaterial({
    color: 0x4488ff,
    transparent: true,
    opacity: 0.7
  });
  const shield = new THREE.Mesh(shieldGeometry, shieldMaterial);
  shield.position.copy(shieldPos);

  (shield as any).userData = {
    isDisputeShield: true,
    defender: startedByFrom ? 'to' : 'from'
  };

  group.add(shield);

  return group;
}
