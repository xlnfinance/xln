/**
 * Network 3D Types - Shared interfaces for entity/account visualization
 */

import * as THREE from 'three';

export interface EntityData {
  id: string;
  position: THREE.Vector3;
  mesh: THREE.Mesh;
  label: THREE.Sprite | undefined;
  profile: any | undefined;
  isHub: boolean | undefined;
  pulsePhase: number | undefined;
  lastActivity: number | undefined;
  isPinned: boolean | undefined;
  isHovered: boolean | undefined;
  isDragging: boolean | undefined;
  activityRing: THREE.Mesh | null | undefined;
  hubConnectedIds: Set<string> | undefined;
}

export interface AccountConnectionData {
  fromEntityId: string;
  toEntityId: string;
  line: THREE.Line;
  progressBars: THREE.Group | undefined;
  account: any | undefined; // AccountMachine from replica state
}

export interface DerivedAccountData {
  delta: number;
  totalCapacity: number;
  ownCreditLimit: number;
  peerCreditLimit: number;
  inCapacity: number;
  outCapacity: number;
  collateral: number;
  // 7-region visualization fields
  outOwnCredit: number;      // our unused credit
  inCollateral: number;      // our collateral
  outPeerCredit: number;     // their used credit
  inOwnCredit: number;       // our used credit
  outCollateral: number;     // their collateral
  inPeerCredit: number;      // their unused credit
}

export interface LayoutPosition {
  x: number;
  y: number;
  z: number;
}
