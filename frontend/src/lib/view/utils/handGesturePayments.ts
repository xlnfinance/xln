/**
 * Hand Gesture Payment System for Vision Pro
 * Drag entities with hands to send payments
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import * as THREE from 'three';

export interface HandGestureState {
  isGrabbing: boolean;
  grabbedEntity: string | null;
  handPosition: THREE.Vector3 | null;
}

export class HandGesturePaymentController {
  private scene: THREE.Scene;
  private camera: THREE.Camera;
  private raycaster: THREE.Raycaster;
  private entities: any[];
  private onPaymentTrigger: (from: string, to: string) => void;

  private leftHand: HandGestureState = {
    isGrabbing: false,
    grabbedEntity: null,
    handPosition: null
  };

  private rightHand: HandGestureState = {
    isGrabbing: false,
    grabbedEntity: null,
    handPosition: null
  };

  constructor(
    scene: THREE.Scene,
    camera: THREE.Camera,
    entities: any[],
    onPaymentTrigger: (from: string, to: string) => void
  ) {
    this.scene = scene;
    this.camera = camera;
    this.raycaster = new THREE.Raycaster();
    this.entities = entities;
    this.onPaymentTrigger = onPaymentTrigger;
  }

  /**
   * Update hand tracking (call every frame in VR mode)
   */
  update(session: any) {
    if (!session || !session.inputSources) return;

    for (const source of session.inputSources) {
      if (source.hand) {
        this.processHandInput(source.hand, source.handedness);
      }
    }
  }

  private processHandInput(hand: any, handedness: 'left' | 'right') {
    const handState = handedness === 'left' ? this.leftHand : this.rightHand;

    // Get index finger tip + thumb tip positions
    const indexTip = hand.get('index-finger-tip');
    const thumbTip = hand.get('thumb-tip');

    if (!indexTip || !thumbTip) return;

    // Check pinch gesture (index + thumb close together)
    const indexPos = new THREE.Vector3().setFromMatrixPosition(indexTip.transform.matrix);
    const thumbPos = new THREE.Vector3().setFromMatrixPosition(thumbTip.transform.matrix);
    const pinchDistance = indexPos.distanceTo(thumbPos);

    const isPinching = pinchDistance < 0.03; // 3cm threshold

    // Grabbing logic
    if (isPinching && !handState.isGrabbing) {
      // Start grab: raycast from hand to find entity
      this.raycaster.setFromCamera(
        new THREE.Vector2(0, 0), // Center of hand
        this.camera
      );

      const intersects = this.raycaster.intersectObjects(
        this.entities.map(e => e.mesh),
        false
      );

      const firstIntersect = intersects[0];
      if (firstIntersect) {
        const entity = this.entities.find(e => e.mesh === firstIntersect.object);
        if (entity) {
          handState.isGrabbing = true;
          handState.grabbedEntity = entity.id;
          handState.handPosition = indexPos.clone();
          console.log(`[HandGesture] Grabbed: ${entity.id.slice(-4)}`);

          // Visual feedback: scale up entity
          entity.mesh.scale.multiplyScalar(1.2);
        }
      }
    }

    if (!isPinching && handState.isGrabbing) {
      // Release: check if over another entity
      const grabbedEntityId = handState.grabbedEntity;

      this.raycaster.setFromCamera(
        new THREE.Vector2(0, 0),
        this.camera
      );

      const intersects = this.raycaster.intersectObjects(
        this.entities.map(e => e.mesh),
        false
      );

      const targetIntersect = intersects[0];
      if (targetIntersect) {
        const targetEntity = this.entities.find(e => e.mesh === targetIntersect.object);

        if (targetEntity && grabbedEntityId && targetEntity.id !== grabbedEntityId) {
          // Trigger payment!
          console.log(`[HandGesture] Payment: ${grabbedEntityId.slice(-4)} → ${targetEntity.id.slice(-4)}`);
          this.onPaymentTrigger(grabbedEntityId, targetEntity.id);
        }
      }

      // Reset grab state
      const grabbedEntity = this.entities.find(e => e.id === grabbedEntityId);
      if (grabbedEntity) {
        grabbedEntity.mesh.scale.divideScalar(1.2);
      }

      handState.isGrabbing = false;
      handState.grabbedEntity = null;
      handState.handPosition = null;
    }

    // Update hand position during drag
    if (handState.isGrabbing) {
      handState.handPosition = indexPos.clone();
    }
  }

  /**
   * Get current drag line (for visual feedback)
   */
  getDragLine(): { from: THREE.Vector3, to: THREE.Vector3 } | null {
    const hand = this.leftHand.isGrabbing ? this.leftHand :
                 this.rightHand.isGrabbing ? this.rightHand : null;

    if (!hand || !hand.grabbedEntity || !hand.handPosition) return null;

    const entity = this.entities.find(e => e.id === hand.grabbedEntity);
    if (!entity) return null;

    return {
      from: entity.position.clone(),
      to: hand.handPosition.clone()
    };
  }
}
