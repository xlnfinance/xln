/**
 * Providence Pyramid - XLN's stepped pyramid primitive
 * N-sided base with M horizontal steps (matching logo)
 *
 * @license AGPL-3.0
 * Copyright (C) 2025 XLN Finance
 */

import * as THREE from 'three';

export interface ProvidencePyramidOptions {
  /** Number of sides for pyramid base (3=triangle, 4=square, 6=hexagon, etc.) */
  sides: number;
  /** Number of horizontal steps (matching logo lines) */
  steps: number;
  /** Base radius */
  radius: number;
  /** Total height */
  height: number;
  /** Material color */
  color: number;
  /** Wireframe color for step lines */
  wireframeColor: number;
  /** Show wireframe edges */
  showWireframe: boolean;
}

/**
 * Create a stepped pyramid with N sides and M horizontal steps
 *
 * @example
 * // XLN logo: 3-sided (triangle) with 3 steps
 * const pyramid = createProvidencePyramid({
 *   sides: 3,
 *   steps: 3,
 *   radius: 1,
 *   height: 2,
 *   color: 0x007acc,
 *   wireframeColor: 0xffffff,
 *   showWireframe: true
 * });
 */
export function createProvidencePyramid(options: Partial<ProvidencePyramidOptions> = {}): THREE.Group {
  const {
    sides = 3,           // Default: triangle (matching logo)
    steps = 3,           // Default: 3 horizontal lines (matching logo)
    radius = 1,
    height = 2,
    color = 0x007acc,
    wireframeColor = 0xffffff,
    showWireframe = true
  } = options;

  const group = new THREE.Group();

  // Create stepped pyramid geometry
  const stepHeight = height / steps;
  const stepRadiusDecrement = radius / steps;

  for (let step = 0; step < steps; step++) {
    const currentRadius = radius - (step * stepRadiusDecrement);
    const nextRadius = radius - ((step + 1) * stepRadiusDecrement);
    const yOffset = step * stepHeight;

    // Create truncated cone (frustum) for each step
    const geometry = new THREE.CylinderGeometry(
      nextRadius,      // Top radius
      currentRadius,   // Bottom radius
      stepHeight,      // Height
      sides,           // Radial segments (N-sided)
      1,               // Height segments
      false            // Open ended
    );

    // Position step
    geometry.translate(0, yOffset + stepHeight / 2, 0);

    // Solid material
    const material = new THREE.MeshStandardMaterial({
      color,
      metalness: 0.3,
      roughness: 0.7,
      flatShading: true
    });

    const mesh = new THREE.Mesh(geometry, material);
    group.add(mesh);

    // Add wireframe edges for step outlines
    if (showWireframe) {
      const edges = new THREE.EdgesGeometry(geometry);
      const lineMaterial = new THREE.LineBasicMaterial({ color: wireframeColor, linewidth: 1 });
      const wireframe = new THREE.LineSegments(edges, lineMaterial);
      group.add(wireframe);
    }
  }

  // Add apex point (tip of pyramid)
  const apexGeometry = new THREE.SphereGeometry(radius / 20, 8, 8);
  apexGeometry.translate(0, height, 0);
  const apexMaterial = new THREE.MeshStandardMaterial({ color: wireframeColor });
  const apex = new THREE.Mesh(apexGeometry, apexMaterial);
  group.add(apex);

  return group;
}

/**
 * Create XLN logo pyramid (3-sided, 3 steps)
 */
export function createXLNLogoPyramid(radius = 1, height = 2): THREE.Group {
  return createProvidencePyramid({
    sides: 3,
    steps: 3,
    radius,
    height,
    color: 0x007acc,
    wireframeColor: 0xffffff,
    showWireframe: true
  });
}

/**
 * Create hub entity pyramid (6-sided for distinction)
 */
export function createHubPyramid(radius = 0.5, height = 1): THREE.Group {
  return createProvidencePyramid({
    sides: 6,
    steps: 4,
    radius,
    height,
    color: 0x00ff00,
    wireframeColor: 0xffffff,
    showWireframe: true
  });
}
