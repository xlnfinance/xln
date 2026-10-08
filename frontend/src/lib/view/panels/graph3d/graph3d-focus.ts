/**
 * Cue focus dimming for graph objects.
 *
 * Dimming is reversible and owned here: the first time a material dims, its own opacity and
 * transparency are remembered; restoring puts exactly those back. Lit objects are never
 * touched, so per-frame animations (activity rings, pulses) keep full ownership of them.
 */

import type * as THREE from 'three';

export const FOCUS_DIM_FACTOR = 0.3;

/** How far a dimmed material's colour moves toward its own grey: out of focus, not invisible. */
export const FOCUS_DESATURATION = 0.75;

type FocusMaterial = THREE.Material & {
  userData: Record<string, unknown>;
  color?: THREE.Color;
  emissive?: THREE.Color;
};

const materialsOf = (object: THREE.Object3D): FocusMaterial[] => {
  const material = (object as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  if (!material) return [];
  return (Array.isArray(material) ? material : [material]) as FocusMaterial[];
};

/** Luminance-preserving grey of a colour, blended in by FOCUS_DESATURATION. */
const desaturate = (color: THREE.Color): void => {
  const grey = color.r * 0.299 + color.g * 0.587 + color.b * 0.114;
  color.setRGB(
    color.r + (grey - color.r) * FOCUS_DESATURATION,
    color.g + (grey - color.g) * FOCUS_DESATURATION,
    color.b + (grey - color.b) * FOCUS_DESATURATION,
  );
};

const dimMaterial = (material: FocusMaterial): void => {
  const state = material.userData;
  if (state['focusDimmed'] !== true) {
    state['focusDimmed'] = true;
    state['focusBaseOpacity'] = material.opacity;
    state['focusBaseTransparent'] = material.transparent;
    state['focusBaseDepthWrite'] = material.depthWrite;
    if (material.color) state['focusBaseColor'] = material.color.getHex();
    if (material.emissive) state['focusBaseEmissive'] = material.emissive.getHex();
    if (material.color) desaturate(material.color);
    if (material.emissive) material.emissive.multiplyScalar(0.4);
  }
  material.opacity = Number(state['focusBaseOpacity']) * FOCUS_DIM_FACTOR;
  material.depthWrite = false;
  if (!material.transparent) {
    material.transparent = true;
    material.needsUpdate = true;
  }
};

const restoreMaterial = (material: FocusMaterial): void => {
  const state = material.userData;
  if (state['focusDimmed'] !== true) return;
  state['focusDimmed'] = false;
  material.opacity = Number(state['focusBaseOpacity']);
  material.depthWrite = state['focusBaseDepthWrite'] === true;
  if (material.color && typeof state['focusBaseColor'] === 'number') material.color.setHex(state['focusBaseColor']);
  if (material.emissive && typeof state['focusBaseEmissive'] === 'number') material.emissive.setHex(state['focusBaseEmissive']);
  if (material.transparent !== (state['focusBaseTransparent'] === true)) {
    material.transparent = state['focusBaseTransparent'] === true;
    material.needsUpdate = true;
  }
};

/** Dims or restores every material under `object` (the object itself included). */
export function setGraphObjectDimmed(object: THREE.Object3D | null | undefined, dimmed: boolean): void {
  if (!object) return;
  object.traverse((child) => {
    if (child.userData['focusKeepsOpacity'] === true) return;
    for (const material of materialsOf(child)) {
      if (dimmed) dimMaterial(material);
      else restoreMaterial(material);
    }
  });
}
