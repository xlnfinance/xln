/**
 * VRHammer - Settlement Court Tool
 *
 * Interactive VR tool for disputing accounts:
 * - Visualized as a gavel/hammer mesh attached to controller
 * - Punch/tap accounts to trigger disputes
 * - Fragments network, payments reroute around disputed accounts
 * - Visual feedback: account connection turns red and breaks
 */

import * as THREE from 'three';

export interface HammerHitEvent {
  type: 'account-dispute';
  fromEntityId: string;
  toEntityId: string;
  timestamp: number;
}

export class VRHammer {
  private hammerMesh: THREE.Group | null = null;
  private controller: THREE.XRTargetRaySpace | null = null;
  private onHit: ((event: HammerHitEvent) => void) | null = null;

  // Hit detection
  private raycaster = new THREE.Raycaster();
  private lastHitTime = 0;
  private hitCooldown = 500; // ms between hits

  constructor() {
    this.createHammerMesh();
  }

  /**
   * Create 3D gavel mesh
   */
  private createHammerMesh() {
    const group = new THREE.Group();

    // Handle (brown wood)
    const handleGeometry = new THREE.CylinderGeometry(0.02, 0.02, 0.3, 8);
    const handleMaterial = new THREE.MeshLambertMaterial({
      color: 0x8b4513,
      emissive: 0x8b4513,
      emissiveIntensity: 0.2
    });
    const handle = new THREE.Mesh(handleGeometry, handleMaterial);
    handle.position.y = -0.15;
    group.add(handle);

    // Head (metallic gold)
    const headGeometry = new THREE.BoxGeometry(0.08, 0.05, 0.05);
    const headMaterial = new THREE.MeshLambertMaterial({
      color: 0xffd700,
      emissive: 0xffd700,
      emissiveIntensity: 0.5
    });
    const head = new THREE.Mesh(headGeometry, headMaterial);
    head.position.y = 0.05;
    group.add(head);

    // Strike indicator (glows red when active)
    const glowGeometry = new THREE.SphereGeometry(0.06, 16, 16);
    const glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff0000,
      transparent: true,
      opacity: 0
    });
    const glow = new THREE.Mesh(glowGeometry, glowMaterial);
    glow.position.y = 0.05;
    glow.userData['isStrikeGlow'] = true;
    group.add(glow);

    this.hammerMesh = group;
  }

  /**
   * Attach hammer to VR controller
   */
  attachToController(controller: THREE.XRTargetRaySpace) {
    this.controller = controller;
    if (this.hammerMesh) {
      controller.add(this.hammerMesh);
    }
  }

  /**
   * Detach hammer from controller
   */
  detach() {
    if (this.hammerMesh && this.controller) {
      this.controller.remove(this.hammerMesh);
    }
    this.controller = null;
  }

  /**
   * Register hit callback
   */
  onAccountHit(callback: (event: HammerHitEvent) => void) {
    this.onHit = callback;
  }

  /**
   * Check for account hits (call in animation loop)
   */
  update(connections: Array<{ line: THREE.Line, from: string, to: string }>) {
    if (!this.controller || !this.hammerMesh) return;

    const now = Date.now();
    if (now - this.lastHitTime < this.hitCooldown) return;

    // Get controller position and direction
    const controllerPos = new THREE.Vector3();
    controllerPos.setFromMatrixPosition(this.controller.matrixWorld);

    const controllerDir = new THREE.Vector3(0, 0, -1);
    controllerDir.applyQuaternion(this.controller.quaternion);

    this.raycaster.set(controllerPos, controllerDir);

    // Check intersection with connection lines
    const lines = connections.map(c => c.line);
    const intersects = this.raycaster.intersectObjects(lines);

    if (intersects.length > 0 && intersects[0]) {
      const hit = intersects[0];
      const hitLine = hit.object as THREE.Line;

      // Find which connection was hit
      const connection = connections.find(c => c.line === hitLine);
      if (connection) {
        this.triggerHit(connection.from, connection.to);
      }
    }
  }

  /**
   * Trigger account dispute
   */
  private triggerHit(fromEntityId: string, toEntityId: string) {
    this.lastHitTime = Date.now();

    // Flash hammer glow
    if (this.hammerMesh) {
      const glow = this.hammerMesh.children.find(c => c.userData['isStrikeGlow']);
      if (glow && glow instanceof THREE.Mesh) {
        const material = glow.material as THREE.MeshBasicMaterial;
        material.opacity = 1.0;
        setTimeout(() => { material.opacity = 0; }, 200);
      }
    }

    // Trigger haptic feedback (if available)
    if (this.controller && 'gamepad' in this.controller) {
      const gamepad = (this.controller as any).gamepad;
      if (gamepad?.hapticActuators?.[0]) {
        gamepad.hapticActuators[0].pulse(0.8, 100); // Strong pulse for 100ms
      }
    }

    // Fire hit event
    if (this.onHit) {
      this.onHit({
        type: 'account-dispute',
        fromEntityId,
        toEntityId,
        timestamp: Date.now()
      });
    }

    console.log(`⚖️ HAMMER HIT: Account ${fromEntityId} ↔ ${toEntityId}`);
  }

  /**
   * Cleanup
   */
  dispose() {
    this.detach();
    if (this.hammerMesh) {
      this.hammerMesh.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (child.material instanceof THREE.Material) {
            child.material.dispose();
          }
        }
      });
    }
  }
}
