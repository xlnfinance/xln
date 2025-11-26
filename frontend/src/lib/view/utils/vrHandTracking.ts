/**
 * VR Hand Tracking System
 * Supports Vision Pro (passthrough) and Quest (mesh hands)
 *
 * @license AGPL-3.0
 */

import * as THREE from 'three';
import { XRHandModelFactory } from 'three/examples/jsm/webxr/XRHandModelFactory.js';

// ============================================================================
// TYPES
// ============================================================================

export interface HandState {
  isPinching: boolean;
  pinchStartPos: THREE.Vector3 | null;
  grabbedEntityId: string | null;
  indexTipPos: THREE.Vector3;
  thumbTipPos: THREE.Vector3;
}

export interface GrabbableEntity {
  id: string;
  mesh: THREE.Mesh;
  position: THREE.Vector3;
  isPinned?: boolean;
  label?: THREE.Object3D;
}

export interface HandTrackingCallbacks {
  onGrab: (entityId: string, handedness: 'left' | 'right') => void;
  onRelease: (entityId: string, targetEntityId: string | null, handedness: 'left' | 'right') => void;
  onHover: (entityId: string | null, handedness: 'left' | 'right') => void;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const PINCH_THRESHOLD = 0.025;  // 2.5cm between index and thumb = pinching
const GRAB_RADIUS = 0.15;       // 15cm grab radius (scene is scaled in VR)
const HOVER_RADIUS = 0.20;      // 20cm hover detection radius

// ============================================================================
// HAND TRACKING CONTROLLER
// ============================================================================

export class VRHandTrackingController {
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private callbacks: HandTrackingCallbacks;

  // Device detection
  private isVisionPro = false;
  private handModelFactory: XRHandModelFactory | null = null;

  // Hand objects
  private leftHand: any = null;
  private rightHand: any = null;
  private leftHandModel: any = null;
  private rightHandModel: any = null;

  // Hand states
  private leftState: HandState = this.createHandState();
  private rightState: HandState = this.createHandState();

  // Entity reference (updated externally)
  private entities: GrabbableEntity[] = [];

  // Hover state for visual feedback
  private leftHoveredEntityId: string | null = null;
  private rightHoveredEntityId: string | null = null;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    callbacks: HandTrackingCallbacks
  ) {
    this.renderer = renderer;
    this.scene = scene;
    this.callbacks = callbacks;
  }

  // --------------------------------------------------------------------------
  // INITIALIZATION
  // --------------------------------------------------------------------------

  init(): void {
    this.detectDevice();
    this.setupHands();
    console.log(`🖐️ Hand tracking: ${this.isVisionPro ? 'Vision Pro (passthrough)' : 'Quest (mesh rendering)'}`);
  }

  private detectDevice(): void {
    const ua = navigator.userAgent.toLowerCase();
    this.isVisionPro = ua.includes('apple') || ua.includes('vision');

    // Safari detection for Vision Pro
    if (!this.isVisionPro) {
      const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
      if (isSafari) this.isVisionPro = true;
    }

    // Quest needs hand mesh rendering
    if (!this.isVisionPro) {
      this.handModelFactory = new XRHandModelFactory();
    }
  }

  private setupHands(): void {
    this.leftHand = this.renderer.xr.getHand(0);
    this.rightHand = this.renderer.xr.getHand(1);

    if (this.leftHand) {
      this.scene.add(this.leftHand);
      if (this.handModelFactory) {
        this.leftHandModel = this.handModelFactory.createHandModel(this.leftHand, 'mesh');
        this.leftHand.add(this.leftHandModel);
      }
    }

    if (this.rightHand) {
      this.scene.add(this.rightHand);
      if (this.handModelFactory) {
        this.rightHandModel = this.handModelFactory.createHandModel(this.rightHand, 'mesh');
        this.rightHand.add(this.rightHandModel);
      }
    }
  }

  private createHandState(): HandState {
    return {
      isPinching: false,
      pinchStartPos: null,
      grabbedEntityId: null,
      indexTipPos: new THREE.Vector3(),
      thumbTipPos: new THREE.Vector3(),
    };
  }

  // --------------------------------------------------------------------------
  // UPDATE LOOP
  // --------------------------------------------------------------------------

  update(entities: GrabbableEntity[]): void {
    this.entities = entities;

    this.updateHand(this.leftHand, this.leftState, 'left');
    this.updateHand(this.rightHand, this.rightState, 'right');
  }

  private updateHand(hand: any, state: HandState, handedness: 'left' | 'right'): void {
    if (!hand?.joints) return;

    const indexTip = hand.joints['index-finger-tip'];
    const thumbTip = hand.joints['thumb-tip'];
    if (!indexTip || !thumbTip) return;

    // Update finger positions
    state.indexTipPos.setFromMatrixPosition(indexTip.matrixWorld);
    state.thumbTipPos.setFromMatrixPosition(thumbTip.matrixWorld);

    // Detect pinch
    const pinchDist = state.indexTipPos.distanceTo(state.thumbTipPos);
    const isPinching = pinchDist < PINCH_THRESHOLD;

    // State transitions
    if (isPinching && !state.isPinching) {
      this.onPinchStart(state, handedness);
    } else if (!isPinching && state.isPinching) {
      this.onPinchEnd(state, handedness);
    }

    // Update grabbed entity position
    if (state.isPinching && state.grabbedEntityId) {
      this.updateGrabbedEntity(state);
    }

    // Update hover state (only when not grabbing)
    if (!state.isPinching) {
      this.updateHover(state, handedness);
    }
  }

  // --------------------------------------------------------------------------
  // PINCH HANDLING
  // --------------------------------------------------------------------------

  private onPinchStart(state: HandState, handedness: 'left' | 'right'): void {
    state.isPinching = true;
    state.pinchStartPos = state.indexTipPos.clone();

    // Find nearest entity within grab radius
    const entity = this.findNearestEntity(state.indexTipPos, GRAB_RADIUS);
    if (entity) {
      state.grabbedEntityId = entity.id;
      this.callbacks.onGrab(entity.id, handedness);
    }
  }

  private onPinchEnd(state: HandState, handedness: 'left' | 'right'): void {
    const grabbedId = state.grabbedEntityId;

    if (grabbedId) {
      // Check if released near another entity (payment trigger)
      const targetEntity = this.findNearestEntity(
        state.indexTipPos,
        GRAB_RADIUS,
        grabbedId // exclude grabbed entity
      );

      this.callbacks.onRelease(
        grabbedId,
        targetEntity?.id ?? null,
        handedness
      );
    }

    // Reset state
    state.isPinching = false;
    state.pinchStartPos = null;
    state.grabbedEntityId = null;
  }

  private updateGrabbedEntity(state: HandState): void {
    const entity = this.entities.find(e => e.id === state.grabbedEntityId);
    if (!entity) return;

    entity.mesh.position.copy(state.indexTipPos);
    entity.position.copy(state.indexTipPos);

    if (entity.label) {
      entity.label.position.copy(state.indexTipPos);
      entity.label.position.y += 0.05;
    }
  }

  // --------------------------------------------------------------------------
  // HOVER DETECTION
  // --------------------------------------------------------------------------

  private updateHover(state: HandState, handedness: 'left' | 'right'): void {
    const hoveredRef = handedness === 'left' ? 'leftHoveredEntityId' : 'rightHoveredEntityId';
    const prevHovered = this[hoveredRef];

    const entity = this.findNearestEntity(state.indexTipPos, HOVER_RADIUS);
    const newHovered = entity?.id ?? null;

    if (newHovered !== prevHovered) {
      this[hoveredRef] = newHovered;
      this.callbacks.onHover(newHovered, handedness);
    }
  }

  // --------------------------------------------------------------------------
  // HELPERS
  // --------------------------------------------------------------------------

  private findNearestEntity(
    position: THREE.Vector3,
    maxRadius: number,
    excludeId?: string
  ): GrabbableEntity | null {
    let nearest: GrabbableEntity | null = null;
    let nearestDist = maxRadius;

    for (const entity of this.entities) {
      if (excludeId && entity.id === excludeId) continue;

      const dist = entity.mesh.position.distanceTo(position);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = entity;
      }
    }

    return nearest;
  }

  // --------------------------------------------------------------------------
  // GETTERS
  // --------------------------------------------------------------------------

  getGrabbedEntityId(handedness: 'left' | 'right'): string | null {
    const state = handedness === 'left' ? this.leftState : this.rightState;
    return state.grabbedEntityId;
  }

  getHoveredEntityId(handedness: 'left' | 'right'): string | null {
    return handedness === 'left' ? this.leftHoveredEntityId : this.rightHoveredEntityId;
  }

  isDeviceVisionPro(): boolean {
    return this.isVisionPro;
  }

  // --------------------------------------------------------------------------
  // CLEANUP
  // --------------------------------------------------------------------------

  dispose(): void {
    if (this.leftHand) {
      this.scene.remove(this.leftHand);
      if (this.leftHandModel) {
        this.leftHand.remove(this.leftHandModel);
      }
    }

    if (this.rightHand) {
      this.scene.remove(this.rightHand);
      if (this.rightHandModel) {
        this.rightHand.remove(this.rightHandModel);
      }
    }

    this.leftHand = null;
    this.rightHand = null;
    this.leftHandModel = null;
    this.rightHandModel = null;
    this.handModelFactory = null;
  }
}
